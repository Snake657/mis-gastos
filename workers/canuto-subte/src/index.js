/**
 * canuto-subte Worker (v3) — GCBA + nitter Twitter
 * --------------------------------------------------
 * Fuentes:
 *   1) GCBA serviceAlerts (GTFS-RT)        -> ACTIVAS / HISTORICOS
 *   2) nitter.net/Emova_arg/rss            -> TWEETS (raw) + TW_INCIDENTES (pareados)
 *   3) nitter.net/basubte/rss              -> idem
 *
 * KV:
 *   ACTIVAS         -> alertas vivas GCBA, key = alert_id
 *   HISTORICOS      -> incidentes cerrados GCBA
 *   TWEETS          -> tweets raw deduplicados, key = "tw_<tweet_id>"
 *                       value = {user, fecha_iso, fecha_ms, text, tipo, linea, tweet_id}
 *                       TTL: 60 días
 *   TW_INCIDENTES   -> incidentes inferidos de tweets (inicio + fin pareados)
 *                       _index = lista [{id, key, linea, tipo, fecha_inicio_ms, fecha_fin_ms?}]
 *                       inc_<linea>_<tipo>_<inicio_ms> = {linea, tipo, inicio_iso, fin_iso?, duracion_min?, tweets:[ids]}
 *                       Mientras no tenga fin, está "abierto" (= alerta viva).
 *
 * Endpoints:
 *   GET /data.json   -> {activas_gcba, activas_tweets, cerrados, last_polls}
 *   GET /status      -> diagnóstico
 *   POST /poll       -> forzar ciclo (requiere x-admin-key)
 *
 * Cron: 1 min. Optimizado para minimizar writes.
 */

// ============================================================
//  Constantes
// ============================================================

const API_BASE = 'https://apitransporte.buenosaires.gob.ar/subtes/serviceAlerts';
const NITTER_HOSTS = [
  'https://nitter.privacyredirect.com',
  'https://nitter.net',
  'https://lightbrd.com',
];
const TW_USERS = ['Emova_arg', 'basubte'];
const QUEJAS_QUERIES = ['@Emova_arg', '@basubte'];  // search queries para detectar quejas ciudadanas (cualquier mención a las cuentas oficiales)
const QUEJAS_EXCLUDE_USERS = new Set(['emova_arg', 'basubte']);  // tweets propios de las cuentas oficiales (los polleamos por separado)
const QUEJAS_WINDOW_MS = 10 * 60 * 1000;   // ventana de 10 min para clusters
const QUEJAS_THRESHOLD = 2;                 // mínimo de señales para disparar alerta (quejas tienen filtro fino, threshold bajo OK)
const QUEJAS_TTL_S = 7 * 24 * 3600;         // dejar tweets ciudadanos en KV 7 días
// Detector de VOLUMEN (sin filtros de keywords): si hay usuarios distintos
// arrobando a las cuentas oficiales en una ventana corta, marcar como posible incidencia.
// Es solo un indicador en el banner, NO entra al calendario.
const VOLUMEN_THRESHOLD_USERS = 3;          // ≥3 usuarios DISTINTOS para disparar
const VOLUMEN_WINDOW_MS = 10 * 60 * 1000;   // ventana de 10 min (más laxo que las quejas precisas: no filtra keywords)
const VOLUMEN_TTL_S = 7 * 24 * 3600;        // tweets de volumen en KV 7 días
const ULTIMOS_TWEETS_N = 5;                 // cuántos tweets ciudadanos crudos mostrar al final del banner

const RE_WINDOW_MS = 30 * 60 * 1000;
const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
const HISTORICOS_LIMIT = 5000;
const LAST_SEEN_REFRESH_MS = 5 * 60 * 1000;
const META_REFRESH_MS = 10 * 60 * 1000;
const TWEET_TTL_S = 60 * 24 * 60 * 60;          // 60 días
const TW_INC_LIMIT = 5000;                       // máximo de incidentes-de-tweets guardados

const CAUSE_CODES = {
  1: 'UNKNOWN_CAUSE', 2: 'OTHER_CAUSE', 3: 'TECHNICAL_PROBLEM', 4: 'STRIKE',
  5: 'DEMONSTRATION', 6: 'ACCIDENT', 7: 'HOLIDAY', 8: 'WEATHER',
  9: 'MAINTENANCE', 10: 'CONSTRUCTION', 11: 'POLICE_ACTIVITY', 12: 'MEDICAL_EMERGENCY',
};
const EFFECT_CODES = {
  1: 'NO_SERVICE', 2: 'REDUCED_SERVICE', 3: 'SIGNIFICANT_DELAYS', 4: 'DETOUR',
  5: 'ADDITIONAL_SERVICE', 6: 'MODIFIED_SERVICE', 7: 'OTHER_EFFECT', 8: 'UNKNOWN_EFFECT',
  9: 'STOP_MOVED', 10: 'NO_EFFECT', 11: 'ACCESSIBILITY_ISSUE',
};

// ============================================================
//  Entrypoints
// ============================================================

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([pollGCBA(env), pollTweets(env), pollQuejas(env)]));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));
    if (url.pathname === '/data.json') return cors(await handleData(env));
    if (url.pathname === '/status') return cors(await handleStatus(env));
    if (url.pathname === '/diag-nitter') {
      const user = url.searchParams.get('user') || 'Emova_arg';
      return cors(new Response(JSON.stringify(await diagnoseNitter(user), null, 2), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.pathname === '/diag-gtfsrt') {
      return cors(new Response(JSON.stringify(await diagnoseGtfsRt(env), null, 2), { headers: { 'Content-Type': 'application/json' } }));
    }
    if (url.pathname === '/poll' && request.method === 'POST') {
      const auth = request.headers.get('x-admin-key');
      if (!auth || auth !== env.ADMIN_KEY) return cors(new Response('Forbidden', { status: 403 }));
      const which = url.searchParams.get('which') || 'all';
      const out = {};
      if (which === 'all' || which === 'gcba') out.gcba = await pollGCBA(env);
      if (which === 'all' || which === 'tweets') out.tweets = await pollTweets(env);
      if (which === 'all' || which === 'quejas') out.quejas = await pollQuejas(env);
      return cors(new Response(JSON.stringify(out, null, 2), { headers: { 'Content-Type': 'application/json' } }));
    }
    return cors(new Response('canuto-subte v3. Endpoints: /data.json, /status', { status: 404 }));
  },
};

