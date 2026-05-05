# DENUE Data Analysis

Extractor y analizador de datos del **Directorio Estadístico Nacional de Unidades Económicas (DENUE)** del INEGI, implementado en TypeScript.

> **Fuente:** API live INEGI DENUE v1 — `/app/api/denue/v1/consulta/`. La API no expone metadatos de versión/snapshot; siempre devuelve la publicación corriente. Validado contra el conteo oficial de INEGI por estado (verificación manual vía https://www.inegi.org.mx/app/mapa/denue/).

---

## Versión actual: v0.3 P3 — Locust + Map mode + Risk surface backend

**Live**: <https://uncharted.eurekamd.cloud/> (Caddy + LE TLS + dist/ + gzip + immutable cache, systemd-managed via `denue-analyzer.service`).

Backend v0.1 + v0.2.1 + v0.2.2 + v0.2.3-A cargados en producción (**7 fuentes joinables por `cve_mun` 5-char**: DENUE × Censo 2020 × CONEVAL Pobreza × CONEVAL IRS × CLUES × CE 2024 × EDR mortalidad 2024, plus SESNSP RNID Delitos Municipal 2015–2026 como capa de riesgo operacional). El analyzer (`web/`) tiene **dos modos** sobre el mismo dataset:

- **Locust mode**: 5 charts ECharts (mosaico nacional treemap, sector × IRS heatmap, top sectores bar, densidad-vs-pobreza scatter, CLUES vs farmacias por 100k) + 4 endpoints comerciales (`/analytics/national-treemap`, `/sector-grade-matrix`, `/municipios`, `/top-sectors`).
- **Map mode**: MapLibre + Carto Positron/Dark Matter basemap, vector source sobre `/tiles/:z/:x/:y.mvt` con heatmap (zoom <14) + circles (zoom ≥11) y deck.gl `ScatterplotLayer` overlay para cluster centroids cuando entidad+sector están seleccionados. Click en punto → detalle del establecimiento via `/establishment/:clee`.
- **Risk surface (backend only, sin UI todavía)**: 2 endpoints SESNSP — `/analytics/risk-summary?entidad=NN[&ano=&baseline_ano=]` (perfil per-municipio con totales por subtipo + per-1k normalización + cambio % vs baseline) y `/analytics/risk-trend?cve_mun=NNNNN` (serie mensual ~135 puntos 2015–2026 Mar). Mat-view `mv_delitos_municipal_yearly` con fallback gracioso a agregación live si la MV no existe. El default `ano` se resuelve al arranque desde `MAX(ano)` con todos los 12 meses reportados (audit W5, 2026-05-05) — rollover automático cuando la siguiente carga de diciembre cierre el año. UI integration es la siguiente conversación.

v0.2.3-A **shipped 2026-05-05**: EDR mortalidad 2024 (819,672 deaths registered, 809,063 con residencia válida en 2,472 municipios). Mat-view `mv_mortalidad_municipal_yearly` + 2 endpoints (`/analytics/mortality-summary`, `/analytics/mortality-trend`) con cause-of-death breakdown CIE-10 (circulatorio, neoplasias, endocrinas, externas, infantil) y tasa cruda por 1k habitantes. `currentMortalityAno` resuelto al boot vía `MAX(ano) WHERE COUNT >= 100k` para evitar lag-artifact years como default.

v0.2.3 restante: **Datatur** = mixed (~50/70 destinos direct-join post-crosswalk; ~20 calibradores zonales) — pendiente crosswalk. **ENOE + ENIGH** = calibradores estatales — parameter tables keyed por entidad que entran a endpoints existentes vía `LEFT JOIN`. Patrón general: fuentes que no joinan a `cve_mun` no se descartan; condicionan / multiplican / contextualizan las filas municipales. Plan completo en [`docs/v0.2.3-plan.md`](docs/v0.2.3-plan.md).

---

## Estado del proyecto

### v0.1 (DENUE base) — ✅ Completo

| Fase interna | Descripción                                                     | Estado        |
| ------------ | --------------------------------------------------------------- | ------------- |
| 1            | Extractor paginado — cliente HTTP, reintentos, streaming        | ✅ Completado |
| 2            | Schema PostgreSQL + PostGIS, loader con upsert                  | ✅ Completado |
| 3            | Pipeline nacional reanudable (32 estados)                       | ✅ Completado |
| 4            | Pipeline de análisis y reportes (mat-views, clusters, coverage) | ✅ Completado |
| 5            | API interna queryable (Hono, X-Api-Key auth)                    | ✅ Completado |

### v0.2.1 (Censo 2020 + CONEVAL) — ✅ Cerrado a nivel municipal

| Tier | Descripción                                                                                   | Estado                                                                    |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | Backfill `area_geo` (CVE_MUN_5) + SCIAN ids (×5) desde el CLEE — desbloquea joins municipales | ✅ Completado                                                             |
| 2    | Backfill `ageb` (CVEGEO 13-char) vía spatial join contra polígonos AGEB urbana del MGN 2020   | ✅ Completado                                                             |
| 2.5  | Polígonos ENT/MUN/LOC/AGEB cargados a PostGIS (mapa base + futuros joins espaciales)          | ✅ Completado                                                             |
| —    | Censo 2020 ITER: 195k filas × 286 cols + view `censo_municipios` (14 cols, pobtot/pea/etc.)   | ✅ Completado                                                             |
| —    | CONEVAL Pobreza Municipal: % pobreza/extrema, vulnerabilidad, 6 carencias, línea de pobreza   | ✅ Completado                                                             |
| —    | CONEVAL IRS Municipal: índice + grado + rezago educativo/salud/calidad-vivienda × 7           | ✅ Completado                                                             |
| —    | AGEB-level Censo (RESAGEBURB) y rezago social AGEB                                            | ⏳ Pendiente — portal CONEVAL/INEGI cerrado, requiere asistencia operador |

### v0.2.2 (CE 2024 + CLUES + SESNSP) — ✅ Completo

| Sub | Descripción                                                                                                                                                                                                | Estado                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| —   | **CLUES** (DGIS Catálogo Establecimientos de Salud, ene-2026): 63,708 raw → 41,381 EN OPERACION → 39,946 (96.5%) geocodificadas. `clues` materialized view con cve_mun + cve_loc + geom POINT(4326) + GIST | ✅ Completado                                                                         |
| —   | **CE 2024** (Censo Económico INEGI): 32 state ZIPs → `ce2024_municipal` MV con 1.80M filas (sector × estrato × municipio), métricas UE/personal/valor agregado/remuneraciones/ingresos                     | ✅ Completado 2026-05-05                                                              |
| —   | **SESNSP RNID** (Incidencia Delictiva 2015–2026 Mar): 31.6M filas long-form en `sesnsp_delitos_municipal` + `mv_delitos_municipal_yearly` (28k filas pre-roll) + 2 endpoints `/analytics/risk-*`           | ✅ Completado 2026-05-05 (sólo Delitos Municipal — Estatal y Víctimas se descartaron) |

---

## Hoja de Ruta — Versionado Semántico

La evolución del stack se organiza por **fuente de datos integrada**. Cada versión v0.2.x agrega una capa nueva al modelo analítico sin romper la API existente.

| Versión        | Fuentes                  | Descripción                                                                                                  | Estado              | Docs                                                                |
| -------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------- | ------------------------------------------------------------------- |
| **v0.1**       | DENUE                    | Baseline — extracción, carga, análisis y API. Farmacias y todos los verticales SCIAN                         | ✅ Done             | este README                                                         |
| **v0.2.1**     | Censo 2020 + CONEVAL     | ITER municipal + Pobreza/IRS municipal. Join por `cve_mun`. AGEB-level pendiente                             | ✅ Done (municipal) | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.2**     | CE 2024 + CLUES + SESNSP | Revenue sectorial, infraestructura médica, riesgo de seguridad. Score combinado Fase 2                       | ✅ Done             | [fase-2-ce2024-clues-sesnsp.md](docs/fase-2-ce2024-clues-sesnsp.md) |
| **v0.2.3-A**   | EDR mortalidad 2024      | 819,672 deaths × cve_mun + cause-of-death breakdown + tasa por 1k. Mat-view + 2 endpoints + boot resolver    | ✅ Done             | [v0.2.3-plan.md](docs/v0.2.3-plan.md)                               |
| **v0.2.3-B/C** | Datatur + ENOE + ENIGH   | ENOE + ENIGH calibradores estatales (LEFT JOIN entidad); Datatur diferido por crosswalk destino↔cve_mun      | 📋 Plan listo       | [v0.2.3-plan.md](docs/v0.2.3-plan.md)                               |
| **v0.3 P2**    | Locust mode (analyzer)   | 5 charts ECharts (treemap, heatmap, top sectores, scatter, salud) + 4 endpoints `/analytics/*`               | ✅ Done             | [analyzer-plan-v1.md](docs/analyzer-plan-v1.md)                     |
| **v0.3 P3**    | Map mode (analyzer)      | MapLibre + Carto basemap + MVT vector source (heatmap + circles) + deck.gl cluster overlay + click-to-detail | ✅ Done             | [analyzer-plan-v1.md](docs/analyzer-plan-v1.md)                     |
| **v0.3 P4**    | Deploy                   | analyzer.denue.net via Caddy + Let's Encrypt                                                                 | 📋 Planned          | [analyzer-plan-v1.md](docs/analyzer-plan-v1.md)                     |

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
- Pipeline nacional reanudable (32 entidades, ~6.1M establecimientos)
- Análisis de densidad, cobertura y clustering por SCIAN
- Detección de hipersaturación y desiertos comerciales
- API HTTP interna con autenticación por API key
- **v0.2.1**: análisis cruzado DENUE × Censo 2020 × CONEVAL Pobreza × IRS — densidad comercial vs pobreza/educación/infraestructura por municipio
- **v0.2.1**: tiles vectoriales (`ST_AsMVT`) listos para frontend de mapa
- **v0.2.2**: proximidad espacial DENUE × CLUES — `ST_DWithin` para "farmacias dentro de 2km de una unidad médica pública" + ratios CLUES-por-100k para detectar desiertos de salud
- **v0.3 P3**: navegación geográfica del dataset — heatmap de densidad zoom-out, puntos individuales clickables zoom-in, filtros entidad+sector cascadean a la URL del MVT, cluster centroids superpuestos cuando ambos filtros están activos

### Verticales analizados (v0.1)

| Vertical                       | SCIAN        | Notas                        |
| ------------------------------ | ------------ | ---------------------------- |
| Farmacias                      | 46591, 46592 | Farmacia sin/con consultorio |
| Hospitales y clínicas privadas | 621–623      | Candidato principal v0.2.1+  |
| Restaurantes / QSR             | 722          | Relevante para Xolo Rides    |
| Educación privada              | 611          | Mercado mid-size             |
| Conveniencia / abarrotes       | 461          | Competencia OXXO             |
| Gimnasios / fitness            | 7139         | NSE alto                     |

### Validación end-to-end (2026-05-04)

Pipeline nacional completado en una sola corrida desatendida (~8h 24min, 0 fallas, 32/32 entidades).

| Métrica                           | Valor                 | Notas                                                                                                                                                                                                                                     |
| --------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filas en Supabase                 | **6,097,681**         | `SELECT COUNT(*) FROM establecimientos`                                                                                                                                                                                                   |
| Cobertura PostGIS (`geom`)        | 6,097,681 (100%)      | `ST_SetSRID(ST_MakePoint(lon, lat), 4326)` aplicado a cada registro                                                                                                                                                                       |
| CLEEs únicos                      | 6,097,681             | sin duplicados después del fix `?on_conflict=clee` (ver Gotcha PostgREST)                                                                                                                                                                 |
| Entidades                         | 32 + 1 anomalía       | `01`–`32` + 1 fila con `entidad='50'` (anomalía INEGI, 1 registro)                                                                                                                                                                        |
| CDMX (`09`)                       | 460,866               | piloto inicial — coincide con conteo INEGI dentro del margen                                                                                                                                                                              |
| Tlaxcala (`29`)                   | 98,729                | INEGI autoritativo: 98,711 (∆ +0.018%, dentro del margen)                                                                                                                                                                                 |
| Colima (`06`)                     | 41,765                | INEGI autoritativo: 41,756 (∆ +0.022%, dentro del margen)                                                                                                                                                                                 |
| Mat-views aplicadas               | 0                     | Definidas en `src/analysis/*.ts`; aún no ejecutadas contra el DB                                                                                                                                                                          |
| Endpoints API funcionales         | 14 (+ `/health`)      | 8 originales + 6 `/analytics/*`: `national-treemap`, `sector-grade-matrix`, `municipios?entidad=`, `top-sectors?entidad=`, `risk-summary?entidad=`, `risk-trend?cve_mun=`                                                                 |
| Frontend analyzer (Locust)        | 5 charts ECharts      | Mosaico nacional treemap + Sector×IRS heatmap + Top sectores bar + Densidad-vs-Pobreza scatter + CLUES vs farmacias por 100k                                                                                                              |
| Frontend analyzer (Map)           | MapLibre + deck.gl    | Carto Positron/Dark Matter basemap + MVT vector source (heatmap zoom<14, circles zoom≥11) + cluster centroids overlay + click-to-detail panel                                                                                             |
| Web bundle (production split)     | 487 + 467 KB gz       | `index-*.js` Locust + shared (487 KB gz) + `MapMode-*.js` lazy chunk (467 KB gz, only on `/map` navigation). Caddy serves with gzip + immutable cache                                                                                     |
| Mat-views perf-backed             | 3 mat-views           | `mv_sector_grade_matrix` (13.7s→91ms) + `mv_national_treemap` (1.15s→88ms) + `mv_delitos_municipal_yearly` (~6s build, 28k rows / 100ms reads). DDL: `scripts/perf-matviews.sql`. Refresh: `scripts/refresh-matviews.sh` (~27s for all 3) |
| Tests                             | 355 across 36 files   | Backend src + scripts + web. Vitest, mocked fetch + execFileSync + execFile, no live HTTP/Supabase                                                                                                                                        |
| Polígonos PostGIS (Tier 2)        | 4 tablas              | `ent_polygons` (32) + `mun_polygons` (2,469) + `loc_polygons` (50,308) + `ageb_polygons` (81,451), todos SRID 4326 + GIST                                                                                                                 |
| Cobertura `ageb` (CVEGEO 13-char) | 6,097,666 (99.99975%) | Spatial join con `ageb_polygons.cvegeo`; 15 puntos sin AGEB son lat/lon malos                                                                                                                                                             |
| Censo 2020 ITER                   | 195,662 filas         | Tabla `censo_iter` (286 cols TEXT) + view `censo_municipios` (2,469 con 14 cols casteadas)                                                                                                                                                |
| CONEVAL Pobreza Municipal         | 2,469 filas           | View `coneval_pobreza_municipal` — % pobreza/extrema, vulnerabilidad, 6 carencias sociales                                                                                                                                                |
| CONEVAL IRS Municipal             | 2,469 filas           | View `coneval_irs_municipal` — analfabetismo, asistencia escolar, calidad vivienda × 7, IRS índice                                                                                                                                        |
| CLUES (DGIS, ene-2026)            | 41,381 EN OPERACION   | `clues` materialized view — 39,946 (96.5%) geocodificadas, GIST sobre geom POINT(4326), btree sobre cve_mun + cve_loc + institucion + nivel_atencion                                                                                      |
| CE 2024 (Censo Económico)         | 1,796,546 filas       | `ce2024_municipal` MV — sector × estrato × municipio, métricas UE/personal_ocupado/producción_bruta/valor_agregado/remuneraciones/ingresos. Bootstrap: `ce2024_raw` (1.92M filas, 105 cols TEXT, mezcla state-level + municipal)          |
| SESNSP RNID Delitos Municipal     | 31.6M long-form       | `sesnsp_delitos_municipal` — 12 años × ~2,500 munis × ~38 delitos × 12 meses, 2015–2026 Mar (~22.2M eventos). Pre-roll: `mv_delitos_municipal_yearly` (28,663 filas, 100ms reads). Cve.Municipio LPAD'd a 5 chars para join con DENUE.    |

---

## Estructura

```
denue-data-analysis/
├── src/
│   ├── extractor/          # Cliente DENUE API + paginación
│   ├── db/                 # loader.ts: upsert a Supabase + PostGIS geom
│   ├── pipeline/           # Orquestador nacional reanudable
│   ├── analysis/           # Runners de mat-views, clusters, coverage
│   └── api/                # Hono HTTP server (Fase 5 + P1 + v0.3 P2 analytics)
│       ├── server.ts       # createServer factory (testeable)
│       ├── handlers/       # /search, /establishment, /summary/*, /clusters, /entidades, /sectors, /tiles, /analytics/*
│       └── middleware/     # auth (X-Api-Key), error, log, rate-limit
├── scripts/
│   ├── extract.ts          # Extractor de un estado individual
│   ├── pipeline.ts         # Pipeline nacional reanudable (DENUE)
│   ├── load.ts             # Carga manual JSON → Supabase (DENUE)
│   ├── analyze.ts          # Correr runners de análisis
│   ├── coverage.ts         # Reporte de cobertura por entidad
│   ├── serve.ts            # Arranca el servidor HTTP (Fase 5)
│   ├── backfill-ageb.ts    # Spatial join: rellena `ageb` con CVEGEO 13-char (Tier 2)
│   ├── load-censo.ts       # Cargar Censo 2020 ITER → censo_iter / censo_municipios (v0.2.1)
│   ├── load-coneval.ts     # Cargar CONEVAL Pobreza + IRS Municipal (v0.2.1)
│   ├── load-clues.ts       # Cargar CLUES DGIS → clues_raw / clues mat-view + GIST (v0.2.2)
│   ├── load-ce2024.ts      # Cargar CE 2024 (32 state ZIPs) → ce2024_raw / ce2024_municipal MV (v0.2.2)
│   ├── load-sesnsp.ts      # Cargar SESNSP RNID Delitos Municipal → sesnsp_delitos_municipal MV (v0.2.2)
│   ├── perf-matviews.sql   # Bootstrap analytics MVs (sector_grade_matrix, national_treemap, delitos_municipal_yearly)
│   └── refresh-matviews.sh # Refresh todos los MVs analíticos en una pasada (~27s)
├── web/                    # Analyzer frontend — Vite + React + Tailwind + ECharts + MapLibre + deck.gl
│   └── src/
│       ├── api/            # client.ts + types.ts (Zod) + queries.ts (TanStack hooks)
│       ├── charts/         # 5 Locust charts + theme.ts + ChartCard wrapper
│       ├── map/            # MapShell (MapLibre+MVT) + ClusterOverlay (deck.gl) + EstablishmentCard + style
│       ├── components/     # ApiKeyGate, FilterPanel, SearchBar, Layout, ErrorBoundary
│       └── modes/          # LocustMode (charts), MapMode (MapLibre + deck.gl)
├── docs/
│   ├── analyzer-plan-v1.md         # Plan sellado del frontend (v0.3+v0.4)
│   ├── v0.2-status.md              # Hoja de estado del roadmap v0.2.x (sobrevive /compact)
│   ├── plan-integracion-datos-mexico.md
│   ├── fuentes-datos-gubernamentales.md
│   ├── fase-1-censo-coneval.md
│   ├── fase-2-ce2024-clues-sesnsp.md
│   └── fase-3-detalle.md
├── data/
│   ├── raw/                # JSON crudo del extractor (.gitignore)
│   └── state/              # pipeline-state.json (checkpoint reanudable)
├── env.example
├── package.json
└── tsconfig.json
```

---

## Instalación

```bash
npm install
cp env.example .env
# Editar .env con SUPABASE_URL, SUPABASE_SERVICE_KEY, DENUE_TOKEN, API_KEY
```

### Dependencias

| Paquete             | Tipo    | Uso                                    |
| ------------------- | ------- | -------------------------------------- |
| `hono`              | runtime | Router HTTP de Fase 5                  |
| `@hono/node-server` | runtime | Adapter Node.js para Hono              |
| `tsx`               | dev     | Ejecución TypeScript sin compilación   |
| `typescript`        | dev     | Compilador (`npm run typecheck/build`) |
| `vitest`            | dev     | Test runner                            |
| `@types/node`       | dev     | Tipos Node                             |

El acceso a Supabase usa la API REST (PostgREST) vía `fetch` nativo y `docker exec ... psql` para el SQL directo (clusters, geom). No hay cliente `@supabase/supabase-js` ni dependencias de validación/logging — la superficie de runtime se mantiene mínima a propósito.

---

## Configuración

```env
# .env
SUPABASE_URL=http://localhost:8100               # URL de Supabase (Kong)
SUPABASE_SERVICE_KEY=<service_role_jwt>          # JWT service_role
DENUE_TOKEN=<token_inegi>                        # https://www.inegi.org.mx/app/api/denue/v1/tokenVerify.aspx
API_KEY=<clave_para_api_interna>                 # Header X-Api-Key requerido en Fase 5

# Opcionales (con defaults)
# API_PORT=3030                                  # puerto del servidor HTTP
# SUPABASE_DB_CONTAINER=supabase-db              # contenedor Postgres
# OUTPUT_DIR=./data                              # raíz para artefactos del pipeline (lee scripts/pipeline.ts; scripts/extract.ts hardcodea ./data/raw)
# STATE_DIR=./data/state                         # ubicación de pipeline-state.json
```

---

## Uso

### Extracción de uno o varios estados

```bash
# pipeline.ts (orquestador con checkpoint y carga a Supabase)  — flag plural
npx tsx --env-file=.env scripts/pipeline.ts --estados=09
npx tsx --env-file=.env scripts/pipeline.ts --estados=09,15,14

# extract.ts (extractor crudo a JSON, sin carga a Supabase)    — flag singular
npx tsx --env-file=.env scripts/extract.ts --estado=09
npx tsx --env-file=.env scripts/extract.ts --estado=all --condicion=farmacia
# 09 = CDMX, 15 = México, 14 = Jalisco. Ver tabla de claves INEGI.
```

### Pipeline nacional (todos los estados)

```bash
npx tsx --env-file=.env scripts/pipeline.ts --all
# Reanudable: guarda estado en data/state/pipeline-state.json
```

Para pipelines de larga duración, usar tmux:

```bash
tmux new-session -d -s denue-national \
  "cd /root/claude/projects/data-intelligence/denue-data-analysis && \
   npx tsx --env-file=.env scripts/pipeline.ts --all 2>&1 | tee /tmp/denue-national.log"
```

### Carga manual a Supabase

```bash
npx tsx --env-file=.env scripts/load.ts --file=data/raw/09_distrito-federal.json
```

### API HTTP (v0.1 — Fase 5)

```bash
npx tsx --env-file=.env scripts/serve.ts
# Default: escucha en :3030. Cambiar con API_PORT.
```

Endpoints disponibles:

| Método | Ruta                      | Auth | Rate-limit | Descripción                                                                                                     |
| ------ | ------------------------- | ---- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                 | ✗    | ✗          | Liveness check (sin auth, para probes)                                                                          |
| `GET`  | `/search`                 | ✓    | ✗          | Búsqueda paginada: `?q=`, `?entidad=`, `?from=lat,lon&radius_km=`, `?page=&limit=` (`limit` máx 1000)           |
| `GET`  | `/establishment/:clee`    | ✓    | ✗          | Lookup por CLEE individual (28 caracteres alfanuméricos)                                                        |
| `GET`  | `/summary/sector/:scian`  | ✓    | ✗          | Resumen nacional por sector SCIAN de 2 dígitos: total nacional + top entidades (agrega CLEE chars 6-7)          |
| `GET`  | `/summary/entidad/:clave` | ✓    | ✗          | Resumen por entidad (`01`–`32`): cargados + total INEGI + cobertura % + top sectores + distribución de estratos |
| `GET`  | `/clusters`               | ✓    | ✗          | Clustering K-means PostGIS: `?entidad=&scian=&k=` — agrupa establecimientos por sector dentro de una entidad    |
| `GET`  | `/entidades`              | ✓    | ✗          | Dropdown source para el frontend: 32 estados con `loaded` + `inegi_total` + `status` (`Cache-Control: 60s`)     |
| `GET`  | `/sectors`                | ✓    | ✗          | Dropdown source para el frontend: 23+ SCIAN de 2 dígitos con `national_count` (ordenado DESC)                   |
| `GET`  | `/tiles/:z/:x/:y.mvt`     | ✓    | 5 req/s/IP | Vector tile MVT (PostGIS `ST_AsMVT`): `?entidad=&sector=`, `Cache-Control: 1h`, cap 50k features/tile           |

Autenticación: header `X-Api-Key: <API_KEY>` en todas las rutas excepto `/health`. Sin la clave o con clave incorrecta el servidor responde `401`.

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

500ms entre requests por defecto, configurable vía el parámetro `delayMs` que el extractor pasa al cliente (`src/extractor/denue-client.ts`). Subir si la API INEGI devuelve 429.

### pageSize = 500

Máximo permitido por la API INEGI. Valores mayores se truncan silenciosamente a 500.

### Gotcha PostgREST — `?on_conflict=` es obligatorio

PostgREST requiere el query param `?on_conflict=<column>` para que el header `Prefer: resolution=merge-duplicates` haga upsert sobre una columna `UNIQUE` que no es la PK. Sin ese query param, PostgREST silenciosamente convierte el upsert en INSERT puro y descarta filas que colisionan con la `UNIQUE` constraint, sin error.

Síntoma: `loadRecords` reporta `inserted=N` pero `SELECT COUNT(*)` muestra muchos menos. En la corrida nacional este bug provocó ~75% de pérdida hasta detectarlo. Fix actual: `loader.ts` envía `POST /establecimientos?on_conflict=clee` con `Prefer: resolution=merge-duplicates,return=minimal`.

### Filtro por municipio

La API INEGI acepta `municipio` como string de 5 dígitos (`cve_ent` + `cve_mun`). Ejemplo CDMX Benito Juárez: `"09014"`.

### Mat-views: definidas, no aplicadas

El DDL vive en `src/db/materialized-views.sql` y se aplica con `scripts/analyze.ts`. Los runners en `src/analysis/*.ts` solo _leen_ las vistas (vía PostgREST). Tres vistas definidas:

- `mv_sector_summary` — agregados por sector (clase_actividad) y entidad
- `mv_coverage` — conteo cargado por entidad + comparación contra INEGI autoritativo
- `mv_estrato_por_entidad` — distribución por estrato de personal ocupado por entidad

Hoy la base no tiene ninguna mat-view aplicada (`SELECT * FROM pg_matviews` → 0 filas). Los handlers de `/summary/*` que dependen de ellas funcionarán solo después de ejecutar `npx tsx --env-file=.env scripts/analyze.ts`.

---

## Estimaciones de volumen (extracción nacional)

| Alcance                 | Establecimientos | Tiempo medido      |
| ----------------------- | ---------------- | ------------------ |
| 1 estado (CDMX, `09`)   | 460,866          | ~45 min            |
| 1 estado (Colima, `06`) | 41,765           | ~5 min             |
| Nacional (32 entidades) | 6,097,681        | ~8h 24min (medido) |

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
