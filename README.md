# 📈 Dólar Histórico — canuto.ar

Sección de consulta de cotizaciones históricas del dólar en Argentina.
Tipos soportados: **Oficial, Blue, MEP (Bolsa) y CCL**.

---

## Estructura de archivos

```
dolar-historico/
├── index.html              ← La página (self-contained, sin dependencias npm)
├── fetch-dolar-data.js     ← Script para descargar/actualizar los datos
└── data/                   ← Datos estáticos (se genera con el script)
    ├── oficial.json
    ├── blue.json
    ├── bolsa.json
    ├── contadoconliqui.json
    └── meta.json
```

---

## Primera vez — descargar el histórico completo

```bash
# Desde la carpeta dolar-historico/
node fetch-dolar-data.js
```

Requiere **Node 18+** (usa `fetch` nativo). No tiene dependencias npm.

El script crea la carpeta `data/` con los JSON históricos.
Al terminar muestra un resumen con cuántos registros descargó por tipo.

---

## Cómo funciona la página

1. **Intenta cargar datos locales** desde `./data/{tipo}.json`
2. **Si los datos locales existen y tienen más de 1 día de antigüedad**, hace un fetch live a ArgentinaDatos y mergea los datos nuevos
3. **Si no hay datos locales** (ej: primera visita sin haber corrido el script), cae directo a la API live

→ Con los JSON en el repo, el 99% del histórico carga instantáneamente desde la CDN. Solo los últimos días se piden en vivo.

---

## Mantener los datos actualizados

Opciones según cómo esté deployado canuto.ar:

### Opción A — Manual (más simple)
Correr el script localmente y hacer commit de los JSON actualizados:
```bash
node fetch-dolar-data.js
git add data/
git commit -m "actualizar datos dolar $(date +%Y-%m-%d)"
git push
```

### Opción B — GitHub Action (automatizado)
Crear `.github/workflows/update-dolar.yml`:
```yaml
name: Actualizar datos dólar
on:
  schedule:
    - cron: '0 9 * * 1'  # Lunes 9am UTC (6am Argentina)
  workflow_dispatch:

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - run: node dolar-historico/fetch-dolar-data.js
      - uses: stefanzweifel/git-auto-commit-action@v5
        with:
          commit_message: "data: actualizar cotizaciones dólar"
          file_pattern: 'dolar-historico/data/*.json'
```

### Opción C — Vercel/Netlify build hook
Agregar en el build command:
```
node dolar-historico/fetch-dolar-data.js && <tu-build-command>
```

---

## Fuente de datos

[ArgentinaDatos API](https://argentinadatos.com) — open source (MIT), sin API key, gratuita.
- `GET https://api.argentinadatos.com/v1/cotizaciones/dolares/oficial`
- `GET https://api.argentinadatos.com/v1/cotizaciones/dolares/blue`
- `GET https://api.argentinadatos.com/v1/cotizaciones/dolares/bolsa`
- `GET https://api.argentinadatos.com/v1/cotizaciones/dolares/contadoconliqui`

Respuesta: `[{ fecha, compra, venta, moneda, casa }]`

---

## Agregar al landing de canuto.ar

En el HTML del landing, en la sección de herramientas:

```html
<div class="tool-card">
  <span class="status-dot available"></span>
  <h3>📈 Dólar Histórico</h3>
  <p>Oficial, Blue, MEP y CCL — cotizaciones diarias desde 2003. Gráficos y tabla.</p>
  <a href="/dolar-historico/" class="btn">Ver historial</a>
</div>
```