// ============================================================
//  GCBA: poll + diff (igual que v2, sin cambios)
// ============================================================

async function pollGCBA(env) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  let snapshot;
  try { snapshot = await fetchGCBASnapshot(env); }
  catch (err) { console.error('GCBA fail:', err.message); return { ok: false, error: err.message, at: nowIso }; }

  const liveIds = new Set(snapshot.alerts.map(a => a.id));
  const prevList = await env.ACTIVAS.list();
  const prevActivas = {};
  for (const k of prevList.keys) {
    const raw = await env.ACTIVAS.get(k.name);
    if (raw) prevActivas[k.name] = JSON.parse(raw);
  }

  let nuevos = 0, cerrados = 0, vistos = 0, writes = 0;

  for (const a of snapshot.alerts) {
    vistos++;
    const prev = prevActivas[a.id];
    if (prev) {
      const textChanged = !!(a.text && a.text !== prev.text);
      const causeChanged = a.cause && a.cause !== prev.cause;
      const effectChanged = a.effect && a.effect !== prev.effect;
      const lastSeenStale = (now - (prev.last_seen_ms || 0)) >= LAST_SEEN_REFRESH_MS;
      if (textChanged || causeChanged || effectChanged || lastSeenStale) {
        prev.last_seen = nowIso; prev.last_seen_ms = now;
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
      const incidente = {
        id: a.id, first_seen: nowIso, first_seen_ms: now,
        last_seen: nowIso, last_seen_ms: now,
        linea: a.linea, tipo: a.tipo,
        cause: a.cause, cause_label: a.cause_label,
        effect: a.effect, effect_label: a.effect_label,
        text: a.text, header: a.header, route_ids: a.route_ids,
      };
      await env.ACTIVAS.put(a.id, JSON.stringify(incidente));
      writes++; nuevos++;
    }
  }

  for (const id in prevActivas) {
    if (id === '_meta') continue;
    if (!liveIds.has(id)) {
      const inc = prevActivas[id];
      const startMs = inc.first_seen_ms || new Date(inc.first_seen).getTime();
      const endMs = inc.last_seen_ms || new Date(inc.last_seen).getTime();
      let durMs = endMs - startMs;
      if (durMs > MAX_DURATION_MS) durMs = MAX_DURATION_MS;
      if (durMs < 0) durMs = 0;
      inc.cerrado_at = nowIso; inc.cerrado_at_ms = now;
      inc.duration_ms = durMs; inc.duration_min = Math.round(durMs / 60000);
      await archiveIncident(env, inc);
      await env.ACTIVAS.delete(id);
      cerrados++; writes += 2;
    }
  }

  const hadChanges = nuevos > 0 || cerrados > 0 || writes > 0;
  const prevMeta = prevActivas['_meta'];
  const prevMetaMs = (prevMeta && prevMeta.last_run_ms) || 0;
  const metaStale = (now - prevMetaMs) >= META_REFRESH_MS;
  if (hadChanges || metaStale) {
    await env.ACTIVAS.put('_meta', JSON.stringify({
      last_run: nowIso, last_run_ms: now,
      alerts_vivas: vistos, nuevos_en_ciclo: nuevos, cerrados_en_ciclo: cerrados,
      api_header_ts: snapshot.header_ts, writes_en_ciclo: writes,
    }));
    writes++;
  }

  return { ok: true, at: nowIso, vistos, nuevos, cerrados, writes };
}

// ============================================================
//  TWEETS: pollear nitter.net y parear inicios↔fines
// ============================================================

