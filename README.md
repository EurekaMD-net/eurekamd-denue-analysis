# DENUE Data Analysis

Extractor y analizador de datos del **Directorio Estadístico Nacional de Unidades Económicas (DENUE)** del INEGI, implementado en TypeScript.

> **Fuente:** API live INEGI DENUE v1 — `/app/api/denue/v1/consulta/`. La API no expone metadatos de versión/snapshot; siempre devuelve la publicación corriente. Validado contra el conteo oficial de INEGI por estado (verificación manual vía https://www.inegi.org.mx/app/mapa/denue/).

---

## Estado del proyecto

| Fase | Descripción                                              | Estado        |
| ---- | -------------------------------------------------------- | ------------- |
| 1    | Extractor paginado — cliente HTTP, reintentos, streaming | ✅ Completado |
| 2    | Schema PostgreSQL + PostGIS, loader con upsert           | ✅ Completado |
| 3    | Pipeline nacional reanudable (32 estados)                | ✅ Completado |
| 4    | Pipeline de análisis y reportes                          | ⏳ Pendiente  |
| 5    | API interna queryable                                    | ⏳ Pendiente  |

---

## Descripción

El DENUE es el directorio más completo de establecimientos económicos en México. Este proyecto automatiza la extracción, transformación y persistencia de esos datos para inteligencia de negocios, segmentación de mercados y análisis geoespacial.

### Casos de uso implementados

- Extracción filtrada por estado, municipio y condición de búsqueda
- Pipeline nacional reanudable: crash recovery por estado, retry de fallidos
- Throttle global de API: concurrencia del orquestador no multiplica hits a INEGI
- Carga a Supabase con geometría PostGIS y upsert idempotente por `CLEE`
- Consultas por radio geográfico (`ST_DWithin`)

### Validación end-to-end (2026-05-03)

| Estado   | Extraídos | Cargados | Conteo INEGI | Cobertura     |
| -------- | --------- | -------- | ------------ | ------------- |
| Tlaxcala | 98,711    | 98,692   | 98,711       | 100% (\*)     |
| Colima   | 41,756    | 41,745   | —            | (verificable) |

(\*) ~0.02% de los registros queda asignado a su entidad canónica por prefijo CLEE
(sucursales que operan en X pero registradas en otra entidad — comportamiento por
diseño, ver `extractEntidad` en `src/db/loader.ts`).

---

## Estructura

```
denue-data-analysis/
├── src/
│   ├── extractor/
│   │   ├── types.ts              # DenueRawRecord (interfaz canónica), ESTADOS, EstadoClave
│   │   ├── denue-client.ts       # HTTP client + throttle global + reintentos con backoff
│   │   ├── denue-client.test.ts  # 13 tests (incl. throttle timing)
│   │   ├── paginator.ts          # Paginación streaming — no acumula en RAM
│   │   └── paginator.test.ts     # 4 tests
│   ├── db/
│   │   ├── schema.sql            # DDL: tabla establecimientos + 6 índices (GIST, FTS, SCIAN) + trigger + vista geo
│   │   ├── loader.ts             # transform() + loadRecords() — upsert vía PostgREST
│   │   └── loader.test.ts        # 23 tests
│   └── pipeline/
│       ├── state-manager.ts      # Progreso por estado en JSON local — crash recovery
│       ├── state-manager.test.ts # 14 tests
│       ├── validator.ts          # Valida shape del archivo antes de cargar (sampling determinístico)
│       ├── validator.test.ts     # 10 tests
│       ├── orchestrator.ts       # Loop concurrente: extract → validate → load → mark
│       └── orchestrator.test.ts  # 6 tests
├── scripts/
│   ├── extract.ts                # CLI single-state: --estado, --sector, --condicion
│   ├── load.ts                   # CLI single-file: --file=<path> --batch=<n>
│   └── pipeline.ts               # CLI pipeline nacional: --all, --estados=, --retry-failed, --status
├── tests/
│   ├── fixtures/
│   │   └── denue-real-09-sample.json  # 5 registros reales CDMX (ground truth, 2026-05-03)
│   └── integration/
│       ├── extractor-to-loader.test.ts   # Seam test: fixture → transform → payload shape
│       └── pipeline.integration.test.ts  # Pipeline end-to-end (2 estados mockeados)
├── data/
│   ├── raw/                      # JSON extraídos por estado (gitignored)
│   └── state/                    # pipeline-state.json — separado de los datos (gitignored)
├── env.example
├── tsconfig.json
└── package.json
```

---

## Instalación

```bash
git clone https://github.com/EurekaMD-net/eurekamd-denue-analysis.git
cd eurekamd-denue-analysis
npm install
cp env.example .env   # Edita con tu token y claves de Supabase
```

### Dependencias

```json
{
  "dependencies": {
    "dotenv": "^16.4.5"
  },
  "devDependencies": {
    "typescript": "^5.4.5",
    "@types/node": "^20.12.7",
    "tsx": "^4.9.3",
    "vitest": "^3.1.2"
  }
}
```

---

## Configuración

```env
# env.example
DENUE_TOKEN=your-token-here
SUPABASE_URL=http://localhost:8100
SUPABASE_SERVICE_KEY=your_service_role_jwt_here

# Directorios opcionales (tienen defaults)
# OUTPUT_DIR=./data/raw      # JSON extraídos por estado
# STATE_DIR=./data/state     # pipeline-state.json (separado de OUTPUT_DIR)
```

> **Token DENUE:** Gratuito. Registro en https://www.inegi.org.mx/app/api/denue/v1/tokenVerify.aspx

---

## Uso

### Extracción de un estado

```bash
# CDMX (estado 09), todos los sectores
npx tsx scripts/extract.ts --estado=09

# Filtro por condición (keyword)
npx tsx scripts/extract.ts --estado=09 --condicion=hospital
```

La extracción usa **streaming por página** — no acumula registros en RAM. Output: `data/raw/<estado>_<timestamp>.json`.

### Pipeline nacional (Fase 3)

```bash
# Ver estado actual del pipeline
npx tsx scripts/pipeline.ts --status

# Extracción nacional completa (32 estados, secuencial)
npx tsx scripts/pipeline.ts --all

# Solo estados específicos
npx tsx scripts/pipeline.ts --estados=09,15,14

# Reintentar estados fallidos
npx tsx scripts/pipeline.ts --retry-failed

# Con concurrencia (default=1 — seguro para rate limit INEGI)
npx tsx scripts/pipeline.ts --all --concurrency=2

# Actualizar geometrías PostGIS al terminar
npx tsx scripts/pipeline.ts --all --update-geom
```

El pipeline es **reanudable**: si el proceso muere a mitad, el próximo run salta los estados `done` y retoma desde donde quedó. El estado persiste en `data/state/pipeline-state.json`.

### Carga manual a Supabase

```bash
# Aplicar schema (solo primera vez)
psql $DATABASE_URL < src/db/schema.sql

# Recargar cache PostgREST después de aplicar schema (ver Gotchas)
docker kill --signal=SIGUSR1 supabase-rest

# Cargar archivo
npx tsx scripts/load.ts --file=data/raw/09_2026-05-03.json

# Con batch size personalizado
npx tsx scripts/load.ts --file=data/raw/09_2026-05-03.json --batch=200
```

### Tests

```bash
npm run typecheck   # tsc --noEmit — debe dar 0 errores
npm test            # vitest run — 82 tests
```

---

## Notas de implementación

### Interfaz canónica de la API (`DenueRawRecord`)

La interfaz en `src/extractor/types.ts` fue **validada contra la API real** (fixture `tests/fixtures/denue-real-09-sample.json`, capturado 2026-05-03). Campos confirmados en cada respuesta real:

```
CLEE, Id, Nombre, Razon_social, Clase_actividad, Estrato, Tipo_vialidad,
Calle, Num_Exterior, Num_Interior, Colonia, CP, Ubicacion, Telefono,
Correo_e, Sitio_internet, Tipo, Longitud, Latitud,
tipo_corredor_industrial, nom_corredor_industrial, numero_local
```

Campos documentados en specs antiguas pero **ausentes de la API real**: `AGEB`, `Manzana`, `CLASE_ACTIVIDAD_ID`, `SECTOR_ACTIVIDAD_ID`, `SUBSECTOR_ACTIVIDAD_ID`, `RAMA_ACTIVIDAD_ID`, `SUBRAMA_ACTIVIDAD_ID`, `EDIFICIO`, `EDIFICIO_PISO`, `Tipo_Asentamiento`, `Fecha_Alta`, `AreaGeo`.

### Extracción de entidad

`AreaGeo` no existe en el endpoint `buscarEntidad`. El código extrae la clave de entidad de los **primeros 2 caracteres del `CLEE`** (estándar INEGI). Ej: `CLEE = "09016541110003013..."` → `entidad = "09"`.

### Formato de `Ubicacion`

El campo real sigue el patrón: `"MUNICIPIO, Municipio, ESTADO"` — tres partes separadas por coma. El `extractMunicipio` toma la primera parte. Ej: `"TLALPAN, Tlalpan, CIUDAD DE MÉXICO"` → `municipio = "TLALPAN"`.

### Throttle global de API

Todos los fetches al DENUE pasan por un throttle global serializado en `denue-client.ts` (`_throttleChain`). Esto garantiza que la concurrencia del orquestador **no multiplique** los hits a la API de INEGI — sea `--concurrency=1` o `--concurrency=4`, el rate es el mismo (1 request / `delayMs`).

### pageSize = 500

La API del DENUE trunca o rechaza páginas >500 registros en el endpoint `buscarEntidad` (verificado empíricamente — misma configuración que el extractor single-state). No usar 1000.

### Gotcha PostgREST

Después de crear una tabla nueva en Supabase, PostgREST necesita recargar su cache de schema:

```bash
docker kill --signal=SIGUSR1 supabase-rest
```

Sin esto, las llamadas a la tabla nueva devuelven 404 aunque la tabla exista en PostgreSQL. También hay que otorgar permisos explícitos al rol `anon`:

```sql
GRANT SELECT, INSERT, UPDATE ON establecimientos TO anon;
```

### Filtro por municipio

El endpoint `buscarEntidad` **no soporta filtro por municipio directamente** — filtra por entidad federativa completa. Para obtener registros de una delegación específica:

1. Extrae el estado completo
2. Filtra localmente por el campo `municipio` del registro (extraído de `Ubicacion`)

---

## Estimaciones de volumen (extracción nacional)

| Métrica                                                | Estimado |
| ------------------------------------------------------ | -------- |
| Registros totales                                      | ~6.1M    |
| Tiempo extracción CDMX (09)                            | ~30 min  |
| Tiempo extracción completa (32 estados, concurrency=1) | ~18-24 h |
| Tamaño JSON crudo estimado                             | ~8-12 GB |

---

## Fuente de datos

- **API DENUE:** https://www.inegi.org.mx/servicios/api_denue.html
- **Documentación endpoints:** `buscarEntidad`, `BuscarAreaAct`, `Cuantificar`
- **SCIAN:** https://www.inegi.org.mx/app/scian/
- **Marco Geoestadístico:** https://www.inegi.org.mx/temas/mg/

---

## Organización

Desarrollado bajo [EurekaMD](https://eurekamd.net) — Inteligencia de datos para el sector salud y comercial en México.
