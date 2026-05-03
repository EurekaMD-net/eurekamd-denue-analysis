# DENUE Data Analysis

Proyecto para extraer y analizar datos del **Directorio Estadístico Nacional de Unidades Económicas (DENUE)** del INEGI, utilizando Python y la API oficial.

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
├── requirements.txt
├── .env.example
├── extractor/
│   ├── __init__.py
│   ├── client.py          # Cliente HTTP para la API DENUE
│   ├── paginator.py       # Lógica de paginación por estado/sector
│   └── models.py          # Modelos de datos (dataclasses / Pydantic)
├── loader/
│   ├── __init__.py
│   ├── schema.sql         # DDL de la tabla destino
│   └── loader.py          # Carga a PostgreSQL/Supabase
├── analysis/
│   ├── __init__.py
│   ├── sector_summary.py  # Resúmenes por sector SCIAN
│   └── geo_analysis.py    # Análisis geoespacial básico
├── notebooks/
│   └── exploratory.ipynb  # Exploración inicial de datos
└── scripts/
    ├── run_extraction.py  # Entry point: extracción completa
    └── run_analysis.py    # Entry point: pipeline de análisis
```

---

## Requisitos previos

### Python
- Python 3.10+
- pip o conda

### Librerías principales

```bash
pip install -r requirements.txt
```

```
requests>=2.31.0        # Llamadas HTTP a la API DENUE
pydantic>=2.0.0         # Validación y modelos de datos
psycopg2-binary>=2.9    # Conector PostgreSQL
pandas>=2.0.0           # Transformación y análisis tabular
geopandas>=0.14.0       # Análisis geoespacial (opcional)
python-dotenv>=1.0.0    # Variables de entorno
tqdm>=4.65.0            # Barra de progreso en extracción
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
# 1. Extracción piloto — CDMX, todos los sectores, primeros 1000 registros
python scripts/run_extraction.py --estado 09 --limit 1000

# 2. Extracción completa nacional (tarda varias horas)
python scripts/run_extraction.py --all-states

# 3. Análisis básico
python scripts/run_analysis.py --report sector_summary
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
