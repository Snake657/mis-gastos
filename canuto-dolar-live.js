/* canuto-dolar-live.js
 * Cotizaciones del dólar en vivo, compartidas entre /dolar-en-vivo y /dolar-historico.
 *
 * Fuente única: el Cloudflare Worker `canuto-dolar` ya hace el merge server-side y
 * decide la fuente "correcta" para cada casa (BNA → bna.com.ar/Personas, blue →
 * bluelytics, MEP/CCL → Ámbito, mayorista → criptoya, etc.). El cliente sólo
 * consume ese endpoint, así nunca hay saltos entre fuentes en una misma casa.
 *
 * Diseño:
 * - Una sola fuente de verdad por origen: cache en localStorage compartido entre todas
 *   las pestañas/páginas de canuto.ar. Mientras una cotización está fresca (<25s), todas
 *   las páginas leen lo mismo.
 * - Freeze de mercado: el _aplicarFreeze sólo acepta updates dentro del horario
 *   de mercado (Lun-Vie 07:00-17:00 ARG, no feriados). Fuera de esa ventana las
 *   cards quedan congeladas en el último valor visto durante la rueda — la fuente
 *   puede seguir reportando precios post-cierre (informal a las 20:31, criptoya
 *   a las 23:00) pero ya no entran al freeze. Política "máxima fechaActualizacion
 *   por casa" dentro del horario: un valor viejo no pisa uno nuevo.
 * - Banner "Mercado abierto" del UI: 10:30-17:00 lun-vie no feriado (más estricto que el
 *   freeze; el oficial / blue / mayorista pueden moverse desde antes pero el banner
 *   reserva ese rótulo a la rueda bursátil).
 * - MEP y CCL: antes de las 10:30 ARG quedan congeladas en el cierre del último día hábil
 *   (sus valores del freeze NO se actualizan aunque la API devuelva algo). A las 10:30
 *   empiezan a aceptar updates en vivo.
 * - Seed inicial: si el navegador nunca tuvo freeze (primer load), llamamos primero
 *   al Worker `canuto-intraday` (que tiene los ticks intra-día acumulados) y tomamos
 *   el último tick cuya fechaActualizacion sea ≤17:00 ARG — eso es el "cierre real"
 *   de la rueda. Para casas sin ticks intra-horario, fallback a argentinadatos con
 *   el cierre del último día hábil.
 * - Calendario de feriados: argentinadatos.com/v1/feriados + Día del Bancario hardcodeado.
 *
 * API pública (window.CanutoDolar):
 *   fetchLiveCotizaciones()  → Promise<Array> ({casa, _tipo, compra, venta, fechaActualizacion, _frozen?, _source?})
 *   isHorarioMercado()       → bool  (07:00-17:00 lun-vie no feriado, define _frozen general)
 *   isMercadoBanner()        → bool  (10:30-17:00 lun-vie no feriado, para el banner UI)
 *   esDiaHabilArg(date)      → bool
 */