async function pollTweets(env) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const result = { ok: true, at: nowIso, users: {} };

  // 1) Cargar incidentes-de-tweets vigentes (los abiertos, no cerrados)
  const idxRaw = await env.TW_INCIDENTES.get('_index');
  const idx = idxRaw ? JSON.parse(idxRaw) : [];
  // abiertos: los que no tienen fecha_fin_ms
  const abiertos = idx.filter(e => !e.fecha_fin_ms);

  let totalWrites = 0;
  const tweetsParsed = [];

  for (const user of TW_USERS) {
    let xml;
    try {
      xml = await fetchNitterRSS(user);
    } catch (e) {
      console.error(`nitter ${user} fail:`, e.message);
      result.users[user] = { ok: false, error: e.message };
      continue;
    }
    const items = parseRSS(xml);
    let nuevosTweets = 0;
    for (const it of items) {
      // Dedup
      const key = `tw_${it.tweet_id}`;
      const exists = await env.TWEETS.get(key);
      if (exists) continue;
      // Clasificar
      const linea = detectLineaTweet(it.text);
      const tipo = detectTipoTweet(it.text);
      const tw = {
        user, tweet_id: it.tweet_id,
        fecha_iso: it.fecha_iso, fecha_ms: it.fecha_ms,
        text: it.text, tipo, linea,
        url: `https://x.com/${user}/status/${it.tweet_id}`,
      };
      await env.TWEETS.put(key, JSON.stringify(tw), { expirationTtl: TWEET_TTL_S });
      tweetsParsed.push(tw);
      nuevosTweets++;
      totalWrites++;
    }
    result.users[user] = { ok: true, items: items.length, nuevos: nuevosTweets };
  }

  // 2) Procesar tweets nuevos en orden cronológico para parear con abiertos
  tweetsParsed.sort((a, b) => a.fecha_ms - b.fecha_ms);
  let incNuevos = 0, incCerrados = 0;

  for (const tw of tweetsParsed) {
    if (!tw.linea || tw.tipo === 'otro' || tw.tipo === 'info_operativa') {
      // ignoramos info operativa para no contaminar el calendar
      continue;
    }
    if (tw.tipo.startsWith('inicio_')) {
      // Si ya hay un abierto vigente para misma línea + mismo tipo y < MAX_DURATION_MS, mergear (es retweet del mismo evento)
      const existing = abiertos.find(e =>
        e.linea === tw.linea && e.tipo === tw.tipo &&
        (tw.fecha_ms - e.fecha_inicio_ms) < MAX_DURATION_MS
      );
      if (existing) {
        // sumar el tweet al existente (no abrir uno nuevo)
        const incRaw = await env.TW_INCIDENTES.get(existing.key);
        if (incRaw) {
          const inc = JSON.parse(incRaw);
          inc.tweets = inc.tweets || [];
          if (!inc.tweets.some(t => t.tweet_id === tw.tweet_id)) {
            inc.tweets.push({ tweet_id: tw.tweet_id, user: tw.user, fecha_iso: tw.fecha_iso, text: tw.text, url: tw.url, kind: tw.tipo });
            inc.last_update_ms = tw.fecha_ms;
            await env.TW_INCIDENTES.put(existing.key, JSON.stringify(inc));
            totalWrites++;
          }
        }
        continue;
      }
      // Crear incidente nuevo
      const incKey = `inc_${tw.linea}_${tw.tipo}_${tw.fecha_ms}`;
      const inc = {
        key: incKey, linea: tw.linea, tipo: tw.tipo,
        fecha_inicio_iso: tw.fecha_iso, fecha_inicio_ms: tw.fecha_ms,
        fecha_fin_iso: null, fecha_fin_ms: null,
        duracion_min: null,
        tweets: [{ tweet_id: tw.tweet_id, user: tw.user, fecha_iso: tw.fecha_iso, text: tw.text, url: tw.url, kind: tw.tipo }],
        last_update_ms: tw.fecha_ms,
      };
      await env.TW_INCIDENTES.put(incKey, JSON.stringify(inc));
      idx.unshift({ id: incKey, key: incKey, linea: tw.linea, tipo: tw.tipo, fecha_inicio_ms: tw.fecha_ms, fecha_fin_ms: null });
      abiertos.unshift({ id: incKey, key: incKey, linea: tw.linea, tipo: tw.tipo, fecha_inicio_ms: tw.fecha_ms, fecha_fin_ms: null });
      incNuevos++;
      totalWrites++;
    } else if (tw.tipo === 'fin') {
      // Buscar abierto de misma línea, dentro del MAX_DURATION_MS, cualquier tipo
      const matchIdx = abiertos.findIndex(e =>
        e.linea === tw.linea &&
        (tw.fecha_ms - e.fecha_inicio_ms) <= MAX_DURATION_MS &&
        (tw.fecha_ms - e.fecha_inicio_ms) >= 0
      );
      if (matchIdx >= 0) {
        const e = abiertos[matchIdx];
        const incRaw = await env.TW_INCIDENTES.get(e.key);
        if (incRaw) {
          const inc = JSON.parse(incRaw);
          inc.fecha_fin_iso = tw.fecha_iso;
          inc.fecha_fin_ms = tw.fecha_ms;
          inc.duracion_min = Math.max(0, Math.round((tw.fecha_ms - inc.fecha_inicio_ms) / 60000));
          inc.tweets = inc.tweets || [];
          inc.tweets.push({ tweet_id: tw.tweet_id, user: tw.user, fecha_iso: tw.fecha_iso, text: tw.text, url: tw.url, kind: 'fin' });
          inc.last_update_ms = tw.fecha_ms;
          await env.TW_INCIDENTES.put(e.key, JSON.stringify(inc));
          // Marcar cerrado en el index
          const ie = idx.find(ii => ii.key === e.key);
          if (ie) ie.fecha_fin_ms = tw.fecha_ms;
          abiertos.splice(matchIdx, 1);
          incCerrados++;
          totalWrites++;
        }
      }
    }
  }

  // 3) Cerrar por timeout: incidentes abiertos con > MAX_DURATION_MS
  for (let i = abiertos.length - 1; i >= 0; i--) {
    const e = abiertos[i];
    if ((now - e.fecha_inicio_ms) > MAX_DURATION_MS) {
      const incRaw = await env.TW_INCIDENTES.get(e.key);
      if (incRaw) {
        const inc = JSON.parse(incRaw);
        inc.fecha_fin_ms = inc.fecha_inicio_ms + MAX_DURATION_MS;
        inc.fecha_fin_iso = new Date(inc.fecha_fin_ms).toISOString();
        inc.duracion_min = Math.round(MAX_DURATION_MS / 60000);
        inc.timeout_close = true;
        await env.TW_INCIDENTES.put(e.key, JSON.stringify(inc));
        const ie = idx.find(ii => ii.key === e.key);
        if (ie) ie.fecha_fin_ms = inc.fecha_fin_ms;
        abiertos.splice(i, 1);
        incCerrados++;
        totalWrites++;
      }
    }
  }

  // 4) Persistir el index si hubo cambios
  if (incNuevos > 0 || incCerrados > 0) {
    // Truncar
    if (idx.length > TW_INC_LIMIT) {
      const obs = idx.slice(TW_INC_LIMIT);
      idx.length = TW_INC_LIMIT;
      for (const e of obs) await env.TW_INCIDENTES.delete(e.key);
    }
    await env.TW_INCIDENTES.put('_index', JSON.stringify(idx));
    totalWrites++;
  }

  // Meta
  const prevMetaRaw = await env.TW_INCIDENTES.get('_meta');
  const prevMeta = prevMetaRaw ? JSON.parse(prevMetaRaw) : null;
  const prevMetaMs = (prevMeta && prevMeta.last_run_ms) || 0;
  const metaStale = (now - prevMetaMs) >= META_REFRESH_MS;
  if (totalWrites > 0 || metaStale) {
    await env.TW_INCIDENTES.put('_meta', JSON.stringify({
      last_run: nowIso, last_run_ms: now,
      users_polled: TW_USERS,
      tweets_nuevos: tweetsParsed.length,
      incidentes_nuevos: incNuevos, incidentes_cerrados: incCerrados,
      writes_en_ciclo: totalWrites,
    }));
    totalWrites++;
  }

  result.tweets_nuevos = tweetsParsed.length;
  result.incidentes_nuevos = incNuevos;
  result.incidentes_cerrados = incCerrados;
  result.writes = totalWrites;
  return result;
}

