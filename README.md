# DENUE Data Analysis

Extractor y analizador de datos del **Directorio Estadístico Nacional de Unidades Económicas (DENUE)** del INEGI, implementado en TypeScript.

> **Última actualización de datos fuente:** DENUE Interactivo 05/2025 (Marzo 2025, Censos Económicos 2024) — 6,097,675 establecimientos.

---

## Estado del proyecto

| Fase | Descripción                                              | Estado        |
| ---- | -------------------------------------------------------- | ------------- |
| 1    | Extractor paginado — cliente HTTP, reintentos, streaming | ✅ Completado |
| 2    | Schema PostgreSQL + PostGIS, loader con upsert           | ✅ Completado |
| 3    | Extracción nacional completa                             | ⏳ Pendiente  |
| 4    | Pipeline de análisis y reportes                          | ⏳ Pendiente  |
| 5    | API interna queryable                                    | ⏳ Pendiente  |

---

## Descripción

El DENUE es el directorio más completo de establecimientos económicos en México. Este proyecto automatiza la extracción, transformación y persistencia de esos datos para inteligencia de negocios, segmentación de mercados y análisis geoespacial.

### Casos de uso implementados

- Extracción filtrada por estado, municipio y condición de búsqueda
- Carga a Supabase con geometría PostGIS y upsert idempotente
- Consultas por radio geográfico (`ST_DWithin`)

**Demo ejecutado:** 29 hospitales (SCIAN 622x) en Tlalpan, CDMX — cargados en Supabase con coords validadas.

---

## Estructura

```
denue-data-analysis/
├── src/
│   ├── extractor/
│   │   ├── types.ts              # DenueRawRecord — interfaz canónica validada contra la API real
│   │   ├── denue-client.ts       # Wrapper HTTP con reintentos y backoff exponencial
│   │   ├── denue-client.test.ts  # 13 tests
│   │   ├── paginator.ts          # Paginación + escritura streaming por página (sin acumular en RAM)
│   │   └── paginator.test.ts     # 4 tests
│   └── db/
│       ├── schema.sql            # DDL: tabla establecimientos + 6 índices (GIST, FTS, SCIAN) + trigger + vista geo
│       ├── loader.ts             # transform() + loadRecords() — upsert vía PostgREST
│       └── loader.test.ts        # 23 tests
├── scripts/
│   ├── extract.ts                # CLI: --estado, --sector, --condicion, --all
│   └── load.ts                   # CLI: --file=<path> --batch=<n>
├── tests/
│   ├── fixtures/
│   │   └── denue-real-09-sample.json  # 5 registros reales CDMX (ground truth, 2026-05-03)
│   └── integration/
│       └── extractor-to-loader.test.ts  # Seam test: fixture → transform → payload shape
├── .env.example
├── tsconfig.json
└── package.json
```

---

## Instalación

```bash
git clone https://github.com/EurekaMD-net/eurekamd-denue-analysis.git
cd eurekamd-denue-analysis
npm install
cp .env.example .env   # Edita con tu token y DATABASE_URL
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
# .env
DENUE_TOKEN=tu_token_aqui
DATABASE_URL=postgresql://user:pass@host:5433/postgres
SUPABASE_URL=http://localhost:8100
SUPABASE_SERVICE_KEY=tu_service_key
```

> **Token DENUE:** Gratuito. Registro en https://www.inegi.org.mx/app/api/denue/v1/tokenVerify.aspx

---

## Uso

### Extracción

```bash
# Estado 09 (CDMX), todos los sectores
DENUE_TOKEN=xxx npx tsx scripts/extract.ts --estado=09

# Filtro por condición (keyword)
DENUE_TOKEN=xxx npx tsx scripts/extract.ts --estado=09 --condicion=hospital

# Todos los estados (extracción nacional — puede tardar horas)
DENUE_TOKEN=xxx npx tsx scripts/extract.ts --all
```

La extracción usa **streaming por página** — no acumula registros en RAM. Output: `output/<estado>_<timestamp>.json`.

### Carga a Supabase

```bash
# Aplicar schema (solo primera vez)
psql $DATABASE_URL < src/db/schema.sql

# Cargar archivo
npx tsx scripts/load.ts --file=output/09_2026-05-03.json

# Con batch size personalizado
npx tsx scripts/load.ts --file=output/09_2026-05-03.json --batch=200
```

### Tests

```bash
npm run typecheck   # tsc --noEmit — debe dar 0 errores
npm test            # vitest run — 45 tests
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

### Extracción de entidad (`entidad`)

`AreaGeo` no existe en el endpoint `buscarEntidad`. El código extrae la clave de entidad de los **primeros 2 caracteres del `CLEE`** (estándar INEGI). Ej: `CLEE = "09016541110003013..."` → `entidad = "09"`.

### Formato de `Ubicacion`

El campo real sigue el patrón: `"MUNICIPIO, Municipio, ESTADO"` — tres partes separadas por coma. El `extractMunicipio` toma la primera parte. Ej: `"TLALPAN, Tlalpan, CIUDAD DE MÉXICO"` → `municipio = "TLALPAN"`.

### Gotcha PostgREST

Después de crear una tabla nueva en Supabase, PostgREST necesita recargar su cache de schema:

```bash
docker kill --signal=SIGUSR1 supabase-rest
```

Sin esto, las llamadas a la tabla nueva devuelven 404 aunque la tabla exista en PostgreSQL.

### Filtro por municipio

El endpoint `buscarEntidad` **no soporta filtro por municipio directamente** — filtra por entidad federativa completa. Para obtener registros de una delegación específica:

1. Extrae el estado completo
2. Filtra localmente por el campo `municipio` del registro (extraído de `Ubicacion`)

---

## Fuente de datos

- **API DENUE:** https://www.inegi.org.mx/servicios/api_denue.html
- **Documentación endpoints:** `buscarEntidad`, `BuscarAreaAct`, `Cuantificar`
- **SCIAN:** https://www.inegi.org.mx/app/scian/
- **Marco Geoestadístico:** https://www.inegi.org.mx/temas/mg/

---

## Organización

Desarrollado bajo [EurekaMD](https://eurekamd.net) — Inteligencia de datos para el sector salud y comercial en México.
