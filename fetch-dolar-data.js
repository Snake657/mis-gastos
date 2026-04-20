#!/usr/bin/env node
/**
 * fetch-dolar-data.js
 * ─────────────────────────────────────────────────────────────
 * Descarga el histórico de cotizaciones del dólar desde
 * ArgentinaDatos API (gratuita, open source, MIT) y guarda
 * los datos como archivos JSON estáticos en /dolar-historico/data/
 *
 * USO:
 *   node fetch-dolar-data.js
 *
 * Se puede correr:
 *   - Una vez para obtener el histórico completo
 *   - Periódicamente (cron semanal/mensual) para mantenerlo actualizado
 *
 * INSTALACIÓN: No requiere dependencias externas (usa fetch nativo de Node 18+)
 * ─────────────────────────────────────────────────────────────
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CONFIG ─────────────────────────────────────────────────
const API_BASE = 'https://api.argentinadatos.com/v1/cotizaciones/dolares/';

const TIPOS = [
  { id: 'oficial',          apiKey: 'oficial',          label: 'Dólar Oficial' },
  { id: 'blue',             apiKey: 'blue',             label: 'Dólar Blue' },
  { id: 'bolsa',            apiKey: 'bolsa',            label: 'Dólar MEP / Bolsa' },
  { id: 'contadoconliqui',  apiKey: 'contadoconliqui',  label: 'Dólar CCL' },
  // Opcionales — descomentá si los querés también:
  // { id: 'mayorista',     apiKey: 'mayorista',         label: 'Dólar Mayorista' },
  // { id: 'tarjeta',       apiKey: 'tarjeta',           label: 'Dólar Tarjeta' },
  // { id: 'cripto',        apiKey: 'cripto',            label: 'Dólar Cripto' },
];

// Carpeta donde se guardan los JSON (relativa a este script)
// El script vive en /dolar-historico/ → data/ queda en /dolar-historico/data/
const OUTPUT_DIR = path.join(__dirname, 'data');
// ── FIN CONFIG ─────────────────────────────────────────────

// ── HELPERS ────────────────────────────────────────────────
function log(msg) {
  const now = new Date().toLocaleTimeString('es-AR');
  console.log(`[${now}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, maxRetries = 3, delayMs = 1500) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'canuto.ar/dolar-historico (data collection)' }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      if (i < maxRetries - 1) {
        log(`  ⚠  Error (intento ${i+1}/${maxRetries}): ${err.message}. Reintentando…`);
        await sleep(delayMs * (i + 1));
      } else {
        throw err;
      }
    }
  }
}

function normalizeData(data) {
  // Normaliza y ordena por fecha; filtra entradas sin fecha o valores null
  return data
    .filter(d => d.fecha && (d.venta != null || d.compra != null))
    .map(d => ({
      fecha: d.fecha.slice(0, 10), // solo YYYY-MM-DD
      compra: d.compra ?? null,
      venta: d.venta ?? null,
    }))
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
}

function mergeData(existing, fresh) {
  // Combina datos existentes con los frescos, sin duplicados, ordenado
  const map = new Map();
  for (const d of existing) map.set(d.fecha, d);
  for (const d of fresh)    map.set(d.fecha, d); // fresh sobreescribe
  return Array.from(map.values()).sort((a, b) => a.fecha.localeCompare(b.fecha));
}

// ── MAIN ───────────────────────────────────────────────────
async function main() {
  console.log('\n🇦🇷  Canuto.ar — Descarga de datos históricos del dólar');
  console.log('────────────────────────────────────────────────────────');
  console.log(`📂  Destino: ${OUTPUT_DIR}\n`);

  // Crear carpeta si no existe
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    log(`Carpeta creada: ${OUTPUT_DIR}`);
  }

  const results = [];

  for (const tipo of TIPOS) {
    const filePath = path.join(OUTPUT_DIR, `${tipo.apiKey}.json`);
    log(`📥  Descargando ${tipo.label}…`);

    try {
      const fresh = await fetchWithRetry(`${API_BASE}${tipo.apiKey}`);
      const normalizedFresh = normalizeData(fresh);

      let finalData;

      if (fs.existsSync(filePath)) {
        // Merge con datos existentes
        const existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        finalData = mergeData(existing, normalizedFresh);
        const newCount = finalData.length - existing.length;
        log(`  ✓  ${tipo.apiKey}.json actualizado — ${finalData.length} registros (+${newCount} nuevos)`);
      } else {
        finalData = normalizedFresh;
        log(`  ✓  ${tipo.apiKey}.json creado — ${finalData.length} registros`);
      }

      // Guardar
      fs.writeFileSync(filePath, JSON.stringify(finalData, null, 0));
      results.push({ tipo: tipo.label, count: finalData.length, status: 'ok' });

      // Pausa entre requests para no sobrecargar la API
      if (tipo !== TIPOS[TIPOS.length - 1]) await sleep(500);

    } catch (err) {
      log(`  ✗  Error con ${tipo.label}: ${err.message}`);
      results.push({ tipo: tipo.label, count: 0, status: `error: ${err.message}` });
    }
  }

  // ── RESUMEN ──
  console.log('\n────────────────────────────────────────────────────────');
  console.log('📊  Resumen:\n');
  for (const r of results) {
    const icon = r.status === 'ok' ? '✅' : '❌';
    console.log(`  ${icon}  ${r.tipo.padEnd(25)} ${r.count > 0 ? r.count + ' registros' : r.status}`);
  }

  // ── METADATA ──
  const metaPath = path.join(OUTPUT_DIR, 'meta.json');
  const meta = {
    lastUpdated: new Date().toISOString(),
    source: 'https://argentinadatos.com',
    license: 'MIT',
    tipos: results.map(r => ({ tipo: r.tipo, status: r.status, count: r.count }))
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  console.log('\n✅  Listo. Archivos en:', OUTPUT_DIR);
  console.log('   Incluí la carpeta /data/ en tu repo para datos estáticos.');
  console.log('   Corré este script periódicamente para mantenerlos actualizados.\n');
}

main().catch(err => {
  console.error('Error fatal:', err);
  process.exit(1);
});
