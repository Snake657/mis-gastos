# canuto-subte (Cloudflare Worker)

Worker que polea cada 5 minutos la API GTFS-RT de GCBA (`/subtes/serviceAlerts`) y reconstruye incidentes del subte porteño:
- Cuando aparece una alerta nueva → la registra como **incidente activo**.
- Cuando una alerta deja de aparecer → la **cierra**, guarda duración y la archiva en histórico.

Expone los datos en `/data.json` con CORS abierto para que `canuto.ar/subte/` los consuma.

## Estructura

```
workers/canuto-subte/
├── src/index.js      # código del worker (cron + HTTP)
├── wrangler.toml     # config de Cloudflare (cron, KV bindings)
├── package.json
└── README.md
```

## Deploy paso a paso

> ⚠️ **No tengo acceso a tu cuenta de Cloudflare**, así que el deploy lo hacés vos.
> Si ya deployaste `canuto-riesgo` y `canuto-reservas` el flujo es el mismo.

### 1. Instalar wrangler (una sola vez por máquina)

```bash
npm install -g wrangler
wrangler login
```

### 2. Posicionarse en la carpeta del worker

```bash
cd workers/canuto-subte
npm install   # opcional, instala wrangler local
```

### 3. Crear los KV namespaces

```bash
wrangler kv namespace create ACTIVAS
wrangler kv namespace create HISTORICOS
```

Cada comando te imprime algo como:

```
🌀 Creating namespace with title "canuto-subte-ACTIVAS"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "ACTIVAS", id = "abc123def456..." }
```

Copiá los **id** y pegalos en `wrangler.toml` reemplazando `REPLACE_ME_ACTIVAS_ID` y `REPLACE_ME_HISTORICOS_ID`.

### 4. Cargar las credenciales de GCBA como secrets

```bash
wrangler secret put GCBA_CLIENT_ID
# (te pide pegar) → 9eb90794b8584ac8af740e157a88d746

wrangler secret put GCBA_CLIENT_SECRET
# (te pide pegar) → f78D44fb84Fa4DF18c0834f12779030c
```

(Opcional, solo si querés disparar polleos manualmente vía POST):
```bash
wrangler secret put ADMIN_KEY
# (te pide pegar) → algún string random largo
```

### 5. Deploy

```bash
wrangler deploy
```

Te va a imprimir la URL del worker, algo como:
```
https://canuto-subte.<tu-subdomain>.workers.dev
```

### 6. Probar

```bash
curl https://canuto-subte.<tu-subdomain>.workers.dev/status
curl https://canuto-subte.<tu-subdomain>.workers.dev/data.json | jq
```

`/status` debería responder de inmediato (aunque `last_poll` va a estar `null` hasta que pase el primer cron, ~5 min).

Para forzar un poll antes del primer cron, podés disparar manualmente con el ADMIN_KEY:
```bash
curl -X POST -H "x-admin-key: <tu admin key>" https://canuto-subte.<tu-subdomain>.workers.dev/poll
```

### 7. Decirme la URL

Una vez que esté deployado, pasame la URL final del worker para que la cablee en `/subte/index.html`.

## Endpoints

| Endpoint     | Método | Descripción |
|--------------|--------|-------------|
| `/data.json` | GET    | Devuelve `{generated_at, last_poll, activas[], cerrados[], total_historicos}` con CORS abierto. |
| `/status`    | GET    | Diagnóstico simple: cuántas alertas hay activas, cuándo fue el último poll, etc. |
| `/poll`      | POST   | Fuerza un ciclo de polling (requiere header `x-admin-key`). Útil para testing. |

## Schema de cada incidente

```jsonc
{
  "id": "Alert_LineaA",                    // id que usa GCBA en GTFS-RT
  "first_seen": "2026-05-10T14:00:00.000Z",
  "first_seen_ms": 1778760000000,
  "last_seen": "2026-05-10T14:25:00.000Z",
  "last_seen_ms": 1778761500000,
  "linea": "A",                            // A/B/C/D/E/H/P
  "tipo": "inicio_demora",                 // inicio_demora | inicio_limitado | inicio_estacion_cerrada | inicio_interrumpido | info_operativa | otro
  "cause": 3,
  "cause_label": "TECHNICAL_PROBLEM",
  "effect": 3,
  "effect_label": "SIGNIFICANT_DELAYS",
  "text": "Servicio con demora por inconveniente operativo.",
  "header": "Línea A",
  "route_ids": ["LineaA"],

  // estos sólo aparecen cuando ya se cerró:
  "cerrado_at": "2026-05-10T14:30:00.000Z",
  "cerrado_at_ms": 1778761800000,
  "duration_ms": 1800000,
  "duration_min": 30
}
```

## Cómo funciona el matching (re-window)

Si una alerta `Alert_LineaA` desaparece y vuelve a aparecer **dentro de los 30 minutos**, se considera el mismo incidente y se "re-abre" extendiéndole `last_seen` (no se duplica). Pasados los 30 min, vuelve a contar como un incidente nuevo.

Esto evita que un parpadeo de la API rompa la duración real del incidente.

## Límites

- **Histórico:** se guardan los últimos 5000 incidentes cerrados. Los más viejos se borran automáticamente.
- **Cap de duración:** un incidente no puede durar más de 4 horas (si la alerta queda colgada en GCBA, se trunca para no inflar promedios).
- **Granularidad:** como pollea cada 5 min, la duración tiene precisión de ±5 min.

## Costos

- Cron: cada 5 min = 288 invocaciones/día = ~8.6k/mes. Plan free: hasta 100k/día.
- KV: ~5 reads + ~5 writes por ciclo = ~3k ops/día. Plan free: 100k reads/día, 1k writes/día — apretado pero suficiente.
- Si llegás al límite de writes free, conviene subir al plan paid ($5/mes).

## Troubleshooting

**`fetchSnapshot fail: GCBA API 401`**
→ Las credenciales no se cargaron bien. Re-ejecutá `wrangler secret put GCBA_CLIENT_ID` y `wrangler secret put GCBA_CLIENT_SECRET`.

**`/data.json` devuelve `activas: []` y `cerrados: []` después de varias horas**
→ Ver `wrangler tail` para ver los logs de los crons. Es probable que la API de GCBA esté caída o que no haya alertas en este momento.

**No corre el cron**
→ Verificá en el dashboard de Cloudflare → Workers → canuto-subte → Triggers que aparezca el cron `*/5 * * * *`.
