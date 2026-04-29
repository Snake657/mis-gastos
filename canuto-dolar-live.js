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
 *   fetchLiveCotizaciones()  → Promise<Array>  (merged como dolarapi: {casa, compra, venta, ...})
 *   isHorarioMercado()       → bool
 *   esDiaHabilArg(date)      → bool
 */
(() => {
  'use strict';

  // ── Endpoints ────────────────────────────────────────────────────────────
  const API          = 'https://dolarapi.com/v1/dolares';
  const API_AMBITO   = 'https://dolarapi.com/v1/ambito/dolares';
  const API_BLY      = 'https://api.bluelytics.com.ar/v2/latest';
  const API_FERIADOS = (year) => `https://api.argentinadatos.com/v1/feriados/${year}`;

  // ── Storage keys ─────────────────────────────────────────────────────────
  const KEY_SHARED  = 'canuto.dolar.shared';   // último merge servido (TTL ~25s)
  const KEY_FREEZE  = 'canuto.dolar.freeze';   // últimos valores intra-día hábil
  const KEY_FERIADOS_PREFIX = 'canuto.feriados.'; // canuto.feriados.2026 → array

  // ── Tunables ─────────────────────────────────────────────────────────────
  const SHARED_TTL_MS = 25 * 1000;   // 25s: tiempo en que un fetch sirve a todas las páginas
  const FERIADOS_TTL_MS = 24 * 3600 * 1000; // los feriados no cambian, refresh diario

  // Hora de cierre del mercado argentino (BYMA/MAE):
  //  - Apertura: 07:00 ARG (cotizaciones empiezan a moverse)
  //  - Cierre:   17:30 ARG (a partir de ahí, congelamos)
  const HORA_APERTURA = 7;   // 07:00
  const MIN_APERTURA  = 0;
  const HORA_CIERRE   = 17;  // 17:30
  const MIN_CIERRE    = 30;

  // Casas de las distintas APIs - mantenemos el mismo esquema que dolarapi
  const CASAS = ['oficial', 'blue', 'bolsa', 'contadoconliqui', 'mayorista'];

  // BCRA-específicos no incluidos en feriados nacionales (formato MM-DD para repetir cada año)
  const FERIADOS_BCRA_EXTRA_MMDD = [
    '11-06', // Día del Bancario
  ];

  // ── Storage helpers ──────────────────────────────────────────────────────
  function _read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  }
  function _write(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch {}
  }

  // ── Tiempo Argentina ─────────────────────────────────────────────────────
  // Devuelve { ymd: 'YYYY-MM-DD', hour, minute, dow } (dow: 0=dom, 6=sab)
  function _ahoraArg() {
    // 'sv-SE' es el locale que devuelve YYYY-MM-DD HH:MM:SS
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
    return {
      ymd,
      hour: parseInt(m.hour, 10),
      minute: parseInt(m.minute, 10),
      dow,
    };
  }

  // ── Feriados ─────────────────────────────────────────────────────────────
  // Fetchea + cachea por año. Devuelve Set('YYYY-MM-DD').
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
      // Sumar feriados BCRA-específicos
      for (const mmdd of FERIADOS_BCRA_EXTRA_MMDD) {
        fechas.push(`${year}-${mmdd}`);
      }
      _write(key, { ts: Date.now(), fechas });
      return new Set(fechas);
    } catch {
      // Fallback: solo los BCRA extra
      const fechas = FERIADOS_BCRA_EXTRA_MMDD.map(mmdd => `${year}-${mmdd}`);
      return new Set(fechas);
    }
  }

  // Pre-carga feriados del año actual para que las consultas síncronas (esDiaHabilArg)
  // funcionen sin depender del fetch. Si no están aún cargados, asume hábil.
  function _feriadosSync(year) {
    const cached = _read(KEY_FERIADOS_PREFIX + year);
    if (cached && Array.isArray(cached.fechas)) return new Set(cached.fechas);
    return null; // no cargado todavía
  }
  // Disparar la carga al cargar el script
  function _kickoffFeriados() {
    if (_feriadosPromise) return _feriadosPromise;
    const { ymd } = _ahoraArg();
    const year = parseInt(ymd.slice(0, 4), 10);
    _feriadosPromise = obtenerFeriados(year).catch(() => null);
    // También el año siguiente si estamos en diciembre (por si cruzamos año)
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
    // arg puede ser un objeto { ymd, dow } o no pasarse (usa "ahora")
    const ctx = arg || _ahoraArg();
    if (ctx.dow === 0 || ctx.dow === 6) return false; // sab/dom
    if (esFeriadoArg(ctx.ymd)) return false;
    return true;
  }

  // True si estamos dentro del horario de mercado: día hábil + hora entre 07:00 y 17:30
  function isHorarioMercado() {
    const ctx = _ahoraArg();
    if (!esDiaHabilArg(ctx)) return false;
    const minNow = ctx.hour * 60 + ctx.minute;
    const minIni = HORA_APERTURA * 60 + MIN_APERTURA;
    const minFin = HORA_CIERRE * 60 + MIN_CIERRE;
    return minNow >= minIni && minNow < minFin;
  }

  // ── "Más reciente" según fechaActualizacion ──────────────────────────────
  function _masReciente(a, b) {
    if (!a) return b;
    if (!b) return a;
    const ta = a.fechaActualizacion ? new Date(a.fechaActualizacion).getTime() : 0;
    const tb = b.fechaActualizacion ? new Date(b.fechaActualizacion).getTime() : 0;
    return ta >= tb ? a : b;
  }

  // Mezcla la respuesta de las 3 fuentes en un array uniforme
  // {casa, compra, venta, fechaActualizacion, _fuente}
  function _merge(dataPrin, dataAmb, dataBly) {
    // dataPrin / dataAmb son arrays con .casa
    const out = [];
    for (const casa of CASAS) {
      const dPrin = dataPrin?.find(x => x.casa === casa) || null;
      const dAmb  = dataAmb?.find(x  => x.casa === casa) || null;
      let mejor = _masReciente(dPrin, dAmb);
      // Bluelytics tiene oficial y blue
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
      if (mejor) out.push({ ...mejor, casa });
    }
    return out;
  }

  // ── Freeze ───────────────────────────────────────────────────────────────
  // Estructura del freeze:
  //   { dia: 'YYYY-MM-DD', cotizaciones: { oficial: {compra, venta, fechaActualizacion}, ... } }
  // El freeze se actualiza con el último valor visto durante el horario de mercado.
  // Fuera de horario, devolvemos el freeze (sin importar lo que diga la API).
  function _aplicarFreeze(merged) {
    const ctx = _ahoraArg();
    const enHorario = isHorarioMercado();
    const diaHabil  = esDiaHabilArg(ctx);
    let freeze = _read(KEY_FREEZE) || { dia: null, cotizaciones: {} };

    // Si cambió el día hábil (osea: hubo al menos un mercado abierto entre el dia guardado y hoy),
    // reseteamos el freeze. Para simplificar: si freeze.dia distinto del último día hábil
    // que hubo, resetear. En la práctica: si entramos en horario de mercado y el día es nuevo,
    // arrancamos limpio.
    if (enHorario && freeze.dia !== ctx.ymd) {
      freeze = { dia: ctx.ymd, cotizaciones: {} };
    }

    if (enHorario) {
      // Mercado abierto: aprovechar para guardar el último valor de cada casa
      for (const cot of merged) {
        freeze.cotizaciones[cot.casa] = {
          compra: cot.compra,
          venta:  cot.venta,
          fechaActualizacion: cot.fechaActualizacion,
        };
      }
      freeze.dia = ctx.ymd;
      _write(KEY_FREEZE, freeze);
      return merged;
    }

    // Mercado cerrado (post-17:30, fin de semana, o feriado).
    // Si el freeze tiene datos, usarlos. Si no, los datos actuales se "fijan" al freeze
    // (caso: el usuario abre por primera vez después de 17:30 y no tenemos histórico).
    const usarFreeze = freeze.cotizaciones && Object.keys(freeze.cotizaciones).length > 0;
    if (usarFreeze) {
      const out = merged.map(cot => {
        const f = freeze.cotizaciones[cot.casa];
        if (!f) return cot;
        return { ...cot, compra: f.compra, venta: f.venta, fechaActualizacion: f.fechaActualizacion, _frozen: true };
      });
      // Asegurar que toda casa que tenemos en freeze pero no vino del API también esté en out
      for (const casa of CASAS) {
        if (!out.find(x => x.casa === casa) && freeze.cotizaciones[casa]) {
          const f = freeze.cotizaciones[casa];
          out.push({ casa, compra: f.compra, venta: f.venta, fechaActualizacion: f.fechaActualizacion, _frozen: true });
        }
      }
      return out;
    }

    // No hay freeze previo: usamos el snapshot actual y lo guardamos como freeze.
    // El día asignado al freeze depende: si es fin de semana o feriado, asignamos el día actual
    // (al volver mercado abierto se reseteará); si estamos post-cierre del mismo día, idem.
    const nuevoFreeze = { dia: diaHabil ? ctx.ymd : (freeze.dia || ctx.ymd), cotizaciones: {} };
    for (const cot of merged) {
      nuevoFreeze.cotizaciones[cot.casa] = {
        compra: cot.compra,
        venta:  cot.venta,
        fechaActualizacion: cot.fechaActualizacion,
      };
    }
    _write(KEY_FREEZE, nuevoFreeze);
    return merged.map(c => ({ ...c, _frozen: true }));
  }

  // ── Fetch principal ──────────────────────────────────────────────────────
  let _inflight = null; // promise compartida si dos llamadas simultáneas

  async function fetchLiveCotizaciones() {
    // Disparar carga de feriados si aún no
    _kickoffFeriados();

    // Cache compartido entre páginas vía localStorage
    const shared = _read(KEY_SHARED);
    if (shared && (Date.now() - shared.ts) < SHARED_TTL_MS && Array.isArray(shared.merged)) {
      return shared.merged;
    }

    // Evitar múltiples fetches en paralelo dentro de la misma página
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
          // Si todas las APIs fallan, intentar devolver la última cosa que sirvió
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

  // ── Exponer ──────────────────────────────────────────────────────────────
  window.CanutoDolar = {
    fetchLiveCotizaciones,
    isHorarioMercado,
    esDiaHabilArg,
    obtenerFeriados,
    // Exponemos para debugging desde DevTools, no son API pública
    _ahoraArg,
    _readShared: () => _read(KEY_SHARED),
    _readFreeze: () => _read(KEY_FREEZE),
    _clearFreeze: () => { localStorage.removeItem(KEY_FREEZE); localStorage.removeItem(KEY_SHARED); },
  };

  // Disparar la carga inicial de feriados sin esperar
  _kickoffFeriados();
})();