// ============================================================
//  Quejas ciudadanas: búsqueda de menciones + cluster detection
// ============================================================

// Patrones de quejas con peso
const Q_STRONG = [
  /\bno\s+anda\b/, /\bno\s+funciona\b/, /\bno\s+se\s+mueve\b/, /\bno\s+avanza\b/,
  /\bparad[oa]s?\b/, /\bdetenid[oa]s?\b/, /\bcancelad[oa]s?\b/, /\bsuspendid[oa]s?\b/,
  /\bsin\s+servicio\b/, /\bno\s+hay\s+(servicio|subte)\b/, /\binterrumpid[oa]s?\b/,
  /\bcortad[oa]s?\b/, /\bcorte\b/, /\bsin\s+frecuencia\b/, /\bcero\s+frecuencia\b/,
  /\bni\s+(un\s+tren|se\s+mueve|aparece)\b/,
  /\bno\s+llega(n)?\b/, /\bno\s+sal(en|i[oó])\b/,
  /\bcolapsad[oa]\b/, /\bestall[oa]\b/,
  /\bdemoras?\b/, /\bdemorad[oa]s?\b/,
  /\bevacuaci[oó]n\b/, /\bevacuaron\b/,
  /\bse\s+cort[oó]\b/, /\bse\s+rompi[oó]\b/,
];
const Q_MEDIUM = [
  /\btard(a|an|ando)\b/, /\blent[oa]\b/, /\blentitud\b/,
  /\besper(o|ando|amos)\b/, /\bllen[oa]\b/, /\bexplotad[oa]\b/,
  /\brepleto\b/, /\bcolaps[oa]\b/,
  /\bhace\s+(mucho|rato|media\s+hora|un[ao]\s+hora|una\s+eternidad)\b/,
  /\bllevo\s+\d+\s+min/, /\bllevo\s+(media\s+hora|una\s+hora)/,
  /\b(\d{1,3})\s*(min|minutos|hs|horas)\b/,
  /\bfrecuencia\s+(mala|p[eé]sima|horrible|de\s+mierda)\b/,
  /\bcomo\s+sardinas\b/, /\bno\s+entra(mos)?\b/,
  /\bes(ta|tá)\s+(rot[oa]|fundid[oa])\b/,
  /\babrieron\s+las\s+puertas\b/,
];
const Q_WEAK = [/\bsubte\b/, /\btren(es)?\b/, /\bestaci[oó]n\b/];
const Q_EXCLUDE = [/\bgracias\b/, /\bfelicit/, /\bbuen\s+servicio\b/];

