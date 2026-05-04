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

| Versión    | Fuentes                         | Descripción                                                                              | Estimado | Docs                                                                |
| ---------- | ------------------------------- | ---------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| **v0.1**   | DENUE                           | ✅ Baseline — extracción, carga, análisis y API. Farmacias y todos los verticales SCIAN  | ✅ Done  | este README                                                         |
| **v0.2.1** | Censo 2020 + CONEVAL            | PSINDER, P60YMAS, IRS sintético, IVAF v1/v2. Join por `cve_mun` y `cve_ageb`             | 1-2 días | [fase-1-censo-coneval.md](docs/fase-1-censo-coneval.md)             |
| **v0.2.2** | CE 2024 + CLUES + SESNSP        | Revenue sectorial, infraestructura médica, riesgo de seguridad. Score combinado Fase 2   | 2-3 días | [fase-2-ce2024-clues-sesnsp.md](docs/fase-2-ce2024-clues-sesnsp.md) |
| **v0.2.3** | Datatur + SINAIS + ENOE + ENIGH | Mortalidad crónica, turismo, calibradores regionales (ENOE/ENIGH). Score final acumulado | 1-2 días | [fase-3-detalle.md](docs/fase-3-detalle.md)                         |
| **v0.3**   | Modo Mapa                       | Frontend geoespacial: MapLibre + deck.gl sobre la API v0.2.x                             | 2-3 días | TBD                                                                 |
| **v0.4**   | Modo Locust                     | Visualización analítica: ECharts (barras, radar, scatter 3D). Paralelo a v0.3            | 2-3 días | TBD                                                                 |

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

| Métrica                    | Valor            | Notas                                                                                               |
| -------------------------- | ---------------- | --------------------------------------------------------------------------------------------------- |
| Filas en Supabase          | **6,097,681**    | `SELECT COUNT(*) FROM establecimientos`                                                             |
| Cobertura PostGIS (`geom`) | 6,097,681 (100%) | `ST_SetSRID(ST_MakePoint(lon, lat), 4326)` aplicado a cada registro                                 |
| CLEEs únicos               | 6,097,681        | sin duplicados después del fix `?on_conflict=clee` (ver Gotcha PostgREST)                           |
| Entidades                  | 32 + 1 anomalía  | `01`–`32` + 1 fila con `entidad='50'` (anomalía INEGI, 1 registro)                                  |
| CDMX (`09`)                | 460,866          | piloto inicial — coincide con conteo INEGI dentro del margen                                        |
| Tlaxcala (`29`)            | 98,729           | INEGI autoritativo: 98,711 (∆ +0.018%, dentro del margen)                                           |
| Colima (`06`)              | 41,765           | INEGI autoritativo: 41,756 (∆ +0.022%, dentro del margen)                                           |
| Mat-views aplicadas        | 0                | Definidas en `src/analysis/*.ts`; aún no ejecutadas contra el DB                                    |
| Endpoints API funcionales  | 5 (+ `/health`)  | `/search`, `/establishment/:clee`, `/summary/sector/:scian`, `/summary/entidad/:clave`, `/clusters` |

---

## Estructura

```
denue-data-analysis/
├── src/
│   ├── extractor/          # Cliente DENUE API + paginación
│   ├── db/                 # loader.ts: upsert a Supabase + PostGIS geom
│   ├── pipeline/           # Orquestador nacional reanudable
│   ├── analysis/           # Runners de mat-views, clusters, coverage
│   └── api/                # Hono HTTP server (Fase 5)
│       ├── server.ts       # createServer factory (testeable)
│       ├── handlers/       # /search, /establishment, /summary/*, /clusters
│       └── middleware/     # auth (X-Api-Key), error, log
├── scripts/
│   ├── extract.ts          # Extractor de un estado individual
│   ├── pipeline.ts         # Pipeline nacional reanudable
│   ├── load.ts             # Carga manual JSON → Supabase
│   ├── analyze.ts          # Correr runners de análisis
│   ├── coverage.ts         # Reporte de cobertura por entidad
│   └── serve.ts            # Arranca el servidor HTTP (Fase 5)
├── docs/
│   ├── analyzer-plan-v1.md         # Plan sellado del frontend (v0.3+v0.4)
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
# OUTPUT_DIR=./data/raw                          # destino de los JSON extraídos
# STATE_DIR=./data/state                         # ubicación de pipeline-state.json
```

---

## Uso

### Extracción de uno o varios estados

```bash
npx tsx --env-file=.env scripts/pipeline.ts --estados=09
npx tsx --env-file=.env scripts/pipeline.ts --estados=09,15,14
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

| Método | Ruta                      | Auth | Descripción                                                                                                     |
| ------ | ------------------------- | ---- | --------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                 | ✗    | Liveness check (sin auth, para probes)                                                                          |
| `GET`  | `/search`                 | ✓    | Búsqueda paginada: `?q=`, `?entidad=`, `?from=lat,lon&radius_km=`, `?page=&limit=` (`limit` máx 1000)           |
| `GET`  | `/establishment/:clee`    | ✓    | Lookup por CLEE individual (15 caracteres alfanuméricos)                                                        |
| `GET`  | `/summary/sector/:scian`  | ✓    | Resumen nacional por sector SCIAN de 2 dígitos: total nacional + top entidades (lee `mv_sector_summary`)        |
| `GET`  | `/summary/entidad/:clave` | ✓    | Resumen por entidad (`01`–`32`): cargados + total INEGI + cobertura % + top sectores + distribución de estratos |
| `GET`  | `/clusters`               | ✓    | Clustering K-means PostGIS: `?entidad=&scian=&k=` — agrupa establecimientos por sector dentro de una entidad    |

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

500ms entre requests por defecto (`DENUE_REQUEST_DELAY_MS`). Aumentar si la API INEGI devuelve 429.

### pageSize = 500

Máximo permitido por la API INEGI. Valores mayores se truncan silenciosamente a 500.

### Gotcha PostgREST — `?on_conflict=` es obligatorio

PostgREST requiere el query param `?on_conflict=<column>` para que el header `Prefer: resolution=merge-duplicates` haga upsert sobre una columna `UNIQUE` que no es la PK. Sin ese query param, PostgREST silenciosamente convierte el upsert en INSERT puro y descarta filas que colisionan con la `UNIQUE` constraint, sin error.

Síntoma: `loadRecords` reporta `inserted=N` pero `SELECT COUNT(*)` muestra muchos menos. En la corrida nacional este bug provocó ~75% de pérdida hasta detectarlo. Fix actual: `loader.ts` envía `POST /establecimientos?on_conflict=clee` con `Prefer: resolution=merge-duplicates,return=minimal`.

### Filtro por municipio

La API INEGI acepta `municipio` como string de 5 dígitos (`cve_ent` + `cve_mun`). Ejemplo CDMX Benito Juárez: `"09014"`.

### Mat-views: definidas, no aplicadas

Los runners de Fase 4 (`src/analysis/`) emiten SQL `CREATE MATERIALIZED VIEW IF NOT EXISTS` para tres vistas:

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
