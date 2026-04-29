/* canuto-dolar-live.js
 * Cotizaciones del dólar en vivo, compartidas entre /dolar-en-vivo y /dolar-historico.
 *
 * Diseño:
 * - Una sola fuente de verdad por origen: cache en localStorage compartido entre todas
 *   las pestañas/páginas de canuto.ar. Mientras una cotización está fresca (<25s), todas
 *   las páginas leen lo mismo.
 * - Freeze fuera de horario de mercado: Lun-Vie 07:00-17:00 ARG (excluyendo feriados),
 *   las cotizaciones se mueven (se aceptan updates con fechaActualizacion >=); de 17:01
 *   a 07:00 quedan congeladas en el último valor visto. Política de "máxima fechaActualizacion
 *   por casa": un valor viejo nunca pisa uno nuevo, ni en horario ni fuera.
 * - Banner "Mercado abierto" del UI: 10:30-17:00 lun-vie no feriado (más estricto que el
 *   freeze; el oficial / blue / mayorista pueden moverse desde antes pero el banner
 *   reserva ese rótulo a la rueda bursátil).
 * - MEP y CCL: antes de las 10:30 ARG quedan congeladas en el cierre del último día hábil
 *   (sus valores del freeze NO se actualizan aunque la API devuelva algo). A las 10:30
 *   empiezan a aceptar updates en vivo.
 * - Seed inicial: si el navegador nunca tuvo freeze (primer load) traemos el último
 *   cierre histórico desde argentinadatos.com para que MEP/CCL pre-10:30 tengan algo
 *   coherente desde el primer pintado.
 * - Fuente del minorista BNA: el "oficial" se toma SÓLO de dolarapi.com/v1/dolares
 *   (scraping del Banco Nación). No se mezcla con Ámbito ni con bluelytics, así nunca
 *   se inyecta un valor que no sea del BNA.
 * - Calendario de feriados: argentinadatos.com/v1/feriados + Día del Bancario hardcodeado.
 *
 * API pública (window.CanutoDolar):
 *   fetchLiveCotizaciones()  → Promise<Array> ({casa, _tipo, compra, venta, fechaActualizacion, _frozen?})
 *   isHorarioMercado()       → bool  (07:00-17:00 lun-vie no feriado, define _frozen general)
 *   isMercadoBanner()        → bool  (10:30-17:00 lun-vie no feriado, para el banner UI)
 *   esDiaHabilArg(date)      → bool
 */