function detectLineaQueja(text) {
  const t = text.toLowerCase();
  const m1 = /#l[ií]nea\s*([abcdeh])\b/.exec(t); if (m1) return m1[1].toUpperCase();
  const m2 = /l[ií]nea\s+([abcdeh])\b/.exec(t);  if (m2) return m2[1].toUpperCase();
  const m3 = /\bla\s+([abcdeh])\b(?!\w)/.exec(t); if (m3) return m3[1].toUpperCase();
  if (/#?premetro/.test(t)) return 'P';
  return null;
}

function scoreQueja(text) {
  const t = (text || '').toLowerCase();
  if (Q_EXCLUDE.some(re => re.test(t))) return 0;
  let s = 0;
  for (const re of Q_STRONG)  if (re.test(t)) s += 1.0;
  for (const re of Q_MEDIUM)  if (re.test(t)) s += 0.5;
  for (const re of Q_WEAK)    if (re.test(t)) s += 0.2;
  return s;
}

async function pollQuejas(env) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const result = { ok: true, at: nowIso };

  // Bajar resultados de cada query y deduplicar por tweet_id
  const seenIds = new Set();
  const items = [];
  const queriesResult = {};
  for (const q of QUEJAS_QUERIES) {
    try {
      const xml = await fetchNitterSearch(q);
      const its = parseRSSWithUser(xml);
      let added = 0;
      for (const it of its) {
        if (seenIds.has(it.tweet_id)) continue;
        seenIds.add(it.tweet_id);
        items.push(it);
        added++;
      }
      queriesResult[q] = { ok: true, total: its.length, nuevos_dedup: added };
    } catch (e) {
      queriesResult[q] = { ok: false, error: e.message };
    }
  }
  // Si TODAS las queries fallaron, salimos
  if (items.length === 0 && Object.values(queriesResult).every(r => !r.ok)) {
    return { ok: false, queries: queriesResult, at: nowIso };
  }
  let nuevas = 0, writes = 0;

  // Para cada tweet: guardar 2 versiones en KV
  //  (a) "v_<tweet_id>" - todas las menciones no oficiales, para detector de VOLUMEN (sin filtros)
  //  (b) "q_<tweet_id>" - solo las que pasan filtros de keywords + línea, para detector PRECISO
  let nuevasVol = 0;
  for (const it of items) {
    if (it.user && QUEJAS_EXCLUDE_USERS.has(it.user.toLowerCase())) continue;

    // Guardar para detector de volumen (todos los tweets ciudadanos)
    const vkey = `v_${it.tweet_id}`;
    const vExists = await env.TWEETS.get(vkey);
    if (!vExists) {
      await env.TWEETS.put(vkey, JSON.stringify({
        tweet_id: it.tweet_id, user: it.user,
        fecha_iso: it.fecha_iso, fecha_ms: it.fecha_ms,
        text: it.text,
        url: `https://x.com/${it.user}/status/${it.tweet_id}`,
      }), { expirationTtl: VOLUMEN_TTL_S });
      nuevasVol++;
      writes++;
    }

    // Filtro fino para detector preciso
    const linea = detectLineaQueja(it.text);
    if (!linea) continue;
    const sc = scoreQueja(it.text);
    if (sc < 1.0) continue;
    const key = `q_${it.tweet_id}`;
    const exists = await env.TWEETS.get(key);
    if (exists) continue;
    await env.TWEETS.put(key, JSON.stringify({
      tweet_id: it.tweet_id, user: it.user,
      fecha_iso: it.fecha_iso, fecha_ms: it.fecha_ms,
      text: it.text, linea, score: sc,
      url: `https://x.com/${it.user}/status/${it.tweet_id}`,
    }), { expirationTtl: QUEJAS_TTL_S });
    nuevas++;
    writes++;
  }

  // Reconstruir clusters: agrupar quejas vivas (last 30min) por línea
  // Listar todas las claves q_* (las del TTL siguen vivas)
  const list = await env.TWEETS.list({ prefix: 'q_', limit: 1000 });
  const clusters = {};   // por línea: [{tweet_id, user, fecha_ms, text, url, score}]
  for (const k of list.keys) {
    const raw = await env.TWEETS.get(k.name);
    if (!raw) continue;
    const q = JSON.parse(raw);
    if ((now - q.fecha_ms) > QUEJAS_WINDOW_MS) continue;
    if (!clusters[q.linea]) clusters[q.linea] = [];
    clusters[q.linea].push(q);
  }

  // Persistir el cluster activo en TW_INCIDENTES con prefijo "qcluster_"
  const alertasCiudadanas = [];
  for (const linea in clusters) {
    const tws = clusters[linea];
    if (tws.length >= QUEJAS_THRESHOLD) {
      tws.sort((a, b) => a.fecha_ms - b.fecha_ms);
      alertasCiudadanas.push({
        linea, tipo: 'reporte_ciudadano',
        primer_ms: tws[0].fecha_ms, ultimo_ms: tws[tws.length-1].fecha_ms,
        cantidad: tws.length,
        tweets: tws.slice(-5).map(t => ({ tweet_id: t.tweet_id, user: t.user, text: t.text, url: t.url, fecha_iso: t.fecha_iso })),
      });
    }
  }

  // Guardar snapshot solo si cambió respecto al anterior (ahorra writes en plan free)
  const prevQuejasRaw = await env.TW_INCIDENTES.get('_quejas_active');
  const prevQuejas = prevQuejasRaw ? JSON.parse(prevQuejasRaw) : null;
  const sigPrevQuejas = prevQuejas ? JSON.stringify(prevQuejas.alertas || []) : '';
  const sigNewQuejas = JSON.stringify(alertasCiudadanas);
  if (sigPrevQuejas !== sigNewQuejas) {
    await env.TW_INCIDENTES.put('_quejas_active', JSON.stringify({
      generated_at: nowIso, threshold: QUEJAS_THRESHOLD,
      window_min: QUEJAS_WINDOW_MS / 60000,
      alertas: alertasCiudadanas,
    }));
    writes++;
  }

  // ─── Detector de VOLUMEN (sin filtros) + últimos tweets crudos ──
  // Cuenta usuarios DISTINTOS arrobando a cuentas oficiales en ventana corta.
  const volList = await env.TWEETS.list({ prefix: 'v_', limit: 1000 });
  const usersInWindow = new Map();
  const todosCiudadanos = [];  // lista completa para los "últimos tweets"
  for (const k of volList.keys) {
    const raw = await env.TWEETS.get(k.name);
    if (!raw) continue;
    const v = JSON.parse(raw);
    todosCiudadanos.push(v);
    if ((now - v.fecha_ms) > VOLUMEN_WINDOW_MS) continue;
    const u = (v.user || '').toLowerCase();
    if (!u) continue;
    if (!usersInWindow.has(u)) usersInWindow.set(u, []);
    usersInWindow.get(u).push(v);
  }
  let alertaVolumen = null;
  if (usersInWindow.size >= VOLUMEN_THRESHOLD_USERS) {
    const muestra = [];
    let allMs = [];
    for (const [u, tws] of usersInWindow.entries()) {
      tws.sort((a, b) => b.fecha_ms - a.fecha_ms);
      muestra.push({ user: u, tweet_id: tws[0].tweet_id, text: tws[0].text, url: tws[0].url, fecha_iso: tws[0].fecha_iso });
      for (const t of tws) allMs.push(t.fecha_ms);
    }
    muestra.sort((a, b) => Date.parse(b.fecha_iso) - Date.parse(a.fecha_iso));
    alertaVolumen = {
      tipo: 'posible_incidencia',
      usuarios_distintos: usersInWindow.size,
      total_menciones: allMs.length,
      primer_ms: Math.min(...allMs),
      ultimo_ms: Math.max(...allMs),
      muestra: muestra.slice(0, 8),
    };
  }
  // Últimos N tweets ciudadanos crudos (para mostrar al final del banner como "feed")
  todosCiudadanos.sort((a, b) => b.fecha_ms - a.fecha_ms);
  const ultimosTweets = todosCiudadanos.slice(0, ULTIMOS_TWEETS_N).map(v => ({
    user: v.user, tweet_id: v.tweet_id, text: v.text, url: v.url, fecha_iso: v.fecha_iso, fecha_ms: v.fecha_ms,
  }));
  // Guardar volumen sólo si cambió: usamos firma compacta (cantidad + tweet_ids + flag de alerta)
  const prevVolRaw = await env.TW_INCIDENTES.get('_volumen_active');
  const prevVol = prevVolRaw ? JSON.parse(prevVolRaw) : null;
  const sigVol = (obj) => obj
    ? `${obj.usuarios_distintos_actual}|${(obj.ultimos_tweets || []).map(t => t.tweet_id).join(',')}|${obj.alerta ? '1' : '0'}`
    : '';
  const newVolPayload = {
    generated_at: nowIso,
    threshold_users: VOLUMEN_THRESHOLD_USERS,
    window_min: VOLUMEN_WINDOW_MS / 60000,
    usuarios_distintos_actual: usersInWindow.size,
    alerta: alertaVolumen,
    ultimos_tweets: ultimosTweets,
  };
  if (sigVol(prevVol) !== sigVol(newVolPayload)) {
    await env.TW_INCIDENTES.put('_volumen_active', JSON.stringify(newVolPayload));
    writes++;
  }

  result.queries = queriesResult;
  result.tweets_search = items.length;
  result.quejas_nuevas = nuevas;
  result.alertas_activas = alertasCiudadanas.length;
  result.volumen = { usuarios_actual: usersInWindow.size, alerta: !!alertaVolumen };
  result.writes = writes;
  return result;
}

