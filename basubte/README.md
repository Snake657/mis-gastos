# BASubte Extractor

Pipeline para extraer y analizar los tweets de [@basubte](https://x.com/basubte) (servicio del Subte de CABA).

## Cómo usar el extractor

1. **Abrir X y buscar.** Ir a `https://x.com/search?q=from:basubte&f=live`. Para acotar usá los operadores avanzados:
   - `from:basubte línea b since:2024-01-01 until:2024-02-01`
   - `from:basubte línea d`
   - `from:basubte premetro since:2025-01-01`

   El parámetro **`f=live`** (o "Más reciente" en la UI) ordena cronológicamente; sin esto X devuelve los tweets "destacados" y mezcla orden.

2. **Esperar a que carguen los primeros tweets** (1-2 segundos).

3. **Abrir la consola del navegador.** `F12` → solapa `Console`.

4. **Pegar el contenido completo de `basubte_extractor.js`** y dar Enter.

5. **Mirar el panel flotante** arriba a la derecha. Va a auto-scrollear y mostrar el contador. Termina solo cuando X ya no carga más tweets, o lo cortás manualmente con el botón `STOP`.

6. **Al terminar:**
   - Se descarga un JSON con nombre `basubte_<fecha_ini>_a_<fecha_fin>_<N>tw.json`
   - El JSON queda copiado al portapapeles
   - La consola muestra resumen: cantidad por línea, por tipo, rango de fechas

## Formato del JSON exportado

```json
[
  {
    "id": "1678853468570697730",
    "datetime": "2023-07-11T19:47:13.000Z",
    "text": "#Subte Línea B | Servicio con demora.",
    "line": "B",
    "kind": "inicio_demora",
    "stations": null,
    "hashtags": ["#subte"]
  }
]
```

Campos:
- `kind`:
  - `inicio_demora` — "Servicio con demora"
  - `inicio_limitado` — "Servicio limitado entre estaciones X y Y"
  - `inicio_estacion_cerrada` — "Los trenes no se detienen en la estación X"
  - `inicio_interrumpido` — "Servicio interrumpido / sin servicio"
  - `fin` — "Servicio normalizado" / "Ya realiza recorrido completo" / "Ya se detienen en todas"
  - `info_operativa` — "Horario extendido", obras, etc. (no es incidente)
  - `otro` — texto que no matchea ninguno

## Tips

- **Dividir queries grandes en ventanas mensuales.** X corta en ~1000 resultados, no más. Para 2024-2026 necesitás varias corridas.
- **Si X muestra captcha o "rate limit"**, parar, esperar 5 min, seguir.
- **Re-correr es seguro.** El script genera un nuevo JSON cada vez; no toca tu cuenta.
- **Los archivos descargados quedan en tu carpeta de Descargas.** Después se mueven a `canuto.ar/basubte/raw/` para procesarlos.

## Próximos pasos del pipeline

1. Bajar tweets por línea/mes (este extractor)
2. Consolidar en un único JSON ordenado cronológicamente
3. Parear inicios↔fines para inferir incidentes con duración (ya tenemos parser en sample)
4. Generar dataset agregado: cantidad/duración por línea, mes, día semana, hora
5. Visualizar en `/datos-macro/` o como sección/tool nueva en canuto.ar
