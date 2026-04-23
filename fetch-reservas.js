const https = require('https');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.ESTADISTICASBCRA_TOKEN;
const OUT_DIR = path.join(__dirname, 'reservas-y-deuda', 'data');
const OUT_FILE = path.join(OUT_DIR, 'reservas.json');

if (!TOKEN) { console.error('Falta token'); process.exit(1); }

https.get('https://api.estadisticasbcra.com/reservas', {
  headers: { 'Authorization': 'BEARER ' + TOKEN, 'Accept': 'application/json' }
}, res => {
  let body = '';
  res.on('data', d => body += d);
  res.on('end', () => {
    const data = JSON.parse(body);
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(data));
    console.log('OK:', data.length, 'registros. Ultimo:', data[data.length-1].d);
  });
}).on('error', e => { console.error(e.message); process.exit(1); });
