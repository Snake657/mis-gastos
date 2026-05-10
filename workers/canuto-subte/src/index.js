/**
 * canuto-subte Worker
 * --------------------
 * Polea cada 5 minutos la API GTFS-RT de GCBA (subtes/serviceAlerts) y reconstruye
 * incidentes (inicio + fin) viendo qué alertas aparecen y desaparecen.
 *
 * KV namespaces:
 *   ACTIVAS     -> alertas vivas, una clave por alert_id (Alert_LineaA)
 *   HISTORICOS  -> incidentes ya cerrados, append-only.
 *                  - lista índice en clave "_index" (array de ids ordenado por fecha)
 *                  - cada incidente en clave "inc_<id>"
 *
 * Endpoints:
 *   GET /data.json   -> { generated_at, activas:[...], cerrados:[...] }  (CORS abierto)
 *   GET /status      -> diagnóstico (no requiere auth, solo devuelve metadata)
 *
 * Cron: every 5 min (config en wrangler.toml).
 */

const API_BASE = 'https://apitransporte.buenosaires.gob.ar/subtes/serviceAlerts';
const RE_WINDOW_MS = 30 * 60 * 1000;          // 30 min: si la misma alerta vuelve antes, es la misma
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;   // 4 hs: cap de duración por incidente
const HISTORICOS_LIMIT = 5000;                // límite de incidentes históricos guardados

// Mapeo de códigos GTFS-RT (https://gtfs.org/realtime/reference/#enum-cause)
const CAUSE_CODES = {
  1: 'UNKNOWN_CAUSE',
  2: 'OTHER_CAUSE',
  3: 'TECHNICAL_PROBLEM',
  4: 'STRIKE',
  5: 'DEMONSTRATION',
  6: 'ACCIDENT',
  7: 'HOLIDAY',
  8: 'WEATHER',
  9: 'MAINTENANCE',
  10: 'CONSTRUCTION',
  11: 'POLICE_ACTIVITY',
  12: 'MEDICAL_EMERGENCY',
};
const EFFECT_CODES = {
  1: 'NO_SERVICE',
  2: 'REDUCED_SERVICE',
  3: 'SIGNIFICANT_DELAYS',
  4: 'DETOUR',
  5: 'ADDITIONAL_SERVICE',
  6: 'MODIFIED_SERVICE',
  7: 'OTHER_EFFECT',
  8: 'UNKNOWN_EFFECT',
  9: 'STOP_MOVED',
  10: 'NO_EFFECT',
  11: 'ACCESSIBILITY_ISSUE',
};

// ---------- entrypoints ----------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAndDiff(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    if (url.pathname === '/data.json') {
      return cors(await handleData(env));
    }
    if (url.pathname === '/status') {
      return cors(await handleStatus(env));
    }
    if (url.pathname === '/poll' && request.method === 'POST') {
      // permite forzar un ciclo manualmente (útil pa testing)
      const auth = request.headers.get('x-admin-key');
      if (!auth || auth !== env.ADMIN_KEY) return cors(new Response('Forbidden', { status: 403 }));
      const result = await pollAndDiff(env);
      return cors(new Response(JSON.stringify(result, null, 2), { headers: { 'Content-Type': 'application/json' } }));
    }

    return cors(new Response('canuto-subte worker. Endpoints: /data.json, /status', { status: 404 }));
  },
};

// ---------- core: poll + diff ----------

