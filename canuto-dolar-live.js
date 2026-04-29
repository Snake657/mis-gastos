/* canuto-dolar-live.js
 * Cotizaciones del dólar en vivo, compartidas entre /dolar-en-vivo y /dolar-historico.
 *
 * Diseño:
 * - Una sola fuente de verdad por origen: cache en localStorage compartido entre todas
 *   las pestañas/páginas de canuto.ar. Mientras una cotización está fresca (<25s), todas
 *   las páginas leen lo mismo.
 * - Freeze fuera de horario de mercado: Lun-Vie 07:00-17:30 ARG (excluyendo feriados),
 *   las cotizaciones se mueven; fuera de eso quedan congeladas en el último valor del día
 *   hábil. El freeze se reinicia al inicio del próximo día hábil.
 * - Calendario de feriados: argentinadatos.com/v1/feriados + Día del Bancario hardcodeado.
 *
 * API pública (window.CanutoDolar):
 *   fetchLiveCotizaciones()  → Promise<Array> ({casa, _tipo, compra, venta, ...})
 *   isHorarioMercado()       → bool
 *   esDiaHabilArg(date)      → bool
 */
(() => {
  'use strict';

  const API          = 'https://dolarapi.com/v1/dolares';
  const API_AMBITO   = 'https://dolarapi.com/v1/ambito/dolares';
  const API_BLY      = 'https://api.bluelytics.com.ar/v2/latest';
  const API_FERIADOS = (year) => `https://api.argentinadatos.com/v1/feriados/${year}`;

  const KEY_SHARED  = 'canuto.dolar.shared';
  const KEY_FREEZE  = 'canuto.dolar.freeze';
  const KEY_FERIADOS_PREFIX = 'canuto.feriados.';

  const SHARED_TTL_MS = 25 * 1000;
  const FERIADOS_TTL_MS = 24 * 3600 * 1000;

  const HORA_APERTURA = 7;
  const MIN_APERTURA  = 0;
  const HORA_CIERRE   = 17;
  const MIN_CIERRE    = 30;

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
    return minNow >= minIni && minNow < minFin;
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
      let mejor = _masReciente(dPrin, dAmb);
      if (!mejor && dataBly && (casa === 'oficial' || casa === 'blue')) {
        const k = casa === 'oficial' ? 'oficial' : 'blue';
        if (dataBly[k]?.value_sell) {
          mejor = {
            casa,
            compra: dataBly[k].value_buy,
            venta:  dataBly[k].value_sell,
            fechaActualizacion: dataBly.last_update,
            nombre: casa.charAt(0).toUpperCase() + casa.slice(1),
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

  // Política única de freeze, válida dentro y fuera de horario:
  //   1) Por casa, sólo aceptamos un valor nuevo en el freeze si su fechaActualizacion
  //      es >= a la última conocida. Así, si la API devuelve momentáneamente una
  //      respuesta vieja (típico cuando mayorista/MEP/CCL ya cerraron y la fuente
  //      aún no rota al snapshot del día siguiente), no pisamos un dato bueno.
  //   2) La salida la construimos siempre desde el freeze (la "máxima fecha vista"
  //      por casa). De esta forma las cotizaciones jamás retroceden a un valor
  //      viejo, ni durante el horario ni después del cierre.
  //   3) _frozen se marca sólo cuando estamos fuera de horario: las páginas usan
  //      ese flag para mostrar "Mercado cerrado · cotizaciones fijadas".
  function _aplicarFreeze(merged) {
    const ctx = _ahoraArg();
    const enHorario = isHorarioMercado();
    const freeze = _read(KEY_FREEZE) || { dia: null, cotizaciones: {} };
    if (!freeze.cotizaciones || typeof freeze.cotizaciones !== 'object') {
      freeze.cotizaciones = {};
    }

    for (const cot of merged) {
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
    freeze.dia = ctx.ymd;
    _write(KEY_FREEZE, freeze);

    const mergedByCasa = {};
    for (const cot of merged) mergedByCasa[cot.casa] = cot;

    const out = [];
    for (const casa of CASAS) {
      const f = freeze.cotizaciones[casa];
      const baseCot = mergedByCasa[casa];
      if (!f && !baseCot) continue;
      if (!f) {
        out.push({ ...baseCot, _tipo: CASA_TO_TIPO[casa] || casa });
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
      if (!enHorario) cotFinal._frozen = true;
      out.push(cotFinal);
    }
    return out;
  }

  let _inflight = null;

  async function fetchLiveCotizaciones() {
    _kickoffFeriados();

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
    esDiaHabilArg,
    obtenerFeriados,
    _ahoraArg,
    _readShared: () => _read(KEY_SHARED),
    _readFreeze: () => _read(KEY_FREEZE),
    _clearFreeze: () => { localStorage.removeItem(KEY_FREEZE); localStorage.removeItem(KEY_SHARED); },
  };

  _kickoffFeriados();
})();