(() => {
  'use strict';

  // Endpoint único — el Worker `canuto-dolar` resuelve fuentes y entrega un array
  // `cotizaciones` ya mergeado, con un campo `_source` por casa indicando el origen.
  const API_DOLAR    = 'https://canuto-dolar.lenzimartin.workers.dev/api/dolar';
  // Worker propio que persiste ticks intra-día — usado para el seed inicial.
  const API_INTRADAY_TODAY = 'https://canuto-intraday.lenzimartin.workers.dev/today';
  const API_FERIADOS = (year) => `https://api.argentinadatos.com/v1/feriados/${year}`;
  const API_HIST     = (key)  => `https://api.argentinadatos.com/v1/cotizaciones/dolares/${key}`;

  const KEY_SHARED  = 'canuto.dolar.shared';
  const KEY_FREEZE  = 'canuto.dolar.freeze';
  const KEY_FERIADOS_PREFIX = 'canuto.feriados.';

  const SHARED_TTL_MS = 25 * 1000;
  const FERIADOS_TTL_MS = 24 * 3600 * 1000;

  // Ventana en la que el freeze deja pasar updates "en vivo".
  // Comparación inclusiva en ambos extremos: 07:00:00 abierto, 17:00:59 abierto, 17:01:00 cerrado.
  const HORA_APERTURA = 7;
  const MIN_APERTURA  = 0;
  const HORA_CIERRE   = 17;
  const MIN_CIERRE    = 0;

  // Ventana del banner "Mercado abierto" del UI (más estricta que el freeze).
  const HORA_BANNER_INI = 10;
  const MIN_BANNER_INI  = 30;

  // MEP / CCL recién aceptan updates a partir de esta hora ARG (apertura bursátil).
  // Antes de eso quedan congeladas en el cierre del último día hábil.
  const HORA_MEPCCL_INI = 10;
  const MIN_MEPCCL_INI  = 30;
  const CASAS_MEPCCL = ['bolsa', 'contadoconliqui'];

  // Casas que el cliente reconoce. Si el worker devuelve casas extra (p.ej. 'tarjeta'),
  // se ignoran porque las páginas no las pintan.
  const CASAS = ['oficial', 'blue', 'bolsa', 'contadoconliqui', 'mayorista'];

  // Mapeo casa→tipo: el worker expone "bolsa" y "contadoconliqui" pero las páginas
  // pintan tarjetas con id "mep" y "ccl", devolvemos las dos propiedades por compat.
  const CASA_TO_TIPO = {
    oficial: 'oficial',
    blue: 'blue',
    bolsa: 'mep',
    contadoconliqui: 'ccl',
    mayorista: 'mayorista',
  };

  // Mapeo casa→key del histórico de argentinadatos (para el seed inicial).
  const CASA_TO_HIST = {
    oficial: 'oficial',
    blue: 'blue',
    bolsa: 'bolsa',
    contadoconliqui: 'contadoconliqui',
    mayorista: 'mayorista',
  };

  const FERIADOS_BCRA_EXTRA_MMDD = ['11-06']; // Día del Bancario

  function _read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function _write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  function _ahoraArg() {
    const fmt = new Intl.DateTimeFormat('sv-SE', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(new Date());
    const m = {};
    for (const p of parts) m[p.type] = p.value;
    const ymd = `${m.year}-${m.month}-${m.day}`;
    const dow = new Date(`${ymd}T12:00:00`).getDay();
    return { ymd, hour: parseInt(m.hour, 10), minute: parseInt(m.minute, 10), dow };
  }

  // Devuelve los minutos del día (HH*60+MM) en hora ARG para un timestamp dado.
  function _minutosArgDe(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Argentina/Buenos_Aires',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = fmt.formatToParts(d);
    let hh = 0, mm = 0;
    for (const p of parts) {
      if (p.type === 'hour') hh = parseInt(p.value, 10);
      if (p.type === 'minute') mm = parseInt(p.value, 10);
    }
    return hh * 60 + mm;
  }

  // True si la fechaActualizacion cae dentro de la ventana de mercado (07:00-17:00 ARG).
  // Sirve al seed inicial para descartar ticks post-cierre que el cron pudo capturar.
  function _isFaIntraHorario(iso) {
    const mins = _minutosArgDe(iso);
    if (mins == null) return false;
    const minIni = HORA_APERTURA * 60 + MIN_APERTURA;
    const minFin = HORA_CIERRE * 60 + MIN_CIERRE;
    return mins >= minIni && mins <= minFin;
  }

  let _feriadosPromise = null;
  async function obtenerFeriados(year) {
    const key = KEY_FERIADOS_PREFIX + year;
    const cached = _read(key);
    if (cached && (Date.now() - cached.ts) < FERIADOS_TTL_MS && Array.isArray(cached.fechas)) {
      return new Set(cached.fechas);
    }
    try {
      const r = await fetch(API_FERIADOS(year), { cache: 'default' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const arr = await r.json();
      const fechas = arr
        .map(x => (x && x.fecha) ? String(x.fecha).slice(0, 10) : null)
        .filter(Boolean);
      for (const mmdd of FERIADOS_BCRA_EXTRA_MMDD) {
        fechas.push(`${year}-${mmdd}`);
      }
      _write(key, { ts: Date.now(), fechas });
      return new Set(fechas);
    } catch {
      const fechas = FERIADOS_BCRA_EXTRA_MMDD.map(mmdd => `${year}-${mmdd}`);
      return new Set(fechas);
    }
  }

  function _feriadosSync(year) {
    const cached = _read(KEY_FERIADOS_PREFIX + year);
    if (cached && Array.isArray(cached.fechas)) return new Set(cached.fechas);
    return null;
  }
  function _kickoffFeriados() {
    if (_feriadosPromise) return _feriadosPromise;
    const { ymd } = _ahoraArg();
    const year = parseInt(ymd.slice(0, 4), 10);
    _feriadosPromise = obtenerFeriados(year).catch(() => null);
    if (parseInt(ymd.slice(5, 7), 10) === 12) {
      obtenerFeriados(year + 1).catch(() => null);
    }
    return _feriadosPromise;
  }

  function esFeriadoArg(ymd) {
    const year = parseInt(ymd.slice(0, 4), 10);
    const set = _feriadosSync(year);
    return set ? set.has(ymd) : false;
  }

  function esDiaHabilArg(arg) {
    const ctx = arg || _ahoraArg();
    if (ctx.dow === 0 || ctx.dow === 6) return false;
    if (esFeriadoArg(ctx.ymd)) return false;
    return true;
  }

  function isHorarioMercado() {
    const ctx = _ahoraArg();
    if (!esDiaHabilArg(ctx)) return false;
    const minNow = ctx.hour * 60 + ctx.minute;
    const minIni = HORA_APERTURA * 60 + MIN_APERTURA;
    const minFin = HORA_CIERRE * 60 + MIN_CIERRE;
    return minNow >= minIni && minNow <= minFin;
  }

  // Banner "Mercado abierto" del UI: 10:30 a 17:00 lun-vie no feriado.
  function isMercadoBanner() {
    const ctx = _ahoraArg();
    if (!esDiaHabilArg(ctx)) return false;
    const minNow = ctx.hour * 60 + ctx.minute;
    const minIni = HORA_BANNER_INI * 60 + MIN_BANNER_INI;
    const minFin = HORA_CIERRE * 60 + MIN_CIERRE;
    return minNow >= minIni && minNow <= minFin;
  }

  // True si MEP/CCL ya pueden recibir updates en vivo (>= 10:30 ARG).
  // Antes de eso quedan congeladas con el último cierre conocido.
  function _mepCclDisponible() {
    const ctx = _ahoraArg();
    const minNow = ctx.hour * 60 + ctx.minute;
    const minIni = HORA_MEPCCL_INI * 60 + MIN_MEPCCL_INI;
    return minNow >= minIni;
  }

  // Filtra y normaliza la respuesta del worker `canuto-dolar`. Sólo nos quedamos con
  // las casas que las páginas pintan; la `tarjeta` u otras casas nuevas se ignoran.
  function _normalizarRespuestaWorker(payload) {
    if (!payload || !Array.isArray(payload.cotizaciones)) return [];
    const out = [];
    for (const c of payload.cotizaciones) {
      if (!c || !CASAS.includes(c.casa)) continue;
      if (c.venta == null) continue;
      out.push({
        casa: c.casa,
        _tipo: CASA_TO_TIPO[c.casa] || c.casa,
        compra: c.compra,
        venta:  c.venta,
        fechaActualizacion: c.fechaActualizacion,
        _source: c._source || null,
      });
    }
    return out;
  }

  function _tsOf(s) {
    if (!s) return 0;
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // Política de freeze:
  //   1) Sólo aceptamos updates dentro del horario de mercado (07:00-17:00 lun-vie no
  //      feriado). Fuera de esa ventana las cards quedan fijas en el último valor visto
  //      durante la rueda — sin esto, post-cierre las fechaActualizacion seguían avanzando
  //      con precios del informal/criptoya post-mercado (19:55, 20:31, etc.).
  //   2) En horario, por casa, sólo aceptamos un valor nuevo si su fechaActualizacion
  //      es >= a la guardada. Una respuesta vieja del worker nunca pisa una más reciente.
  //   3) MEP/CCL antes de las 10:30 ARG son intocables aunque estemos en horario:
  //      muestran el cierre del último día hábil hasta que abra el mercado bursátil.
  //   4) La salida la armamos siempre desde el freeze (la "máxima fecha vista" por casa).
  //   5) _frozen=true en el output significa "este valor está fijo" y aplica:
  //        - para todas las casas cuando isHorarioMercado() es false
  //        - para MEP/CCL cuando aún no son las 10:30 ARG
  function _aplicarFreeze(cotizaciones) {
    const enHorario = isHorarioMercado();
    const mepCclOk  = _mepCclDisponible();
    const freeze = _read(KEY_FREEZE) || { dia: null, cotizaciones: {} };
    if (!freeze.cotizaciones || typeof freeze.cotizaciones !== 'object') {
      freeze.cotizaciones = {};
    }

    for (const cot of cotizaciones) {
      // Fuera del horario de mercado (17:01-07:00, fines de semana, feriados) no
      // aceptamos updates: las cards quedan fijas en el último valor visto durante
      // la rueda. Sin esto las fechas seguían avanzando post-cierre (19:55, 20:31)
      // aunque los precios fueran del informal/criptoya post-mercado.
      if (!enHorario) continue;
      // No tocamos MEP/CCL antes de las 10:30: deben quedar pegadas al cierre anterior.
      if (CASAS_MEPCCL.includes(cot.casa) && !mepCclOk) continue;

      const prev = freeze.cotizaciones[cot.casa];
      const tNew = _tsOf(cot.fechaActualizacion);
      const tOld = _tsOf(prev && prev.fechaActualizacion);
      if (!prev || tNew >= tOld) {
        freeze.cotizaciones[cot.casa] = {
          compra: cot.compra,
          venta:  cot.venta,
          fechaActualizacion: cot.fechaActualizacion,
        };
      }
    }
    freeze.dia = _ahoraArg().ymd;
    _write(KEY_FREEZE, freeze);

    const cotByCasa = {};
    for (const cot of cotizaciones) cotByCasa[cot.casa] = cot;

    const out = [];
    for (const casa of CASAS) {
      const f = freeze.cotizaciones[casa];
      const baseCot = cotByCasa[casa];
      if (!f && !baseCot) continue;
      if (!f) {
        // No tenemos histórico en el freeze: usamos lo que vino crudo (puede ser la
        // primera carga del navegador). Para MEP/CCL pre-10:30 y para cualquier
        // casa fuera de horario, marcamos _frozen.
        const cot = { ...baseCot, _tipo: CASA_TO_TIPO[casa] || casa };
        if (!enHorario || (CASAS_MEPCCL.includes(casa) && !mepCclOk)) cot._frozen = true;
        out.push(cot);
        continue;
      }
      const cotFinal = {
        ...(baseCot || {}),
        casa,
        _tipo: CASA_TO_TIPO[casa] || casa,
        compra: f.compra,
        venta:  f.venta,
        fechaActualizacion: f.fechaActualizacion,
      };
      const mepCclCongelada = CASAS_MEPCCL.includes(casa) && !mepCclOk;
      if (!enHorario || mepCclCongelada) cotFinal._frozen = true;
      out.push(cotFinal);
    }
    return out;
  }

  // Para una serie de ticks `[{ts, fa, compra, venta, ...}, ...]` ordenada
  // ascendentemente, devuelve el último tick cuya fechaActualizacion (`fa`):
  //   1) cae dentro del horario de mercado (07:00-17:00 ARG), Y
  //   2) corresponde al día ARG actual.
  // Devuelve null si no hay ningún tick válido (p.ej. todos son post-cierre,
  // o todos arrastran fa de un día anterior, o el array está vacío). En esos
  // casos el seed cae al fallback de argentinadatos.
  function _ultimoTickIntraHorario(ticks) {
    if (!Array.isArray(ticks)) return null;
    const ymdActual = _ahoraArg().ymd;
    for (let i = ticks.length - 1; i >= 0; i--) {
      const t = ticks[i];
      if (!t || t.venta == null) continue;
      const iso = t.fa || t.ts;
      if (!_isFaIntraHorario(iso)) continue;
      const dt = new Date(iso);
      if (isNaN(dt.getTime())) continue;
      const tickYmd = dt.toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
      if (tickYmd !== ymdActual) continue;
      return t;
    }
    return null;
  }

  // Seed del freeze cuando faltan casas. Estrategia en dos pasos:
  //   1) Worker propio canuto-intraday/today: trae los ticks intra-día acumulados.
  //      Por cada casa con ticks tomamos el último cuya fechaActualizacion ≤17:00 ARG
  //      (cierre real de la rueda). Esto cubre el caso "primer load post-cierre del
  //      navegador" sin tener que mostrar valores post-mercado raros.
  //   2) Para casas que sigan faltando, fallback a argentinadatos con el cierre del
  //      último día hábil publicado (sirve para MEP/CCL pre-10:30 cuando todavía no
  //      hubo movimiento hoy, o para cualquier casa que el intraday no tenga).
  let _seedPromise = null;
  async function _seedFreezeFromHistorico() {
    const freeze0 = _read(KEY_FREEZE) || { cotizaciones: {} };
    const cot0 = freeze0.cotizaciones || {};
    let casasFaltantes = CASAS.filter(c => !cot0[c]);
    if (!casasFaltantes.length) return;

    // Paso 1 — canuto-intraday (un solo fetch, todas las casas a la vez).
    try {
      const res = await fetch(API_INTRADAY_TODAY, { cache: 'no-store' });
      if (res.ok) {
        const body = await res.json();
        const ticksPorCasa = (body && body.cotizaciones) || {};
        for (const casa of casasFaltantes.slice()) {
          const tick = _ultimoTickIntraHorario(ticksPorCasa[casa]);
          if (!tick) continue;
          const cur = _read(KEY_FREEZE) || { cotizaciones: {} };
          if (!cur.cotizaciones) cur.cotizaciones = {};
          if (cur.cotizaciones[casa]) continue; // alguien ya escribió, no pisar
          cur.cotizaciones[casa] = {
            compra: tick.compra,
            venta:  tick.venta,
            fechaActualizacion: tick.fa || tick.ts,
          };
          _write(KEY_FREEZE, cur);
        }
      }
    } catch { /* silencioso */ }

    // Paso 2 — fallback a argentinadatos para casas que sigan faltando.
    const freeze1 = _read(KEY_FREEZE) || { cotizaciones: {} };
    const cot1 = freeze1.cotizaciones || {};
    casasFaltantes = CASAS.filter(c => !cot1[c]);
    if (!casasFaltantes.length) return;

    await Promise.all(casasFaltantes.map(async casa => {
      try {
        const res = await fetch(API_HIST(CASA_TO_HIST[casa]), { cache: 'no-store' });
        if (!res.ok) return;
        const serie = await res.json();
        if (!Array.isArray(serie)) return;
        let ultimo = null;
        for (let i = serie.length - 1; i >= 0; i--) {
          if (serie[i] && serie[i].venta > 0 && serie[i].fecha) { ultimo = serie[i]; break; }
        }
        if (!ultimo) return;
        const fechaIso = `${String(ultimo.fecha).slice(0, 10)}T17:00:00-03:00`;
        const cur = _read(KEY_FREEZE) || { cotizaciones: {} };
        if (!cur.cotizaciones) cur.cotizaciones = {};
        if (cur.cotizaciones[casa]) return;
        cur.cotizaciones[casa] = {
          compra: ultimo.compra,
          venta:  ultimo.venta,
          fechaActualizacion: fechaIso,
        };
        _write(KEY_FREEZE, cur);
      } catch { /* silencioso */ }
    }));
  }

  // Devuelve la fecha ARG (YYYY-MM-DD) de un timestamp ISO. Sirve para detectar
  // si una cotización del freeze quedó pegada a un día anterior.
  function _faToYmdArg(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return d.toLocaleDateString('sv-SE', { timeZone: 'America/Argentina/Buenos_Aires' });
  }

  function _kickoffSeed() {
    if (_seedPromise) return _seedPromise;
    const freeze = _read(KEY_FREEZE) || { cotizaciones: {} };
    if (!freeze.cotizaciones || typeof freeze.cotizaciones !== 'object') {
      freeze.cotizaciones = {};
    }
    const ymdActual = _ahoraArg().ymd;

    // Si el freeze quedó pegado a un día anterior (caso típico: el navegador se
    // dejó abierto el 29 post-cierre y se vuelve a abrir el 30 post-cierre — la
    // regla "no actualizar fuera de horario" de _aplicarFreeze nunca se libera
    // porque enHorario=false), descartamos las cotizaciones cuya fechaActualizacion
    // sea de un día ARG anterior al actual. _seedFreezeFromHistorico repuebla con
    // los datos del día actual (canuto-intraday/today + fallback argentinadatos).
    if (freeze.dia && freeze.dia !== ymdActual) {
      let cambio = false;
      for (const casa of Object.keys(freeze.cotizaciones)) {
        const c = freeze.cotizaciones[casa];
        const faYmd = _faToYmdArg(c && c.fechaActualizacion);
        if (!faYmd || faYmd < ymdActual) {
          delete freeze.cotizaciones[casa];
          cambio = true;
        }
      }
      if (cambio) {
        freeze.dia = ymdActual;
        _write(KEY_FREEZE, freeze);
        // Como cambiamos el freeze, también invalidamos el shared cache (TTL 25s):
        // si quedó un snapshot viejo cacheado, se va a regenerar en el próximo fetch.
        try { localStorage.removeItem(KEY_SHARED); } catch {}
      }
    }

    const cot = freeze.cotizaciones;
    const hayFaltantes = CASAS.some(c => !cot[c]);
    if (!hayFaltantes) {
      _seedPromise = Promise.resolve();
      return _seedPromise;
    }
    _seedPromise = _seedFreezeFromHistorico().catch(() => null);
    return _seedPromise;
  }

  let _inflight = null;

  async function fetchLiveCotizaciones() {
    _kickoffFeriados();
    await _kickoffSeed();

    const shared = _read(KEY_SHARED);
    if (shared && (Date.now() - shared.ts) < SHARED_TTL_MS && Array.isArray(shared.merged)) {
      return shared.merged;
    }

    if (_inflight) return _inflight;

    _inflight = (async () => {
      try {
        let payload = null;
        try {
          const r = await fetch(API_DOLAR, { cache: 'no-store' });
          if (r.ok) payload = await r.json();
        } catch { /* silencioso */ }

        if (!payload) {
          if (shared && Array.isArray(shared.merged)) return shared.merged;
          throw new Error('Worker canuto-dolar no respondió');
        }

        const cotizaciones = _normalizarRespuestaWorker(payload);
        const final = _aplicarFreeze(cotizaciones);

        _write(KEY_SHARED, { ts: Date.now(), merged: final });
        return final;
      } finally {
        _inflight = null;
      }
    })();

    return _inflight;
  }

  window.CanutoDolar = {
    fetchLiveCotizaciones,
    isHorarioMercado,
    isMercadoBanner,
    esDiaHabilArg,
    obtenerFeriados,
    _ahoraArg,
    _mepCclDisponible,
    _readShared: () => _read(KEY_SHARED),
    _readFreeze: () => _read(KEY_FREEZE),
    _clearFreeze: () => { localStorage.removeItem(KEY_FREEZE); localStorage.removeItem(KEY_SHARED); _seedPromise = null; },
  };

  _kickoffFeriados();
  _kickoffSeed();
})();