async function pollAndDiff(env) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // 1) Bajar alertas vivas de GCBA
  let snapshot;
  try {
    snapshot = await fetchSnapshot(env);
  } catch (err) {
    console.error('fetchSnapshot fail:', err.message);
    return { ok: false, error: err.message, at: nowIso };
  }
  const liveIds = new Set(snapshot.alerts.map(a => a.id));

  // 2) Cargar lo que ya teníamos como activo
  const prevList = await env.ACTIVAS.list();
  const prevActivas = {};
  for (const k of prevList.keys) {
    const raw = await env.ACTIVAS.get(k.name);
    if (raw) prevActivas[k.name] = JSON.parse(raw);
  }

  let nuevos = 0, cerrados = 0, vistos = 0, writes = 0;
  // Para minimizar writes a KV (límite plan free: 1k/día), solo refrescamos
  // last_seen cada LAST_SEEN_REFRESH_MS si nada más cambió.
  const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000; // 5 min

  // 3) Procesar alertas vivas
  for (const a of snapshot.alerts) {
    vistos++;
    const prev = prevActivas[a.id];
    if (prev) {
      // ya estaba viva: detectar si hubo cambios reales
      const textChanged = !!(a.text && a.text !== prev.text);
      const causeChanged = a.cause && a.cause !== prev.cause;
      const effectChanged = a.effect && a.effect !== prev.effect;
      const lastSeenStale = (now - (prev.last_seen_ms || 0)) >= LAST_SEEN_REFRESH_MS;
      const needsWrite = textChanged || causeChanged || effectChanged || lastSeenStale;

      if (needsWrite) {
        prev.last_seen = nowIso;
        prev.last_seen_ms = now;
        if (textChanged) {
          prev.text_history = prev.text_history || [];
          prev.text_history.push({ at: nowIso, text: a.text });
          prev.text = a.text;
        }
        if (causeChanged) prev.cause = a.cause;
        if (effectChanged) prev.effect = a.effect;
        await env.ACTIVAS.put(a.id, JSON.stringify(prev));
        writes++;
      }
    } else {
      // chequeo re-window: ¿hay un cerrado reciente con el mismo id?
      const reopened = await tryReopen(env, a.id, now);
      if (reopened) {
        // re-abrimos: lo movemos de HISTORICOS a ACTIVAS extendiéndole vida
        reopened.last_seen = nowIso;
        reopened.last_seen_ms = now;
        reopened.reopened_at = nowIso;
        await env.ACTIVAS.put(a.id, JSON.stringify(reopened));
      } else {
        // alerta nueva
        const incidente = {
          id: a.id,
          first_seen: nowIso,
          first_seen_ms: now,
          last_seen: nowIso,
          last_seen_ms: now,
          linea: a.linea,
          tipo: a.tipo,
          cause: a.cause,
          cause_label: a.cause_label,
          effect: a.effect,
          effect_label: a.effect_label,
          text: a.text,
          header: a.header,
          route_ids: a.route_ids,
        };
        await env.ACTIVAS.put(a.id, JSON.stringify(incidente));
        writes++;
        nuevos++;
      }
    }
  }

  // 4) Procesar alertas que ya no están -> cerrar
  for (const id in prevActivas) {
    if (!liveIds.has(id)) {
      const inc = prevActivas[id];
      // duración: desde first_seen hasta last_seen (con cap)
      const startMs = inc.first_seen_ms || new Date(inc.first_seen).getTime();
      const endMs = inc.last_seen_ms || new Date(inc.last_seen).getTime();
      let durMs = endMs - startMs;
      if (durMs > MAX_DURATION_MS) durMs = MAX_DURATION_MS;
      if (durMs < 0) durMs = 0;
      inc.cerrado_at = nowIso;
      inc.cerrado_at_ms = now;
      inc.duration_ms = durMs;
      inc.duration_min = Math.round(durMs / 60000);
      await archiveIncident(env, inc);
      await env.ACTIVAS.delete(id);
      cerrados++;
      writes += 2;  // archive + delete
    }
  }

  // 5) Guardar metadata de la última corrida
  // Solo escribir _meta cuando hubo cambios o cada META_REFRESH_MS para no inflar writes.
  const META_REFRESH_MS = 10 * 60 * 1000; // 10 min
  const hadChanges = nuevos > 0 || cerrados > 0 || writes > 0;
  let prevMetaMs = 0;
  try {
    const prevMetaRaw = prevActivas['_meta'];
    if (prevMetaRaw) prevMetaMs = prevMetaRaw.last_run_ms || 0;
  } catch (_) {}
  const metaStale = (now - prevMetaMs) >= META_REFRESH_MS;
  if (hadChanges || metaStale) {
    await env.ACTIVAS.put('_meta', JSON.stringify({
      last_run: nowIso,
      last_run_ms: now,
      alerts_vivas: vistos,
      nuevos_en_ciclo: nuevos,
      cerrados_en_ciclo: cerrados,
      api_header_ts: snapshot.header_ts,
      writes_en_ciclo: writes,
    }));
    writes++;
  }

  return { ok: true, at: nowIso, vistos, nuevos, cerrados, writes };
}