async function fetchNitterSearch(query) {
  const PER_HOST_TIMEOUT_MS = 5000;
  let lastErr = null;
  for (const host of NITTER_HOSTS) {
    const url = `${host}/search/rss?f=tweets&q=${encodeURIComponent(query)}`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PER_HOST_TIMEOUT_MS);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Feedly/1.0', 'Accept': 'application/rss+xml,application/xml,*/*' },
        cf: { cacheTtl: 0 }, signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) { lastErr = new Error(`${host}: HTTP ${resp.status}`); continue; }
      const text = await resp.text();
      if (!text.includes('<item>')) { lastErr = new Error(`${host}: no items`); continue; }
      return text;
    } catch (e) { lastErr = new Error(`${host}: ${e.message}`); }
  }
  throw lastErr || new Error('todos los hosts fallaron');
}

function parseRSSWithUser(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = unescapeXml((/<title>([\s\S]*?)<\/title>/.exec(block) || [,''])[1].replace(/^<!\[CDATA\[|\]\]>$/g, ''));
    const link  = (/<link>([\s\S]*?)<\/link>/.exec(block) || [,''])[1];
    const pub   = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block) || [,''])[1];
    const idM = /\/([^/]+)\/status\/(\d+)/.exec(link);
    if (!idM) continue;
    const user = idM[1], tweet_id = idM[2];
    const fecha_ms = Date.parse(pub);
    if (!fecha_ms || isNaN(fecha_ms)) continue;
    items.push({ tweet_id, user, fecha_ms, fecha_iso: new Date(fecha_ms).toISOString(), text: title.trim() });
  }
  return items;
}

// ============================================================
//  Helpers GCBA
// ============================================================

async function fetchGCBASnapshot(env) {
  const u = new URL(API_BASE);
  u.searchParams.set('json', '1');
  u.searchParams.set('client_id', env.GCBA_CLIENT_ID);
  u.searchParams.set('client_secret', env.GCBA_CLIENT_SECRET);
  const resp = await fetch(u.toString(), { headers: { 'Accept': 'application/json' }, cf: { cacheTtl: 0 } });
  if (!resp.ok) throw new Error(`GCBA ${resp.status}`);
  const data = await resp.json();
  const headerTs = data.header && data.header.timestamp;
  const entities = Array.isArray(data.entity) ? data.entity : [];
  const alerts = [];
  for (const ent of entities) {
    const al = ent.alert; if (!al) continue;
    const text = pickTranslation(al.description_text);
    const header = pickTranslation(al.header_text);
    const routeIds = (al.informed_entity || []).map(ie => ie.route_id).filter(Boolean);
    alerts.push({
      id: ent.id,
      linea: detectLineaGCBA(routeIds, header, text),
      tipo: detectTipoTexto(text + ' ' + header, al.effect),
      cause: al.cause, cause_label: CAUSE_CODES[al.cause] || null,
      effect: al.effect, effect_label: EFFECT_CODES[al.effect] || null,
      text, header, route_ids: routeIds,
    });
  }
  return { header_ts: headerTs, alerts };
}

function pickTranslation(field) {
  if (!field || !Array.isArray(field.translation)) return '';
  const es = field.translation.find(t => (t.language || '').toLowerCase().startsWith('es'));
  return (es || field.translation[0] || {}).text || '';
}

function detectLineaGCBA(routeIds, header, text) {
  for (const r of routeIds) {
    const m = /linea\s*([abcdeh])/i.exec(r);
    if (m) return m[1].toUpperCase();
    if (/premetro/i.test(r)) return 'P';
  }
  const blob = (header + ' ' + text).toLowerCase();
  const m = /l[ií]nea\s+([abcdeh])\b/.exec(blob);
  if (m) return m[1].toUpperCase();
  if (/premetro/.test(blob)) return 'P';
  return null;
}

async function archiveIncident(env, inc) {
  const key = `inc_${inc.first_seen_ms}_${inc.id}`;
  await env.HISTORICOS.put(key, JSON.stringify(inc));
  const idxRaw = await env.HISTORICOS.get('_index');
  let idx = idxRaw ? JSON.parse(idxRaw) : [];
  idx.unshift({
    id: inc.id, key,
    first_seen_ms: inc.first_seen_ms, cerrado_at_ms: inc.cerrado_at_ms,
    linea: inc.linea, tipo: inc.tipo, duration_min: inc.duration_min,
  });
  if (idx.length > HISTORICOS_LIMIT) {
    const obs = idx.slice(HISTORICOS_LIMIT);
    idx = idx.slice(0, HISTORICOS_LIMIT);
    for (const e of obs) await env.HISTORICOS.delete(e.key);
  }
  await env.HISTORICOS.put('_index', JSON.stringify(idx));
}

// ============================================================
//  Helpers Tweets / Nitter
// ============================================================

async function fetchNitterRSS(user) {
  const PER_HOST_TIMEOUT_MS = 5000;
  let lastErr = null;
  for (const host of NITTER_HOSTS) {
    const url = `${host}/${encodeURIComponent(user)}/rss`;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), PER_HOST_TIMEOUT_MS);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Feedly/1.0', 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' },
        cf: { cacheTtl: 0 },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) { lastErr = new Error(`${host}: HTTP ${resp.status}`); continue; }
      const text = await resp.text();
      if (!text.includes('<item>')) { lastErr = new Error(`${host}: no items`); continue; }
      return text;
    } catch (e) { lastErr = new Error(`${host}: ${e.message}`); }
  }
  throw lastErr || new Error('todos los hosts nitter fallaron');
}

// Diagnóstico: probar cada host y reportar
async function diagnoseNitter(user) {
  const out = [];
  for (const host of NITTER_HOSTS) {
    const url = `${host}/${encodeURIComponent(user)}/rss`;
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(url, {
        headers: { 'User-Agent': 'Feedly/1.0', 'Accept': 'application/rss+xml,application/xml,*/*' },
        cf: { cacheTtl: 0 }, signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await resp.text();
      out.push({ host, status: resp.status, bytes: text.length, items: (text.match(/<item>/g) || []).length, ms: Date.now() - t0 });
    } catch (e) {
      out.push({ host, error: e.message, ms: Date.now() - t0 });
    }
  }
  return out;
}

