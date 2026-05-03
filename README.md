# DENUE Data Analysis

Proyecto para extraer y analizar datos del **Directorio Estadístico Nacional de Unidades Económicas (DENUE)** del INEGI, utilizando TypeScript y la API oficial.

---

## Descripción

El DENUE es el directorio más completo de establecimientos económicos en México, con más de 5 millones de registros que incluyen razón social, actividad económica (SCIAN), ubicación geográfica, tamaño por estrato de empleados, y datos de contacto.

Este proyecto automatiza la extracción, transformación y análisis de esos datos para uso en inteligencia de negocios, segmentación de mercados, y análisis geoespacial.

---

## Objetivos principales

1. **Extracción sistemática** — Consultar la API DENUE paginando por estado y sector económico para cubrir el universo nacional.
2. **Almacenamiento estructurado** — Persistir los registros en una base de datos relacional (PostgreSQL/Supabase) con esquema normalizado.
3. **Análisis sectorial** — Identificar concentraciones de actividad económica por región, tamaño y giro.
4. **Enriquecimiento de datos** — Cruzar con otras fuentes (SCIAN, AGEB, Marco Geoestadístico) para análisis más profundos.
5. **API interna** — Exponer los datos procesados como servicio queryable para proyectos de inteligencia comercial.

---

## Estructura del proyecto

```
eurekamd-denue-analysis/
├── README.md
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── client/
│   │   └── denue.ts          # Cliente HTTP para la API DENUE
│   ├── extractor/
│   │   ├── paginator.ts      # Lógica de paginación por estado/sector
│   │   └── types.ts          # Tipos e interfaces (Establecimiento, etc.)
│   ├── loader/
│   │   ├── schema.sql        # DDL de la tabla destino
│   │   └── loader.ts         # Carga a PostgreSQL/Supabase
│   ├── analysis/
│   │   └── sectorSummary.ts  # Resúmenes por sector SCIAN
│   └── scripts/
│       ├── extract.ts        # Entry point: extracción completa
│       └── analyze.ts        # Entry point: pipeline de análisis
└── dist/                     # Compilado (gitignored)
```

---

## Requisitos previos

### Runtime
- Node.js 20+
- npm 10+

### Instalación

```bash
npm install
```

### Dependencias principales

```json
{
  "dependencies": {
    "zod": "^3.22.0",
    "pg": "^8.11.0",
    "dotenv": "^16.3.0"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "@types/node": "^20.0.0",
    "@types/pg": "^8.11.0",
    "tsx": "^4.7.0",
    "vitest": "^1.6.0"
  }
}
```

### Credenciales

Copia `.env.example` a `.env` y completa:

```bash
cp .env.example .env
```

```env
DENUE_API_TOKEN=tu_token_aqui
DATABASE_URL=postgresql://user:pass@host:5432/dbname
```

> **Token DENUE:** Gratuito. Se obtiene registrando tu email en:
> https://www.inegi.org.mx/app/api/denue/v1/tokenVerify.aspx

---

## Uso rápido

```bash
# Extracción piloto — CDMX, todos los sectores, primeros 1000 registros
npx tsx src/scripts/extract.ts --estado 09 --limit 1000

# Extracción completa nacional (tarda varias horas)
npx tsx src/scripts/extract.ts --all-states

# Análisis básico
npx tsx src/scripts/analyze.ts --report sector_summary

# Compilar
npm run build

# Tests
npm test
```

---

## Fuente de datos

- **API DENUE v1:** https://www.inegi.org.mx/servicios/api_denue.html
- **Marco Geoestadístico:** https://www.inegi.org.mx/temas/mg/
- **Clasificación SCIAN:** https://www.inegi.org.mx/app/scian/

---

## Estado del proyecto

| Fase | Descripción | Estado |
|------|-------------|--------|
| 0 | Exploración y prueba de API | ✅ Completado |
| 1 | Extractor paginado por estado | 🔄 En desarrollo |
| 2 | Esquema DB + carga piloto (CDMX) | ⏳ Pendiente |
| 3 | Extracción nacional completa | ⏳ Pendiente |
| 4 | Pipeline de análisis y reportes | ⏳ Pendiente |

---

## Organización

Desarrollado bajo [EurekaMD](https://eurekamd.net) — Inteligencia de datos para el sector salud y comercial en México.