// Intentar re-abrir: si se cerró hace menos de RE_WINDOW_MS, lo recuperamos
async function tryReopen(env, id, nowMs) {
  const idxRaw = await env.HISTORICOS.get('_index');
  if (!idxRaw) return null;
  const idx = JSON.parse(idxRaw);
  // index es array de {id, key, cerrado_at_ms} ordenado desc
  const candidato = idx.find(e => e.id === id && (nowMs - e.cerrado_at_ms) < RE_WINDOW_MS);
  if (!candidato) return null;
  const raw = await env.HISTORICOS.get(candidato.key);
  if (!raw) return null;
  // sacar del index y borrar la entrada histórica
  const newIdx = idx.filter(e => e.key !== candidato.key);
  await env.HISTORICOS.put('_index', JSON.stringify(newIdx));
  await env.HISTORICOS.delete(candidato.key);
  return JSON.parse(raw);
}

// Archivar incidente cerrado en HISTORICOS + actualizar índice
async function archiveIncident(env, inc) {
  const key = `inc_${inc.first_seen_ms}_${inc.id}`;
  await env.HISTORICOS.put(key, JSON.stringify(inc));
  const idxRaw = await env.HISTORICOS.get('_index');
  let idx = idxRaw ? JSON.parse(idxRaw) : [];
  idx.unshift({
    id: inc.id,
    key,
    first_seen_ms: inc.first_seen_ms,
    cerrado_at_ms: inc.cerrado_at_ms,
    linea: inc.linea,
    tipo: inc.tipo,
    duration_min: inc.duration_min,
  });
  // truncar
  if (idx.length > HISTORICOS_LIMIT) {
    const obsoletas = idx.slice(HISTORICOS_LIMIT);
    idx = idx.slice(0, HISTORICOS_LIMIT);
    // borrar las claves viejas
    for (const e of obsoletas) {
      await env.HISTORICOS.delete(e.key);
    }
  }
  await env.HISTORICOS.put('_index', JSON.stringify(idx));
}

// ---------- API GCBA ----------

async function fetchSnapshot(env) {
  const u = new URL(API_BASE);
  u.searchParams.set('json', '1');
  u.searchParams.set('client_id', env.GCBA_CLIENT_ID);
  u.searchParams.set('client_secret', env.GCBA_CLIENT_SECRET);

  const resp = await fetch(u.toString(), {
    headers: { 'Accept': 'application/json' },
    cf: { cacheTtl: 0, cacheEverything: false },
  });
  if (!resp.ok) throw new Error(`GCBA API ${resp.status}: ${await resp.text().catch(() => '')}`);
  const data = await resp.json();

  const headerTs = data.header && data.header.timestamp;
  const entities = Array.isArray(data.entity) ? data.entity : [];

  const alerts = [];
  for (const ent of entities) {
    const al = ent.alert;
    if (!al) continue;
    const text = pickTranslation(al.description_text);
    const header = pickTranslation(al.header_text);
    const routeIds = (al.informed_entity || []).map(ie => ie.route_id).filter(Boolean);
    const linea = detectLinea(routeIds, header, text);
    const tipo = detectTipo(text + ' ' + header, al.effect);
    alerts.push({
      id: ent.id,
      linea,
      tipo,
      cause: al.cause,
      cause_label: CAUSE_CODES[al.cause] || null,
      effect: al.effect,
      effect_label: EFFECT_CODES[al.effect] || null,
      text,
      header,
      route_ids: routeIds,
    });
  }
  return { header_ts: headerTs, alerts };
}

