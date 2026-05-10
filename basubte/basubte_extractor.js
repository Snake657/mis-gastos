/* ════════════════════════════════════════════════════════════════════
 * X TWEETS EXTRACTOR — para pegar en la consola del navegador (F12)
 * ════════════════════════════════════════════════════════════════════
 *
 * USO:
 *   1. Abrir x.com/search con query: from:USUARIO  (ej: from:basubte,
 *      from:Emova_arg) ordenado por "Más reciente" (f=live)
 *   2. Esperar a que carguen los primeros tweets
 *   3. F12 → solapa "Console" → escribir `allow pasting` (1ra vez en sesión)
 *   4. Pegar este archivo y dar Enter
 *   5. Aparece panel flotante arriba-derecha. Auto-scrollea, junta tweets,
 *      al final descarga JSON + ofrece "Copiar al portapapeles" (manual,
 *      por límite de Chrome cuando el foco está en DevTools)
 *
 * GENERICO: detecta el `from:USER` automáticamente desde la URL de búsqueda
 * y filtra solo tweets de ese usuario. Sirve para cualquier cuenta de X.
 *
 * Si X muestra captcha o "rate limit", parar, esperar 5 min y seguir.
 * Para queries grandes (1+ años): dividir en ventanas mensuales con
 * since:/until:
 *
 * Output JSON: [{ id, datetime, text, line, kind, stations, hashtags, user }]
 * ════════════════════════════════════════════════════════════════════ */