// Diagnóstico de los feeds GTFS-RT del subte (vehiclePositions, tripUpdates, forecastGTFS).
// Llama c/u con las credenciales reales y devuelve summary: header timestamp, entity count,
// muestra de 3 entities, y si hubo error. Sirve para decidir si vale la pena implementar
// detectores basados en estos feeds.
async function diagnoseGtfsRt(env) {
  const base = 'https://apitransporte.buenosaires.gob.ar/subtes';
  const endpoints = ['vehiclePositions', 'tripUpdates', 'forecastGTFS'];
  const out = { at: new Date().toISOString(), endpoints: {} };
  for (const ep of endpoints) {
    const u = new URL(`${base}/${ep}`);
    u.searchParams.set('json', '1');
    u.searchParams.set('client_id', env.GCBA_CLIENT_ID);
    u.searchParams.set('client_secret', env.GCBA_CLIENT_SECRET);
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      const resp = await fetch(u.toString(), {
        headers: { 'Accept': 'application/json' },
        cf: { cacheTtl: 0 }, signal: ctrl.signal,
      });
      clearTimeout(timer);
      const ms = Date.now() - t0;
      const ct = resp.headers.get('content-type') || '';
      const bodyText = await resp.text();
      let parsed = null, parseError = null;
      try { parsed = JSON.parse(bodyText); } catch (e) { parseError = e.message; }
      const entry = { http: resp.status, content_type: ct, bytes: bodyText.length, ms };
      if (parsed) {
        const entities = Array.isArray(parsed.entity) ? parsed.entity : [];
        entry.header_ts = parsed.header?.timestamp || null;
        entry.header_ts_iso = entry.header_ts ? new Date(entry.header_ts * 1000).toISOString() : null;
        entry.entity_count = entities.length;
        entry.sample_3 = entities.slice(0, 3);
        // Algunos breakdowns útiles
        if (ep === 'vehiclePositions') {
          const lineas = {};
          for (const e of entities) {
            const rid = e?.vehicle?.trip?.route_id || e?.vehicle?.vehicle?.id || 'unknown';
            lineas[rid] = (lineas[rid] || 0) + 1;
          }
          entry.por_route_id = lineas;
        }
        if (ep === 'tripUpdates' || ep === 'forecastGTFS') {
          const lineas = {};
          for (const e of entities) {
            const rid = e?.trip_update?.trip?.route_id || 'unknown';
            lineas[rid] = (lineas[rid] || 0) + 1;
          }
          entry.por_route_id = lineas;
        }
      } else {
        entry.parse_error = parseError;
        entry.body_preview = bodyText.slice(0, 400);
      }
      out.endpoints[ep] = entry;
    } catch (e) {
      out.endpoints[ep] = { error: e.message, ms: Date.now() - t0 };
    }
  }
  return out;
}

// Parser RSS minimalista (sin DOM). Captura <item>...<title>...<link>...<pubDate>.
function parseRSS(xml) {
  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const title = unescapeXml((/<title>([\s\S]*?)<\/title>/.exec(block) || [,''])[1].replace(/^<!\[CDATA\[|\]\]>$/g, ''));
    const link  = (/<link>([\s\S]*?)<\/link>/.exec(block) || [,''])[1];
    const pub   = (/<pubDate>([\s\S]*?)<\/pubDate>/.exec(block) || [,''])[1];
    // tweet_id está en el link: .../status/<id>#m
    const idM = /\/status\/(\d+)/.exec(link);
    if (!idM) continue;
    const fecha_ms = Date.parse(pub);
    if (!fecha_ms || isNaN(fecha_ms)) continue;
    items.push({
      tweet_id: idM[1],
      fecha_ms, fecha_iso: new Date(fecha_ms).toISOString(),
      text: title.trim(),
    });
  }
  return items;
}

function unescapeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#x27;/g, "'").replace(/&#39;/g, "'");
}

