# canuto-intraday Worker

Acumula la cotización intra-día del dólar para que `/dolar-historico` pueda dibujar
un gráfico del día actual sin depender de que la pestaña del usuario esté abierta.

## Deploy

1. **Crear KV namespace**: dashboard de Cloudflare → Workers & Pages → KV →
   *Create namespace* → nombre `canuto-intraday-kv`.

2. **Crear el Worker**: Workers & Pages → *Create application* → *Create Worker*
   → nombre `canuto-intraday`.

3. **Pegar el código** de `worker.js` en el editor del Worker. Deploy.

4. **Bindear el KV**: Settings → Variables → KV Namespace Bindings →
   - Variable name: `INTRADAY`
   - KV namespace: `canuto-intraday-kv`

5. **Configurar el Cron Trigger**: Settings → Triggers → Cron Triggers →
   *Add Cron Trigger* → expresión `* * * * *` (cada minuto).

## Endpoints

- `GET https://canuto-intraday.lenzimartin.workers.dev/` → metadatos.
- `GET https://canuto-intraday.lenzimartin.workers.dev/today` → serie del día actual ARG.
- `GET https://canuto-intraday.lenzimartin.workers.dev/YYYY-MM-DD` → serie de un día específico.

CORS abierto (`Access-Control-Allow-Origin: *`).

## Estructura de respuesta

```json
{
  "ymd": "2026-04-29",
  "cotizaciones": {
    "oficial": [{ "ts": "...", "fa": "...", "compra": 1365, "venta": 1415, "_source": "bna" }],
    "blue":    [...],
    "bolsa":   [...],
    "contadoconliqui": [...],
    "mayorista": [...]
  }
}
```

`ts` es el momento server-side en que el cron registró el cambio.
`fa` es la fechaActualizacion que reportó la fuente original.
