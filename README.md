# DENUE Data Analysis

Extractor y analizador de datos del **Directorio Estadístico Nacional de Unidades Económicas (DENUE)** del INEGI, implementado en TypeScript.

> **Fuente:** API live INEGI DENUE v1 — `/app/api/denue/v1/consulta/`. La API no expone metadatos de versión/snapshot; siempre devuelve la publicación corriente. Validado contra el conteo oficial de INEGI por estado (verificación manual vía https://www.inegi.org.mx/app/mapa/denue/).

---

## Versión actual: v0.1 — DENUE Base

El código en este repositorio corresponde a la **v0.1**: analizador DENUE base. Cubre extracción, carga, análisis y API queryable sobre datos DENUE en aislamiento.

La integración de fuentes externas (Censo 2020, CONEVAL, CE 2024, CLUES, SESNSP, Datatur, SINAIS, ENOE) se documenta en la hoja de ruta de versiones futuras (ver sección **Hoja de Ruta** abajo).

---

## Estado del proyecto (v0.1)

| Fase interna | Descripción                                                     | Estado        |
| ------------ | --------------------------------------------------------------- | ------------- |
| 1            | Extractor paginado — cliente HTTP, reintentos, streaming        | ✅ Completado |
| 2            | Schema PostgreSQL + PostGIS, loader con upsert                  | ✅ Completado |
| 3            | Pipeline nacional reanudable (32 estados)                       | ✅ Completado |
| 4            | Pipeline de análisis y reportes (mat-views, clusters, coverage) | ✅ Completado |
| 5            | API interna queryable (Hono, X-Api-Key auth)                    | ✅ Completado |

---

## Hoja de Ruta — Versionado Semántico

La evolución del stack se organiza por **fuente de datos integrada**. Cada versión v0.2.x agrega una capa nueva al modelo analítico sin romper la API existente.

| Versión   | Fuentes                            | Descripción                                                                                 | Estimado      | Docs |
| --------- | ---------------------------------- | ------------------------------------------------------------------------------------------- | ------------- | ---- |
| **v0.1**  | DENUE                              | ✅ Baseline — extracción, carga, análisis y API. Farmacias y todos los verticales SCIAN     | ✅ Done       | este README |
| **v0.2.1**| Censo 2020 + CONEVAL               | PSINDER, P60YMAS, IRS sintético, IVAF v1/v2. Join por `cve_mun` y `cve_ageb`              | 1-2 días      | [fase-1-censo-coneval.md](docs/fase-1-censo-coneval.md) |
| **v0.2.2**| CE 2024 + CLUES + SESNSP           | Revenue sectorial, infraestructura médica, riesgo de seguridad. Score combinado Fase 2      | 2-3 días      | [fase-2-ce2024-clues-sesnsp.md](docs/fase-2-ce2024-clues-sesnsp.md) |
| **v0.2.3**| Datatur + SINAIS + ENOE + ENIGH    | Mortalidad crónica, turismo, calibradores regionales (ENOE/ENIGH). Score final acumulado   | 1-2 días      | [fase-3-detalle.md](docs/fase-3-detalle.md) |
| **v0.3**  | Modo Mapa                          | Frontend geoespacial: MapLibre + deck.gl sobre la API v0.2.x                               | 2-3 días      | TBD |
| **v0.4**  | Modo Locust                        | Visualización analítica: ECharts (barras, radar, scatter 3D). Paralelo a v0.3              | 2-3 días      | TBD |

**Total realista: ~10-12 días de trabajo activo** para stack funcional y refinable (v0.4).

### Lógica de versiones

- `v0.1.x` — parches y fixes sobre el extractor/API base
- `v0.2.x` — cada `.x` es una fuente de datos nueva integrada al pipeline
- `v0.3+` — capa de presentación (frontend) sobre la API estable

---

## Descripción

El DENUE es el directorio más completo de establecimientos económicos en México. Este proyecto automatiza la extracción, transformación y persistencia de esos datos para inteligencia de negocios, segmentación de mercados y análisis geoespacial.

### Casos de uso implementados

- Extracción filtrada por estado, municipio y condición de búsqueda
- Pipeline nacional reanudable (32 estados, ~5.5M establecimientos)
- Análisis de densidad, cobertura y clustering por SCIAN
- Detección de hipersaturación y desiertos comerciales
- API HTTP interna con autenticación por API key

### Verticales analizados (v0.1)

| Vertical | SCIAN | Notas |
|---|---|---|
| Farmacias | 46591, 46592 | Farmacia sin/con consultorio |
| Hospitales y clínicas privadas | 621–623 | Candidato principal v0.2.1+ |
| Restaurantes / QSR | 722 | Relevante para Xolo Rides |
| Educación privada | 611 | Mercado mid-size |
| Conveniencia / abarrotes | 461 | Competencia OXXO |
| Gimnasios / fitness | 7139 | NSE alto |

### Validación end-to-end (2026-05-03)

```
Estado piloto: CDMX
Establecimientos extraídos: ~380,000
Carga Supabase: OK (upsert sin duplicados)
API test: GET /farmacias?estado=09 → 200 OK
Mat-views: mv_farmacias_enriched, mv_densidad_municipal
```

---

## Estructura

```
denue-data-analysis/
├── src/
│   ├── extractor/          # Cliente DENUE API + paginación
│   ├── loader/             # Upsert → Supabase/PostgreSQL
│   ├── analysis/           # Vistas materializadas, clusters, coverage
│   └── api/                # Hono HTTP server (Fase 5)
├── scripts/
│   ├── pipeline.ts         # Pipeline nacional reanudable
│   ├── load.ts             # Carga manual a Supabase
│   └── analyze.ts          # Correr análisis / mat-views
├── docs/                   # Documentación de fases de integración
│   ├── plan-integracion-datos-mexico.md
│   ├── fuentes-datos-gubernamentales.md
│   ├── fase-2-ce2024-clues-sesnsp.md
│   └── fase-3-detalle.md
├── tests/
├── data/
│   └── state/              # Estado del pipeline (qué estados ya están cargados)
├── env.example
├── package.json
└── tsconfig.json
```

---

## Instalación

```bash
npm install
cp env.example .env
# Editar .env con SUPABASE_URL, SUPABASE_SERVICE_KEY, DENUE_API_KEY
```

### Dependencias

| Paquete | Uso |
|---|---|
| `tsx` | Ejecución TypeScript sin compilación |
| `@supabase/supabase-js` | Cliente Supabase |
| `hono` + `@hono/node-server` | API HTTP (Fase 5) |
| `zod` | Validación de esquemas |
| `pino` | Logging estructurado |

---

## Configuración

```env
# .env
SUPABASE_URL=https://<proyecto>.supabase.co
SUPABASE_SERVICE_KEY=<service_role_key>
DENUE_API_KEY=<token_inegi>
API_KEY=<clave_para_api_interna>
PORT=3456
```

---

## Uso

### Extracción de un estado

```bash
npx tsx scripts/pipeline.ts --estado=09
# 09 = CDMX. Ver tabla de claves INEGI para otros estados.
```

### Pipeline nacional (todos los estados)

```bash
npx tsx --env-file=.env scripts/pipeline.ts --all
# Reanudable: guarda estado en data/state/pipeline-state.json
# Para forzar re-extracción: --force
```

Para pipelines de larga duración, usar tmux:

```bash
tmux new-session -d -s denue-national \
  "cd /root/claude/projects/data-intelligence/denue-data-analysis && \
   npx tsx --env-file=.env scripts/pipeline.ts --all 2>&1 | tee /tmp/denue-national.log"
```

### Carga manual a Supabase

```bash
npx tsx --env-file=.env scripts/load.ts --file=data/output/estado_09.jsonl
```

### API HTTP (v0.1 — Fase 5)

```bash
npx tsx --env-file=.env src/api/server.ts
```

Endpoints disponibles:

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/health` | Health check |
| `GET` | `/farmacias` | Lista farmacias filtradas por estado/municipio |
| `GET` | `/densidad` | Densidad por municipio (SCIAN + radio) |
| `GET` | `/clusters` | Clusters de hipersaturación |
| `GET` | `/desiertos` | Zonas sin cobertura por radio |
| `GET` | `/cobertura` | Score de cobertura por municipio |

Autenticación: header `X-Api-Key: <API_KEY>`.

### Tests

```bash
npm test                    # vitest run — suite completa
npm run typecheck           # tsc --noEmit
```

---

## Notas de implementación

### Interfaz canónica de la API (`DenueRawRecord`)

Todos los módulos de análisis consumen `DenueRawRecord` — no los tipos raw de la API INEGI. El extractor normaliza antes de persistir.

### Extracción de entidad

La API INEGI pagina por `registro_inicio` + `registro_fin`. El extractor mantiene checkpoint en `data/state/` para reanudar después de interrupciones.

### Formato de `Ubicacion`

`{ latitud: number, longitud: number }` — siempre números, nunca strings. La API INEGI devuelve strings; el extractor hace el cast.

### Throttle global de API

500ms entre requests por defecto (`DENUE_REQUEST_DELAY_MS`). Aumentar si la API INEGI devuelve 429.

### pageSize = 500

Máximo permitido por la API INEGI. Valores mayores se truncan silenciosamente a 500.

### Gotcha PostgREST

`upsert` con `onConflict: 'id_denue'` requiere que la columna tenga `UNIQUE` constraint, no solo `PRIMARY KEY`. Si el upsert silently ignora duplicados, verificar el constraint en Supabase.

### Filtro por municipio

La API INEGI acepta `municipio` como string de 5 dígitos (`cve_ent` + `cve_mun`). Ejemplo CDMX Benito Juárez: `"09014"`.

---

## Estimaciones de volumen (extracción nacional)

| Alcance | Establecimientos aprox. | Tiempo estimado |
|---|---|---|
| 1 estado (CDMX) | ~380,000 | ~45 min |
| 5 estados | ~1.5M | ~3-4 h |
| Nacional (32 estados) | ~5.5M | ~18-24 h |

Con tmux + checkpoint, el pipeline nacional es completamente desatendido.

---

## Fuente de datos

- **DENUE:** https://www.inegi.org.mx/servicios/api_denue.html
- **Documentación API:** https://www.inegi.org.mx/app/api/denue/v1/consulta/
- **Documentación de fases (v0.2.x+):** `docs/` en este repositorio

---

## Organización

Proyecto de inteligencia de datos. Uso interno.
Documentación de integración completa en `/root/claude/projects/data-intelligence/docs/`.
