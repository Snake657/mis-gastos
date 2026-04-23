const https = require('https');
const fs   = require('fs');
const path = require('path');

const OUT_DIR  = path.join(__dirname, 'reservas-y-deuda', 'data');
const OUT_FILE = path.join(OUT_DIR, 'reservas.json');
const BASE = 'https://apis.datos.gob.ar/series/api/series/?ids=92.2_RESERVAS_IRES_0_0_32_40&limit=1000&sort=desc&format=json';

function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Accept': 'application/json' } }, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        if (res.statusCode !== 200) reject(new Error('HTTP ' + res.statusCode));
        else resolve(JSON.parse(body));
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('Descargando reservas desde datos.gob.ar...');
  const [r1, r2, r3] = await Promise.all([
    get(BASE + '&start=0'),
    get(BASE + '&start=1000'),
    get(BASE + '&start=2000'),
  ]);
  const raw = [...(r3.data||[]), ...(r2.data||[]), ...(r1.data||[])];
  const data = raw
    .filter(([,v]) => v !== null)
    .map(([d,v]) => ({ d, v }))
    .sort((a,b) => a.d.localeCompare(b.d));
  console.log(data.length + ' registros. Ultimo: ' + data[data.length-1].d);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(data));
  console.log('OK: ' + OUT_FILE);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
