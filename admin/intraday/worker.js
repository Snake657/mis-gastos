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
 *     ts = momento del registro (server-side ISO, UTC) — usado para el filtro de prioridad
 *     fa = fechaActualizacion que reportó la fuente
 *   TTL: 30 días.
 *
 * Cron: * * * * *  (cada minuto)  — pero la lógica `scheduled` corta temprano
 *   fuera del horario hábil ARG para no consumir cuota de KV inútilmente.
 *   Ventana activa: lun-vie 09:00–17:30 ARG (UTC-3, sin DST).
 *
 * Filtro de prioridad de fuente (read-time):
 *   Para `bolsa` (MEP) y `contadoconliqui` (CCL), se prioriza `criptoya` por ser la
 *   fuente con mayor granularidad (~1-3 min). Si pasan más de 8 min sin tick de
 *   criptoya, se aceptan ticks de las otras fuentes (ej. ámbito) hasta que criptoya
 *   se reestablezca, momento en el que el reloj se resetea.
 *   El KV guarda todos los ticks crudos — el filtro se aplica al servir.
 *
 * HTTP:
 *   GET /            → metadatos
 *   GET /today       → serie del día ARG actual (filtrada)
 *   GET /YYYY-MM-DD  → serie de ese día (filtrada)
 *   GET /raw/today        → serie cruda sin filtro (debug)
 *   GET /raw/YYYY-MM-DD   → serie cruda sin filtro (debug)
 *   CORS: Access-Control-Allow-Origin: *
 */

const CASAS = ['oficial', 'blue', 'bolsa', 'contadoconliqui', 'mayorista'];
const TTL_DIAS = 30;
const TTL_SECONDS = TTL_DIAS * 24 * 3600;

// Por casa, qué fuente tiene prioridad. Si hay tick de la fuente primaria reciente
// (gap ≤ FALLBACK_GAP_MIN), las demás se descartan en el filtro de salida.
// Casas no listadas acá no se filtran.
const FUENTE_PRIMARIA = {
  bolsa:           'criptoya',
  contadoconliqui: 'criptoya',
};
const FALLBACK_GAP_MIN = 8;
const FALLBACK_GAP_MS  = FALLBACK_GAP_MIN * 60 * 1000;

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
function _ahoraArg(now = new Date()) {
  const ms = now.getTime() - 3 * 3600 * 1000;
  const d = new Date(ms);
  return {
    dow: d.getUTCDay(),
    hh:  d.getUTCHours(),
    mm:  d.getUTCMinutes(),
  };
}

// True si estamos dentro de la ventana de captura: lun-vie 09:00–17:30 ARG.
// (No contempla feriados; en feriados corre y no escribe porque la fuente devuelve
// el mismo `fa` que el día hábil anterior y el guard de dedupe lo filtra.)
function _enHorarioCapturaArg() {
  const { dow, hh, mm } = _ahoraArg();
  if (dow === 0 || dow === 6) return false;
  const t = hh * 60 + mm;
  return t >= 9 * 60 && t <= 17 * 60 + 30;
}

// Aplica el filtro de prioridad de fuente para una casa.
// Recibe el array crudo de ticks (insertados en orden de ts ascendente) y devuelve
// un array filtrado con la regla "primaria gana, fallback sólo si hay >8 min sin
// tick primario o si todavía no llegó ningún tick primario".
function _filtrarPorPrioridad(casa, ticks) {
  const primaria = FUENTE_PRIMARIA[casa];
  if (!primaria || !Array.isArray(ticks) || ticks.length === 0) return ticks || [];
  // Asegurar orden por ts ASC (debería estarlo, pero no cuesta nada).
  const ordenados = [...ticks].sort(
    (a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime()
  );
  const out = [];
  let ultimaPrimariaTs = null;
  for (const t of ordenados) {
    const ts = new Date(t.ts).getTime();
    if (t._source === primaria) {
      out.push(t);
      ultimaPrimariaTs = ts;
    } else if (ultimaPrimariaTs == null || (ts - ultimaPrimariaTs) > FALLBACK_GAP_MS) {
      out.push(t);
    }
    // else: descartado (la primaria está activa hace ≤8 min)
  }
  return out;
}

function aplicarFiltrosATodas(stored) {
  const out = {};
  for (const casa of Object.keys(stored || {})) {
    out[casa] = _filtrarPorPrioridad(casa, stored[casa]);
  }
  return out;
}

async function fetchSnapshot(env) {
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
        version: '1.3',
        endpoints: ['/today', '/{YYYY-MM-DD}', '/raw/today', '/raw/{YYYY-MM-DD}'],
        filter: {
          casas: Object.keys(FUENTE_PRIMARIA),
          fuentePrimaria: FUENTE_PRIMARIA,
          fallbackGapMin: FALLBACK_GAP_MIN,
        },
        docs: 'https://canuto.ar',
      });
    }

    // /raw/* devuelve la data sin filtrar (para debug / análisis manual).
    let raw = false;
    let pathSinRaw = path;
    if (path.startsWith('/raw/')) {
      raw = true;
      pathSinRaw = path.slice(4); // queda "/today" o "/YYYY-MM-DD"
    }

    let ymd;
    if (pathSinRaw === '/today') {
      ymd = ymdArg();
    } else {
      const m = pathSinRaw.match(/^\/(\d{4}-\d{2}-\d{2})$/);
      if (!m) {
        return jsonResponse({ error: 'Invalid path. Use /today or /YYYY-MM-DD' }, 400);
      }
      ymd = m[1];
    }

    const key = `intraday:${ymd}`;
    const stored = (await env.INTRADAY.get(key, 'json')) || {};
    const cotizaciones = raw ? stored : aplicarFiltrosATodas(stored);

    return jsonResponse({
      ymd,
      cotizaciones,
      ...(raw ? { raw: true } : {}),
    });
  },
};
