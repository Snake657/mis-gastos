/**
 * canuto-intraday — Cloudflare Worker
 *
 * Acumula la cotización intra-día del dólar (oficial / blue / MEP / CCL / mayorista)
 * para que /dolar-historico pueda dibujar un mini-gráfico del día sin depender de
 * que la pestaña del usuario haya estado abierta todo el día.
 *
 * Fuente: Worker `canuto-dolar` (mismo agregador que el cliente, así no hay saltos
 * entre fuentes). La llamada se hace via Service Binding `DOLAR` — un Worker de la
 * misma cuenta NO puede invocar a otro vía URL pública (Cloudflare devuelve 404),
 * por eso usamos el binding, que llama directo en el plano interno.
 *
 * Bindings:
 *   INTRADAY → KV namespace canuto-intraday-kv
 *   DOLAR    → Service Binding al Worker canuto-dolar
 *
 * KV:
 *   Una sola clave por día → intraday:{YYYY-MM-DD}
 *   Valor: { oficial:[ticks], blue:[ticks], bolsa:[ticks], contadoconliqui:[ticks], mayorista:[ticks] }
 *   Tick: { ts, fa, compra, venta, _source }
 *     ts = momento del registro (server-side ISO, UTC)
 *     fa = fechaActualizacion que reportó la fuente
 *   TTL: 30 días.
 *
 * Cron: * * * * *  (cada minuto)  — pero la lógica `scheduled` corta temprano
 *   fuera del horario hábil ARG para no consumir cuota de KV inútilmente.
 *   Ventana activa: lun-vie 09:00–17:30 ARG (UTC-3, sin DST).
 *   Esto reduce las invocaciones efectivas de 1440/día a ~450/día y baja
 *   los writes a KV de ~600/día a ~400/día (free tier permite 1000/día).
 *
 * HTTP:
 *   GET /            → metadatos
 *   GET /today       → serie del día ARG actual
 *   GET /YYYY-MM-DD  → serie de ese día
 *   CORS: Access-Control-Allow-Origin: *
 */

const CASAS = ['oficial', 'blue', 'bolsa', 'contadoconliqui', 'mayorista'];
const TTL_DIAS = 30;
const TTL_SECONDS = TTL_DIAS * 24 * 3600;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

function ymdArg(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'America/Argentina/Buenos_Aires',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(date);
}

// Hora ARG (UTC-3, sin DST en Argentina). Devuelve { dow, hh, mm }.
//   dow: 0=domingo, 1=lunes, ..., 6=sábado
//   hh:  0..23
//   mm:  0..59
function _ahoraArg(now = new Date()) {
  // ARG = UTC - 3h. Restamos al ms y leemos los componentes vía getUTC*.
  const ms = now.getTime() - 3 * 3600 * 1000;
  const d = new Date(ms);
  return {
    dow: d.getUTCDay(),
    hh:  d.getUTCHours(),
    mm:  d.getUTCMinutes(),
  };
}

// True si estamos dentro de la ventana de captura de ticks: lun-vie 09:00–17:30 ARG.
// Nota: NO contempla feriados — en feriados el cron va a correr y la fuente
// (canuto-dolar) probablemente devuelva el último tick del día hábil anterior, lo
// que igual filtra el "if (last && last.fa === cot.fechaActualizacion) continue"
// porque ese fa no cambia. O sea, en feriados el costo es ~5 reads/min sin
// writes — tolerable. Si más adelante queremos agregar la guarda de feriados,
// se puede consultar argentinadatos.com/v1/feriados/{year} con cache.
function _enHorarioCapturaArg() {
  const { dow, hh, mm } = _ahoraArg();
  if (dow === 0 || dow === 6) return false;     // sáb/dom
  const t = hh * 60 + mm;
  const ini = 9 * 60;          // 09:00
  const fin = 17 * 60 + 30;    // 17:30
  return t >= ini && t <= fin;
}

async function fetchSnapshot(env) {
  // Llamada interna al Worker canuto-dolar via Service Binding.
  // El host es ignorado por Cloudflare; sólo importa el path.
  const req = new Request('https://canuto-dolar.internal/api/dolar');
  const res = await env.DOLAR.fetch(req);
  if (!res.ok) throw new Error('canuto-dolar HTTP ' + res.status);
  return res.json();
}

async function recordTick(env) {
  let snap;
  try { snap = await fetchSnapshot(env); }
  catch (e) { console.error('fetchSnapshot failed:', e.message); return; }

  if (!snap || !Array.isArray(snap.cotizaciones)) return;

  const ymd = ymdArg();
  const key = `intraday:${ymd}`;
  const stored = (await env.INTRADAY.get(key, 'json')) || {};
  let changed = false;

  for (const cot of snap.cotizaciones) {
    if (!CASAS.includes(cot.casa)) continue;
    if (cot.venta == null) continue;

    const series = stored[cot.casa] || [];
    const last = series[series.length - 1];
    if (last && last.fa === cot.fechaActualizacion) continue;

    series.push({
      ts: new Date().toISOString(),
      fa: cot.fechaActualizacion,
      compra: cot.compra,
      venta: cot.venta,
      _source: cot._source || null,
    });
    stored[cot.casa] = series;
    changed = true;
  }

  if (changed) {
    await env.INTRADAY.put(key, JSON.stringify(stored), { expirationTtl: TTL_SECONDS });
  }
}

export default {
  async scheduled(event, env, ctx) {
    // Cortocircuito fuera del horario hábil ARG — no hace ni un solo KV op
    // si estamos en sábado/domingo o fuera de 09:00–17:30 ARG.
    if (!_enHorarioCapturaArg()) return;
    ctx.waitUntil(recordTick(env));
  },

  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405);
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/') {
      return jsonResponse({
        service: 'canuto-intraday',
        version: '1.2',
        endpoints: ['/today', '/{YYYY-MM-DD}'],
        docs: 'https://canuto.ar',
      });
    }

    let ymd;
    if (path === '/today') {
      ymd = ymdArg();
    } else {
      const m = path.match(/^\/(\d{4}-\d{2}-\d{2})$/);
      if (!m) {
        return jsonResponse({ error: 'Invalid path. Use /today or /YYYY-MM-DD' }, 400);
      }
      ymd = m[1];
    }

    const key = `intraday:${ymd}`;
    const stored = (await env.INTRADAY.get(key, 'json')) || {};

    return jsonResponse({
      ymd,
      cotizaciones: stored,
    });
  },
};