(async () => {
  if (window.__xTweetExtractor) {
    console.warn('Ya hay un extractor corriendo. Pará el actual primero.');
    return;
  }

  // ─── Detectar usuario desde la URL de búsqueda ──────────────────
  // URLs típicas:
  //   https://x.com/search?q=from%3Abasubte&f=live
  //   https://x.com/search?q=from%3AEmova_arg+l%C3%ADneab&f=live
  function detectarUser() {
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q') || '';
    const m = q.match(/from:([A-Za-z0-9_]+)/i);
    if (m) return m[1].toLowerCase();
    // Fallback: si estamos en /USUARIO (perfil)
    const path = window.location.pathname.split('/').filter(Boolean);
    if (path.length === 1 && /^[A-Za-z0-9_]+$/.test(path[0])) return path[0].toLowerCase();
    return null;
  }
  const TARGET_USER = detectarUser();
  if (!TARGET_USER) {
    alert('No detecté un usuario en la URL.\n\nUsá una búsqueda con "from:USUARIO" (ej: from:basubte) o estate parado en el perfil del usuario.');
    return;
  }
  console.log(`🎯 Filtrando tweets de @${TARGET_USER}`);

  // ─── Estado ──────────────────────────────────────────────────────
  const seen = new Map();
  let stop = false;
  let stableIters = 0;
  const STABLE_LIMIT = 5;
  const SCROLL_DELAY_MS = 1400;
  const MAX_ITERS = 5000;

  // ─── UI flotante ─────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = '__x_extr_panel';
  panel.style.cssText = `
    position: fixed; top: 16px; right: 16px; z-index: 999999;
    background: #0d0f14; color: #e8e8ee; padding: 14px 18px;
    border-radius: 10px; border: 1px solid #2a2f3a;
    font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: 13px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.6); min-width: 260px;
  `;
  panel.innerHTML = `
    <div style="font-weight:700;color:#22d3ee;margin-bottom:6px">🎯 @${TARGET_USER}</div>
    <div id="__x_count" style="font-size:18px;font-weight:700">0 tweets</div>
    <div id="__x_status" style="color:#9090a0;margin-top:4px;font-size:11px">Iniciando…</div>
    <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
      <button id="__x_stop" style="background:#ef4444;color:white;border:0;padding:6px 12px;border-radius:6px;font-family:inherit;font-weight:600;cursor:pointer">STOP</button>
      <button id="__x_dl" style="background:#22c55e;color:white;border:0;padding:6px 12px;border-radius:6px;font-family:inherit;font-weight:600;cursor:pointer">Descargar</button>
      <button id="__x_copy" style="background:#22d3ee;color:#0d0f14;border:0;padding:6px 12px;border-radius:6px;font-family:inherit;font-weight:700;cursor:pointer;display:none">📋 Copiar</button>
    </div>
  `;
  document.body.appendChild(panel);
  const $count = panel.querySelector('#__x_count');
  const $status = panel.querySelector('#__x_status');
  const $copy = panel.querySelector('#__x_copy');
  panel.querySelector('#__x_stop').onclick = () => { stop = true; $status.textContent = 'Deteniendo…'; };
  panel.querySelector('#__x_dl').onclick = () => exportar();
  $copy.onclick = () => copiarPortapapeles();
  let _lastJson = null;
  function copiarPortapapeles() {
    if (!_lastJson) return;
    navigator.clipboard.writeText(_lastJson).then(
      () => { $copy.textContent = '✓ Copiado'; setTimeout(() => { $copy.textContent = '📋 Copiar'; }, 1500); },
      (err) => { alert('No pude copiar al portapapeles: ' + err.message); }
    );
  }

  window.__xTweetExtractor = { stop: () => { stop = true; }, getTweets: () => Array.from(seen.values()) };

  // ─── Clasificador (genérico para cuentas de subte) ───────────────
  function detectarLinea(texto) {
    // "Línea B", "líneaB", "Linea B", "L. B"
    const m = texto.match(/L[íi]nea\s*([ABCDEH])\b/i);
    if (m) return m[1].toUpperCase();
    if (/Premetro/i.test(texto)) return 'Premetro';
    return null;
  }
  function detectarTipo(texto) {
    const t = texto.toLowerCase();
    // EXCLUSIONES
    if (/(carlos vives|la renga|recital|concierto|shakira|partido|river|boca)/.test(t)) return 'info_evento';
    if (/(limpieza en estaciones|equipos de @emova|así se trabaja|los trabajos contemplan|incorporación de luces led|nuevo mobiliario|impermeabilización)/.test(t)) return 'info_corporativa';
    if (/(horario\s+extendido|extensión\s+horaria|extiende\s+su\s+horario|hasta\s+la\s+\d+\s*(am|a\.?m|hs))/.test(t)) return 'info_horario';
    if (/cerrad[oa]\s+por\s+obras|obras\s+de\s+renovación|plan\s+de\s+renovación/.test(t)) {
      if (!/reabri/.test(t)) return 'cierre_programado';
    }
    // FINES
    if (/servicio\s+normalizado/.test(t)) return 'fin';
    if (/ya\s+realiza\s+el\s+recorrido\s+completo/.test(t)) return 'fin';
    if (/ya\s+se\s+detienen?\s+en\s+todas/.test(t)) return 'fin';
    if (/ya\s+circula\s+con\s+su\s+frecuencia\s+habitual/.test(t)) return 'fin';
    if (/reabri[oó]?\s+la\s+estaci[oó]n/.test(t)) return 'fin';
    // FIN DE JORNADA
    if (/servicio\s+finalizado/.test(t)) return 'info_horario';
    // INICIOS
    if (/(medida\s+de\s+fuerza|paro|asamblea\s+gremial|gremial)/.test(t) && /(servicio|interrumpido|sin\s+servicio)/.test(t)) return 'inicio_paro';
    if (/servicio\s+limitado/.test(t)) return 'inicio_limitado';
    if (/no\s+se\s+detienen?\s+en\s+(la|las)\s+estaci[oó]n/.test(t)) return 'inicio_estacion_cerrada';
    if (/(servicio\s+con\s+demora|demora\s+en\s+el\s+servicio|servicio\s+con\s+demoras)/.test(t)) return 'inicio_demora';
    if (/(servicio\s+interrumpido|sin\s+servicio|servicio\s+suspendido|servicio\s+cancelado)/.test(t)) return 'inicio_interrumpido';
    return 'otro';
  }
  function extraerHashtags(texto) {
    return Array.from(new Set((texto.match(/#[\wÁÉÍÓÚáéíóúñÑ]+/g) || []).map(h => h.toLowerCase())));
  }
  function extraerEstaciones(texto) {
    const m1 = texto.match(/limitado\s+entre\s+las\s+estaciones\s+(.+?)(?:\.|$)/i);
    if (m1) return m1[1].trim();
    const m2 = texto.match(/no\s+se\s+detienen?\s+en\s+(?:la|las)\s+estaci[oó]n(?:es)?\s+(.+?)(?:\.|$)/i);
    if (m2) return m2[1].trim();
    const m3 = texto.match(/estaci[oó]n\s+([A-ZÁÉÍÓÚ][\w\sáéíóúñÑ.\-]+?)\s+cerrada/i);
    if (m3) return m3[1].trim();
    const m4 = texto.match(/reabri[oó]?\s+la\s+estaci[oó]n\s+([A-ZÁÉÍÓÚ][\w\sáéíóúñÑ.\-]+?)(?:\s+luego|\s+tras|\.|$)/i);
    if (m4) return m4[1].trim();
    return null;
  }

  // ─── Extracción de tweets visibles ───────────────────────────────
  function extractVisible() {
    let nuevos = 0;
    const articles = document.querySelectorAll('article[data-testid="tweet"]');
    for (const art of articles) {
      // Filtrar: solo tweets del usuario objetivo (case-insensitive)
      const userLink = art.querySelector(`a[href]`);
      let isTarget = false;
      // Buscar TODOS los links que apuntan a /USUARIO (perfil) dentro del artículo
      const allLinks = art.querySelectorAll('a[href]');
      for (const a of allLinks) {
        const href = (a.getAttribute('href') || '').toLowerCase();
        // Path exacto /usuario o /usuario/status/...
        if (href === '/' + TARGET_USER || href.startsWith('/' + TARGET_USER + '/status/')) {
          isTarget = true;
          break;
        }
      }
      if (!isTarget) continue;
      // ID del tweet
      const linkStatus = art.querySelector(`a[href*="/${TARGET_USER}/status/" i], a[href*="/status/"]`);
      if (!linkStatus) continue;
      const m = (linkStatus.getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (!m) continue;
      const id = m[1];
      if (seen.has(id)) continue;
      // Datos
      const time = art.querySelector('time');
      const datetime = time ? time.getAttribute('datetime') : null;
      const textEl = art.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText.replace(/\s+/g, ' ').trim() : '';
      seen.set(id, {
        id, datetime, text,
        user: TARGET_USER,
        line: detectarLinea(text),
        kind: detectarTipo(text),
        stations: extraerEstaciones(text),
        hashtags: extraerHashtags(text)
      });
      nuevos++;
    }
    return nuevos;
  }

  // ─── Scroll loop ─────────────────────────────────────────────────
  let iters = 0;
  while (!stop && stableIters < STABLE_LIMIT && iters < MAX_ITERS) {
    iters++;
    const nuevos = extractVisible();
    $count.textContent = `${seen.size} tweets`;
    $status.textContent = `Iter ${iters} · +${nuevos} nuevos · ${stableIters}/${STABLE_LIMIT} sin cambios`;
    if (nuevos === 0) stableIters++; else stableIters = 0;
    window.scrollBy({ top: window.innerHeight * 0.85, behavior: 'instant' });
    await new Promise(r => setTimeout(r, SCROLL_DELAY_MS));
  }

  $status.textContent = stop ? 'Detenido por usuario.' : 'Completado.';

  // ─── Exportar ────────────────────────────────────────────────────
  function exportar() {
    const tweets = Array.from(seen.values()).sort((a, b) => (a.datetime || '').localeCompare(b.datetime || ''));
    const json = JSON.stringify(tweets, null, 2);
    _lastJson = json;
    // DESCARGAR (esto siempre funciona)
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const fechaIni = tweets[0]?.datetime?.slice(0, 10) || 'inicio';
    const fechaFin = tweets[tweets.length - 1]?.datetime?.slice(0, 10) || 'fin';
    const a = document.createElement('a');
    a.href = url;
    a.download = `${TARGET_USER}_${fechaIni}_a_${fechaFin}_${tweets.length}tw.json`;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
    // CLIPBOARD: intentar, pero NO depender (Chrome bloquea si foco está en DevTools)
    navigator.clipboard.writeText(json).then(
      () => { $status.innerHTML = `✅ ${tweets.length} tweets · descargado y copiado`; },
      (err) => {
        $status.innerHTML = `✅ ${tweets.length} tweets · descargado.<br>⚠ Click en 📋 Copiar para portapapeles.`;
        $copy.style.display = 'inline-block';
      }
    );
    // Resumen en consola
    const porLinea = tweets.reduce((acc, t) => { const k = t.line || '?'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    const porTipo  = tweets.reduce((acc, t) => { const k = t.kind || '?'; acc[k] = (acc[k] || 0) + 1; return acc; }, {});
    console.log('═══════════════════════════════════════════');
    console.log(`✅ ${tweets.length} tweets de @${TARGET_USER}`);
    if (tweets.length) console.log(`📅 Rango: ${tweets[0].datetime}  →  ${tweets[tweets.length-1].datetime}`);
    console.log('🚇 Por línea:', porLinea);
    console.log('📊 Por tipo:', porTipo);
    console.log('═══════════════════════════════════════════');
  }

  exportar();
  setTimeout(() => { delete window.__xTweetExtractor; }, 1000);
})();