function pickTranslation(field) {
  if (!field || !Array.isArray(field.translation)) return '';
  // preferimos español; si no, lo primero
  const es = field.translation.find(t => (t.language || '').toLowerCase().startsWith('es'));
  return (es || field.translation[0] || {}).text || '';
}

function detectLinea(routeIds, header, text) {
  // 1) por route_id (formato típico: "LineaA", "LineaB", "Premetro")
  for (const r of routeIds) {
    const m = /linea\s*([abcdeh])/i.exec(r);
    if (m) return m[1].toUpperCase();
    if (/premetro/i.test(r)) return 'P';
  }
  // 2) por texto
  const blob = (header + ' ' + text).toLowerCase();
  const m = /l[ií]nea\s+([abcdeh])\b/.exec(blob);
  if (m) return m[1].toUpperCase();
  if (/premetro/.test(blob)) return 'P';
  return null;
}

function detectTipo(blob, effect) {
  const t = (blob || '').toLowerCase();
  // primero por texto (más fino)
  if (/(servicio\s+interrumpido|sin\s+servicio|no\s+circula|servicio\s+suspendido)/.test(t)) return 'inicio_interrumpido';
  if (/(medida\s+de\s+fuerza|paro\s+gremial|paro\s+de)/.test(t)) return 'inicio_interrumpido';
  if (/no\s+se\s+detienen?\s+en/.test(t)) return 'inicio_estacion_cerrada';
  if (/estaci[oó]n\s+\w+\s+cerrada/.test(t)) return 'inicio_estacion_cerrada';
  if (/servicio\s+limitado/.test(t)) return 'inicio_limitado';
  if (/(servicio\s+(con\s+)?demora|circula\s+con\s+demora|con\s+demoras?)/.test(t)) return 'inicio_demora';
  if (/(horario\s+extendido|obras|trabajos|ampliaci[oó]n)/.test(t)) return 'info_operativa';
  // fallback por effect GTFS
  if (effect === 1) return 'inicio_interrumpido';     // NO_SERVICE
  if (effect === 2) return 'inicio_limitado';          // REDUCED_SERVICE
  if (effect === 3) return 'inicio_demora';            // SIGNIFICANT_DELAYS
  if (effect === 4) return 'inicio_limitado';          // DETOUR
  if (effect === 6) return 'info_operativa';           // MODIFIED_SERVICE
  return 'otro';
}

// ---------- handlers HTTP ----------

async function handleData(env) {
  // activas
  const list = await env.ACTIVAS.list();
  const activas = [];
  for (const k of list.keys) {
    if (k.name === '_meta') continue;
    const raw = await env.ACTIVAS.get(k.name);
    if (raw) activas.push(JSON.parse(raw));
  }

  // cerrados (los últimos N)
  const idxRaw = await env.HISTORICOS.get('_index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  const cerrados = [];
  // devolvemos los últimos 1000 para no saturar el front
  const slice = idx.slice(0, 1000);
  for (const e of slice) {
    const raw = await env.HISTORICOS.get(e.key);
    if (raw) cerrados.push(JSON.parse(raw));
  }

  // metadata
  const metaRaw = await env.ACTIVAS.get('_meta');
  const meta = metaRaw ? JSON.parse(metaRaw) : null;

  const body = JSON.stringify({
    generated_at: new Date().toISOString(),
    last_poll: meta,
    activas,
    cerrados,
    total_historicos: idx.length,
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  });
}

async function handleStatus(env) {
  const metaRaw = await env.ACTIVAS.get('_meta');
  const meta = metaRaw ? JSON.parse(metaRaw) : null;
  const list = await env.ACTIVAS.list();
  const idxRaw = await env.HISTORICOS.get('_index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];

  const body = JSON.stringify({
    worker: 'canuto-subte',
    now: new Date().toISOString(),
    activas_count: list.keys.filter(k => k.name !== '_meta').length,
    historicos_count: idx.length,
    last_poll: meta,
  }, null, 2);

  return new Response(body, {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ---------- CORS ----------

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  return new Response(resp.body, { status: resp.status, headers: h });
}