(() => {
  'use strict';

  const API          = 'https://dolarapi.com/v1/dolares';
  const API_AMBITO   = 'https://dolarapi.com/v1/ambito/dolares';
  const API_BLY      = 'https://api.bluelytics.com.ar/v2/latest';
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

  const CASAS = ['oficial', 'blue', 'bolsa', 'contadoconliqui', 'mayorista'];

  // Mapeo casa→tipo: dolarapi expone "bolsa" y "contadoconliqui" pero las páginas
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

  function _masReciente(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ta = a.fechaActualizacion ? new Date(a.fechaActualizacion).getTime() : 0;
    const tb = b.fechaActualizacion ? new Date(b.fechaActualizacion).getTime() : 0;
    return ta >= tb ? a : b;
  }

  function _merge(dataPrin, dataAmb, dataBly) {
    const out = [];
    for (const casa of CASAS) {
      const dPrin = dataPrin?.find(x => x.casa === casa) || null;
      const dAmb  = dataAmb?.find(x  => x.casa === casa) || null;

      let mejor;
      if (casa === 'oficial') {
        // Minorista BNA: SÓLO se actualiza con la cotización del BNA. La fuente
        // BNA es dolarapi.com/v1/dolares (dataPrin); no mergeamos con Ámbito ni
        // con bluelytics porque eso podría inyectar un "oficial" que ya no es
        // del Banco Nación. Si dataPrin falla, oficial queda stale (freeze)
        // hasta que la fuente vuelva.
        mejor = dPrin;
      } else {
        mejor = _masReciente(dPrin, dAmb);
        if (!mejor && dataBly && casa === 'blue' && dataBly.blue?.value_sell) {
          mejor = {
            casa,
            compra: dataBly.blue.value_buy,
            venta:  dataBly.blue.value_sell,
            fechaActualizacion: dataBly.last_update,
            nombre: 'Blue',
            _fuente: 'bluelytics',
          };
        }
      }
      if (mejor) out.push({ ...mejor, casa, _tipo: CASA_TO_TIPO[casa] || casa });
    }
    return out;
  }

  function _tsOf(s) {
    if (!s) return 0;
    const t = new Date(s).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // Política de freeze:
  //   1) Por casa, sólo aceptamos un valor nuevo si su fechaActualizacion >= la guardada.
  //      Así una respuesta vieja de la API jamás pisa un dato más reciente.
  //   2) MEP/CCL antes de las 10:30 ARG son intocables: no se actualiza el freeze para
  //      esas casas aunque la API devuelva algo. La idea es que muestren el cierre del
  //      último día hábil hasta que abra el mercado bursátil.
  //   3) La salida la armamos siempre desde el freeze (la "máxima fecha vista" por casa),
  //      así las cotizaciones nunca retroceden.
  //   4) _frozen=true en el output significa "este valor está fijo" y aplica:
  //        - para todas las casas cuando isHorarioMercado() es false
  //        - para MEP/CCL cuando aún no son las 10:30 ARG, aunque el freeze general esté abierto
  function _aplicarFreeze(merged) {
    const enHorario = isHorarioMercado();
    const mepCclOk  = _mepCclDisponible();
    const freeze = _read(KEY_FREEZE) || { dia: null, cotizaciones: {} };
    if (!freeze.cotizaciones || typeof freeze.cotizaciones !== 'object') {
      freeze.cotizaciones = {};
    }

    for (const cot of merged) {
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

    const mergedByCasa = {};
    for (const cot of merged) mergedByCasa[cot.casa] = cot;

    const out = [];
    for (const casa of CASAS) {
      const f = freeze.cotizaciones[casa];
      const baseCot = mergedByCasa[casa];
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

  // Seed del freeze cuando faltan casas. Trae el último cierre histórico desde
  // argentinadatos.com y lo mete como base. Sólo se ejecuta si hay casas faltantes,
  // y sólo escribe la casa que aún sigue faltando al momento de la respuesta (evita
  // pisar un valor que el flujo normal ya haya cargado en paralelo).
  let _seedPromise = null;
  async function _seedFreezeFromHistorico() {
    const freeze0 = _read(KEY_FREEZE) || { cotizaciones: {} };
    const cot0 = freeze0.cotizaciones || {};
    const casasFaltantes = CASAS.filter(c => !cot0[c]);
    if (!casasFaltantes.length) return;

    await Promise.all(casasFaltantes.map(async casa => {
      try {
        const res = await fetch(API_HIST(CASA_TO_HIST[casa]), { cache: 'no-store' });
        if (!res.ok) return;
        const serie = await res.json();
        if (!Array.isArray(serie)) return;
        // Último elemento con venta válida.
        let ultimo = null;
        for (let i = serie.length - 1; i >= 0; i--) {
          if (serie[i] && serie[i].venta > 0 && serie[i].fecha) { ultimo = serie[i]; break; }
        }
        if (!ultimo) return;
        const fechaIso = `${String(ultimo.fecha).slice(0, 10)}T17:00:00-03:00`;
        // Releer el freeze ahora: puede que el flujo normal ya haya escrito.
        const cur = _read(KEY_FREEZE) || { cotizaciones: {} };
        if (!cur.cotizaciones) cur.cotizaciones = {};
        if (cur.cotizaciones[casa]) return; // alguien ya escribió, no pisar
        cur.cotizaciones[casa] = {
          compra: ultimo.compra,
          venta:  ultimo.venta,
          fechaActualizacion: fechaIso,
        };
        _write(KEY_FREEZE, cur);
      } catch { /* silencioso */ }
    }));
  }

  function _kickoffSeed() {
    if (_seedPromise) return _seedPromise;
    const freeze = _read(KEY_FREEZE) || { cotizaciones: {} };
    const cot = freeze.cotizaciones || {};
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
    // Si el freeze no tiene todas las casas, traemos el último cierre histórico
    // antes de hacer el fetch live. Sólo bloquea la primera carga del navegador.
    await _kickoffSeed();

    const shared = _read(KEY_SHARED);
    if (shared && (Date.now() - shared.ts) < SHARED_TTL_MS && Array.isArray(shared.merged)) {
      return shared.merged;
    }

    if (_inflight) return _inflight;

    _inflight = (async () => {
      try {
        const [resPrin, resAmb, resBly] = await Promise.allSettled([
          fetch(API,        { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(API_AMBITO, { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
          fetch(API_BLY,    { cache: 'no-store' }).then(r => r.ok ? r.json() : null),
        ]);
        const dataPrin = resPrin.status === 'fulfilled' ? resPrin.value : null;
        const dataAmb  = resAmb.status  === 'fulfilled' ? resAmb.value  : null;
        const dataBly  = resBly.status  === 'fulfilled' ? resBly.value  : null;
        if (!dataPrin && !dataAmb && !dataBly) {
          if (shared && Array.isArray(shared.merged)) return shared.merged;
          throw new Error('Todas las fuentes fallaron');
        }

        const merged = _merge(dataPrin, dataAmb, dataBly);
        const final = _aplicarFreeze(merged);

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