function detectLineaTweet(text) {
  const t = text.toLowerCase();
  // hashtag #LineaA / #LíneaA / #lineaa  + texto "Línea A"
  const m1 = /#l[ií]nea\s*([abcdeh])\b/i.exec(text);
  if (m1) return m1[1].toUpperCase();
  const m2 = /l[ií]nea\s+([abcdeh])\b/i.exec(text);
  if (m2) return m2[1].toUpperCase();
  if (/#?premetro/i.test(text)) return 'P';
  return null;
}

function detectTipoTweet(text) {
  const t = text.toLowerCase();
  // FINES (revisar primero, los inicios contienen palabras parecidas)
  if (/(servicio\s+normalizad|normaliz[oó])/.test(t)) return 'fin';
  if (/ya\s+(circula|funciona)\s+con\s+su\s+frecuencia\s+(habitual|normal)/.test(t)) return 'fin';
  if (/presta\s+su\s+servicio\s+completo/.test(t)) return 'fin';
  if (/realiza\s+su\s+recorrido\s+(completo|habitual)/.test(t)) return 'fin';
  if (/ya\s+se\s+detienen?\s+en\s+todas\s+las\s+estaciones/.test(t)) return 'fin';
  if (/reabri[oó]?\s+(la\s+estación|el\s+servicio)/.test(t)) return 'fin';

  // OBRAS / RENOVACIÓN ESTRUCTURAL — prioritario: si el cierre es por obras crónicas,
  // no es un incidente puntual del día sino info operativa permanente.
  // Va antes que las reglas de inicio_estacion_cerrada para evitar falsos positivos
  // como "Estación Tribunales cerrada por obras de renovación integral".
  if (/(renovaci[oó]n\s+integral|obras\s+de\s+renovaci[oó]n|cerrad[ao]\s+por\s+obras|cerrad[ao]\s+por\s+trabajos|por\s+obras\s+de|trabajos\s+de\s+renovaci[oó]n|horario\s+extendido|servicio\s+ampliado)/.test(t)) return 'info_operativa';

  // INICIOS
  if (/(servicio\s+interrumpido|sin\s+servicio|no\s+circula|servicio\s+suspendido)/.test(t)) return 'inicio_interrumpido';
  if (/(medida\s+de\s+fuerza|paro\s+gremial|paro\s+de)/.test(t)) return 'inicio_interrumpido';
  if (/no\s+se\s+detienen?\s+en/.test(t)) return 'inicio_estacion_cerrada';
  if (/estaci[oó]n\s+\w+\s+cerrada/.test(t)) return 'inicio_estacion_cerrada';
  if (/servicio\s+limitado/.test(t) || /circula\s+con\s+servicio\s+limitado/.test(t)) return 'inicio_limitado';
  if (/(servicio\s+(con\s+)?demora|circula\s+con\s+demora|con\s+demoras?)/.test(t)) return 'inicio_demora';
  if (/(obras|trabajos)/.test(t)) return 'info_operativa';
  return 'otro';
}

function detectTipoTexto(blob, effect) {
  const t = (blob || '').toLowerCase();
  // OBRAS / RENOVACIÓN: prioritario (mismo motivo que en detectTipoTweet)
  if (/(renovaci[oó]n\s+integral|obras\s+de\s+renovaci[oó]n|cerrad[ao]\s+por\s+obras|cerrad[ao]\s+por\s+trabajos|por\s+obras\s+de|trabajos\s+de\s+renovaci[oó]n|horario\s+extendido|servicio\s+ampliado)/.test(t)) return 'info_operativa';
  if (/(servicio\s+interrumpido|sin\s+servicio|no\s+circula|servicio\s+suspendido)/.test(t)) return 'inicio_interrumpido';
  if (/(medida\s+de\s+fuerza|paro\s+gremial|paro\s+de)/.test(t)) return 'inicio_interrumpido';
  if (/no\s+se\s+detienen?\s+en/.test(t)) return 'inicio_estacion_cerrada';
  if (/estaci[oó]n\s+\w+\s+cerrada/.test(t)) return 'inicio_estacion_cerrada';
  if (/servicio\s+limitado/.test(t)) return 'inicio_limitado';
  if (/(servicio\s+(con\s+)?demora|circula\s+con\s+demora|con\s+demoras?)/.test(t)) return 'inicio_demora';
  if (/(obras|trabajos|ampliaci[oó]n)/.test(t)) return 'info_operativa';
  if (effect === 1) return 'inicio_interrumpido';
  if (effect === 2) return 'inicio_limitado';
  if (effect === 3) return 'inicio_demora';
  if (effect === 4) return 'inicio_limitado';
  if (effect === 6) return 'info_operativa';
  return 'otro';
}

// ============================================================
//  Endpoints HTTP
// ============================================================

async function handleData(env) {
  // GCBA activas
  const list = await env.ACTIVAS.list();
  const activas_gcba = [];
  for (const k of list.keys) {
    if (k.name === '_meta') continue;
    const raw = await env.ACTIVAS.get(k.name);
    if (raw) activas_gcba.push(JSON.parse(raw));
  }
  // GCBA cerrados
  const idxGcbaRaw = await env.HISTORICOS.get('_index');
  const idxGcba = idxGcbaRaw ? JSON.parse(idxGcbaRaw) : [];
  const cerrados_gcba = [];
  for (const e of idxGcba.slice(0, 1000)) {
    const raw = await env.HISTORICOS.get(e.key);
    if (raw) cerrados_gcba.push(JSON.parse(raw));
  }
  // Quejas ciudadanas (cluster activo)
  const quejasRaw = await env.TW_INCIDENTES.get('_quejas_active');
  const quejas = quejasRaw ? JSON.parse(quejasRaw) : null;
  const volRaw = await env.TW_INCIDENTES.get('_volumen_active');
  const volumen = volRaw ? JSON.parse(volRaw) : null;
  // Tweets: incidentes
  const idxTwRaw = await env.TW_INCIDENTES.get('_index');
  const idxTw = idxTwRaw ? JSON.parse(idxTwRaw) : [];
  const activas_tweets = [], cerrados_tweets = [];
  for (const e of idxTw.slice(0, 1000)) {
    const raw = await env.TW_INCIDENTES.get(e.key);
    if (!raw) continue;
    const inc = JSON.parse(raw);
    if (inc.fecha_fin_ms) cerrados_tweets.push(inc);
    else activas_tweets.push(inc);
  }
  // Metas
  const metaG = await env.ACTIVAS.get('_meta');
  const metaT = await env.TW_INCIDENTES.get('_meta');

  const body = JSON.stringify({
    generated_at: new Date().toISOString(),
    last_polls: {
      gcba: metaG ? JSON.parse(metaG) : null,
      tweets: metaT ? JSON.parse(metaT) : null,
    },
    activas_gcba,
    activas_tweets,
    quejas_ciudadanas: quejas,
    volumen_ciudadano: volumen,
    cerrados_gcba,
    cerrados_tweets,
    totales: {
      activas_gcba: activas_gcba.length,
      activas_tweets: activas_tweets.length,
      cerrados_gcba: cerrados_gcba.length,
      cerrados_tweets: cerrados_tweets.length,
      historicos_total: idxGcba.length + idxTw.length,
    },
  });
  return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=30' } });
}

async function handleStatus(env) {
  const metaG = await env.ACTIVAS.get('_meta');
  const metaT = await env.TW_INCIDENTES.get('_meta');
  const listG = await env.ACTIVAS.list();
  const idxG = await env.HISTORICOS.get('_index');
  const idxT = await env.TW_INCIDENTES.get('_index');
  const idxTArr = idxT ? JSON.parse(idxT) : [];
  const body = JSON.stringify({
    worker: 'canuto-subte', v: 3, now: new Date().toISOString(),
    gcba: {
      activas: listG.keys.filter(k => k.name !== '_meta').length,
      historicos: idxG ? JSON.parse(idxG).length : 0,
      last_poll: metaG ? JSON.parse(metaG) : null,
    },
    tweets: {
      activos: idxTArr.filter(e => !e.fecha_fin_ms).length,
      cerrados: idxTArr.filter(e => e.fecha_fin_ms).length,
      last_poll: metaT ? JSON.parse(metaT) : null,
    },
  }, null, 2);
  return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}

function cors(resp) {
  const h = new Headers(resp.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  return new Response(resp.body, { status: resp.status, headers: h });
}
