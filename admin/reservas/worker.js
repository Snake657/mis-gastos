// Cloudflare Worker: canuto-reservas
// ──────────────────────────────────────────────────────────────────────
// Guarda y devuelve los datos preliminares de Reservas Internacionales BCRA
// que el admin carga manualmente desde la imagen que tuitea @BancoCentral_AR.
//
// Endpoints:
//   GET    /          → devuelve un array { fecha:'YYYY-MM-DD', valor:Number, ts:'ISO' }[]
//                       ordenado de más viejo a más nuevo. CORS abierto.
//
//   POST   /          → agrega o sobrescribe un dato. Body JSON:
//                         { fecha:'YYYY-MM-DD', valor:Number, clave:'plata' }
//                       Devuelve la lista actualizada.
//
//   DELETE /          → borra un dato. Body JSON:
//                         { fecha:'YYYY-MM-DD', clave:'plata' }
//                       Devuelve la lista actualizada.
//
// Bindings que requiere (configurados en el dashboard):
//   - KV namespace bindeado como `RESERVAS` (variable env.RESERVAS)
//   - Variable de entorno `CLAVE` con el secreto: "plata"
//
// La data se guarda toda en una sola key del KV (`lista`) como JSON.
// Es suficiente para cientos de fechas — el KV de CF soporta valores
// de hasta 25 MB por entrada.

const KV_KEY = 'lista';

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const json = (data, status = 200) => new Response(JSON.stringify(data), {
      status,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });

    try {
      const list = await loadList(env);

      if (request.method === 'GET') {
        return json(list);
      }

      if (request.method === 'POST' || request.method === 'DELETE') {
        const body = await request.json().catch(() => ({}));
        if (body.clave !== env.CLAVE) {
          return json({ error: 'palabra clave incorrecta' }, 401);
        }
        const fecha = (body.fecha || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
          return json({ error: 'fecha inválida (formato YYYY-MM-DD)' }, 400);
        }

        let next = list.filter(x => x.fecha !== fecha);

        if (request.method === 'POST') {
          const valor = Number(body.valor);
          if (!Number.isFinite(valor) || valor <= 0) {
            return json({ error: 'valor inválido' }, 400);
          }
          next.push({ fecha, valor, ts: new Date().toISOString() });
        }
        // ordenar ascendente por fecha
        next.sort((a, b) => a.fecha < b.fecha ? -1 : 1);
        await env.RESERVAS.put(KV_KEY, JSON.stringify(next));
        return json(next);
      }

      return json({ error: 'método no permitido' }, 405);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },
};

async function loadList(env) {
  const raw = await env.RESERVAS.get(KV_KEY);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}
