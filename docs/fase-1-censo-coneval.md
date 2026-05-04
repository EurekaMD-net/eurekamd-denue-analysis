# Fase 1 — Censo 2020 + CONEVAL: Contexto Demográfico y NSE

**Estatus:** Pendiente (prerrequisito: Fase 0 DENUE base completada ✅)  
**Versión del producto:** v0.2.1  
**Estimado:** 1-2 días de trabajo activo  
**Fecha documento:** 2026-05-04  

---

## 1. Contexto del roadmap

| Fase | Versión | Fuentes | Estimado real | Estado |
|------|---------|---------|---------------|--------|
| **0 — DENUE base** | v0.1 | DENUE nacional (~6.1M establecimientos) | — | ✅ Completada 2026-05-03 |
| **1 — Censo + CONEVAL** | **v0.2.1** | Censo 2020 (AGEB + ITER), CONEVAL pobreza municipal | **1-2 días** | ⏳ Siguiente |
| **2 — CE 2024 + CLUES + SESNSP** | v0.2.2 | Censo Económico, infraestructura médica, seguridad | 2-3 días | Pendiente |
| **3 — Datatur + SINAIS + ENOE** | v0.2.3 | Turismo, mortalidad, empleo | 1-2 días | Pendiente |
| **4 — ENSANUT + ENVIPE + ENDUTIH + ENIGH** | v0.3.x | Salud, victimización, brecha digital, consumo | TBD | Pendiente |
| **Modo Mapa** | v0.4.0 | MapLibre GL + deck.gl | 2-3 días | Pendiente (frontend sobre API Fase 5) |
| **Modo Locust** | v0.4.1 | ECharts: barras, radar, 3D | 2-3 días (paralelo al mapa) | Pendiente |

**Total acumulado realista: ~10-12 días de trabajo activo para stack funcional y refinable.**

---

## 2. Objetivos de la Fase 1

La Fase 1 agrega el **denominador real** que le falta a DENUE puro. DENUE conteo cuántos establecimientos hay; el Censo y CONEVAL dicen **quién vive alrededor** y en qué condiciones.

### Objetivos específicos

1. **Enriquecer cada establecimiento DENUE** con el contexto demográfico y socioeconómico del AGEB donde está ubicado → vista `mv_denue_enriquecido`
2. **Construir el IRS sintético por AGEB** — Índice de Resiliencia Socioeconómica — usando variables ITER como proxy sub-municipal de CONEVAL
3. **Habilitar el IVAF v1** — Índice de Vulnerabilidad de Acceso Farmacéutico (y su equivalente para otros verticales) — score 0-100 por AGEB que combina: densidad de establecimientos + `PSINDER` + `P60YMAS` + pobreza municipal
4. **Alimentar el Modo Mapa** con polígonos AGEB y cloropléticas de NSE
5. **Alimentar el Modo Locust** con radares de NSE y scatter de densidad vs. ingreso estimado

---

## 3. Alcance del analizador v0.1 (baseline actual)

Antes de Fase 1, el sistema (v0.1) puede hacer:

| Capacidad | Disponible en v0.1 |
|---|---|
| Top sectores por entidad federativa | ✅ |
| Rankings de municipios por conteo de establecimientos | ✅ |
| Export GeoJSON por entidad | ✅ |
| Densidad de establecimientos por municipio | ✅ |
| Filtro por SCIAN (sector, subsector, rama, clase) | ✅ |
| Análisis por tamaño de empresa (`per_ocu`) | ✅ |
| **Ratio establecimientos / habitantes** | ❌ Sin denominador |
| **Score de oportunidad con contexto NSE** | ❌ Sin Censo |
| **Identificación de desiertos calificados** | ❌ Sin PSINDER/P60YMAS |
| **Estratificación por pobreza** | ❌ Sin CONEVAL |

La Fase 1 habilita **todo lo que v0.1 no puede hacer**: análisis con denominador real y contexto socioeconómico.

---

## 4. Las dos fuentes de Fase 1

### 4.1 Censo 2020 — INEGI (ITER + Marco Geoestadístico)

**Qué es:** Levantamiento decenal del INEGI. Dos productos relevantes:
- **ITER** (Indicadores del Censo por AGEB): 222 variables socioeconómicas y demográficas por AGEB urbana
- **Marco Geoestadístico**: polígonos GeoJSON de las ~64,000 AGEBs urbanas del país

**Variables clave para el stack de análisis:**

| Variable ITER | Descripción | Uso en el score |
|---|---|---|
| `POBTOT` | Población total | Denominador base |
| `PSINDER` | Población sin derechohabiencia | Mercado objetivo farmacias/clínicas |
| `P60YMAS` | Población 60+ años | Demanda crónica de medicamentos/servicios |
| `POCUPADA` | Población ocupada | Proxy de capacidad de pago |
| `P15YMAS_AN` | Analfabetos 15+ | Inverso: baja escolaridad → NSE bajo |
| `GRAPROES` | Grado promedio de escolaridad | NSE directo |
| `VPH_AUTOM` | Viviendas con automóvil | NSE directo |
| `VPH_PC` | Viviendas con computadora | NSE medio-alto |
| `VPH_INTER` | Viviendas con internet | NSE medio-alto |
| `PROM_HNV` | Promedio de hijos nacidos vivos | Demanda pediátrica |
| `clave_ageb` | Clave geográfica (join con shape) | Llave de join principal |

**Mecánica de carga:**
- ITER: un CSV por entidad federativa (32 archivos) → concatenar, limpiar, cargar
- Marco Geoestadístico: shapefiles → conversión a GeoJSON → carga a Supabase/PostGIS con `geom GEOMETRY(MultiPolygon, 4326)`
- Join con DENUE: `ST_Within(denue.geom, ageb_urbana.geom)` → asigna `clave_ageb` a cada establecimiento

**Fuentes oficiales:**
- ITER 2020: [https://www.inegi.org.mx/programas/ccpv/2020/default.html#Microdatos](https://www.inegi.org.mx/programas/ccpv/2020/default.html#Microdatos)
- Marco Geoestadístico: [https://www.inegi.org.mx/app/biblioteca/ficha.html?upc=889463770541](https://www.inegi.org.mx/app/biblioteca/ficha.html?upc=889463770541)

---

### 4.2 CONEVAL — Pobreza Municipal 2020

**Qué es:** Medición de pobreza multidimensional del CONEVAL a nivel municipal. Incluye las 6 dimensiones de carencia social + ingreso relativo.

**Variables clave:**

| Variable | Descripción | Uso en el score |
|---|---|---|
| `pobreza_pct` | % de población en pobreza | Capacidad de pago general |
| `pobreza_ext_pct` | % en pobreza extrema | Filtro: descarte de zonas sin potencial comercial |
| `carencia_salud_pct` | % sin acceso a servicios de salud | Correlato de `PSINDER`; demanda de farmacias Similares |
| `carencia_alimentaria_pct` | % con carencia alimentaria | NSE muy bajo; proxy de nivel 5 del IRS |
| `carencia_educacion_pct` | % con rezago educativo | Complemento de `GRAPROES` del Censo |
| `irs_score` | Índice de Rezago Social CONEVAL | Score sintético oficial a nivel municipal |
| `cve_mun` | Clave municipio (5 dígitos) | Llave de join nativa |

**Mecánica de carga:**
- Un solo CSV nacional (~2,469 municipios)
- Join nativo por `cve_mun` con DENUE y con Censo
- Tabla destino: `coneval_pobreza_municipio`

**Fuente oficial:** [https://www.coneval.org.mx/Medicion/Paginas/PobrezaInicio.aspx](https://www.coneval.org.mx/Medicion/Paginas/PobrezaInicio.aspx)

---

## 5. Tablas nuevas (DDL)

```sql
-- Polígonos AGEB urbana del Marco Geoestadístico
CREATE TABLE IF NOT EXISTS ageb_urbana (
    id               SERIAL PRIMARY KEY,
    clave_ageb       TEXT UNIQUE NOT NULL,   -- ej: "0900100010011"
    cve_mun          TEXT NOT NULL,          -- ej: "09001"
    cve_ent          TEXT NOT NULL,          -- ej: "09"
    geom             GEOMETRY(MULTIPOLYGON, 4326) NOT NULL,
    area_km2         NUMERIC,
    created_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ageb_urbana_geom   ON ageb_urbana USING GIST(geom);
CREATE INDEX IF NOT EXISTS idx_ageb_urbana_mun    ON ageb_urbana(cve_mun);

-- Variables ITER por AGEB
CREATE TABLE IF NOT EXISTS censo_ageb_2020 (
    id               SERIAL PRIMARY KEY,
    clave_ageb       TEXT UNIQUE NOT NULL REFERENCES ageb_urbana(clave_ageb),
    cve_mun          TEXT NOT NULL,
    pobtot           INTEGER,
    psinder          INTEGER,    -- sin derechohabiencia
    p60ymas          INTEGER,    -- 60 y más años
    pocupada         INTEGER,
    p15ymas_an       INTEGER,    -- analfabetos 15+
    graproes         NUMERIC,    -- grado promedio escolaridad
    vph_autom        INTEGER,
    vph_pc           INTEGER,
    vph_inter        INTEGER,
    prom_hnv         NUMERIC,
    updated_at       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_censo_ageb_mun ON censo_ageb_2020(cve_mun);

-- Pobreza municipal CONEVAL
CREATE TABLE IF NOT EXISTS coneval_pobreza_municipio (
    id               SERIAL PRIMARY KEY,
    cve_mun          TEXT UNIQUE NOT NULL,
    nom_mun          TEXT,
    cve_ent          TEXT,
    año              INTEGER DEFAULT 2020,
    pobreza_pct          NUMERIC,
    pobreza_ext_pct      NUMERIC,
    carencia_salud_pct   NUMERIC,
    carencia_alim_pct    NUMERIC,
    carencia_edu_pct     NUMERIC,
    irs_score            NUMERIC,   -- Índice de Rezago Social CONEVAL
    updated_at           TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_coneval_ent ON coneval_pobreza_municipio(cve_ent);
```

---

## 6. Vistas materializadas

```sql
-- Vista principal: cada establecimiento DENUE + contexto AGEB + pobreza municipal
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_denue_enriquecido AS
SELECT
    d.id,
    d.nom_estab,
    d.clase_actividad_id,
    d.cve_municipio,
    d.geom,
    d.per_ocu,
    a.clave_ageb,
    -- Variables Censo
    c.pobtot,
    c.psinder,
    c.p60ymas,
    c.graproes,
    c.vph_autom,
    c.vph_inter,
    -- NSE sintético (0-100): auto + escolaridad + internet + ocupación
    ROUND(
        (COALESCE(c.vph_autom::numeric / NULLIF(c.pobtot,0), 0) * 25 +
         COALESCE(c.graproes / 12.0, 0) * 25 +
         COALESCE(c.vph_inter::numeric / NULLIF(c.pobtot,0), 0) * 25 +
         COALESCE(c.pocupada::numeric / NULLIF(c.pobtot,0), 0) * 25) * 100, 2
    ) AS nse_sintetico,
    -- Pobreza municipal CONEVAL
    p.pobreza_pct,
    p.carencia_salud_pct,
    p.irs_score
FROM denue d
LEFT JOIN ageb_urbana a
    ON ST_Within(d.geom, a.geom)
LEFT JOIN censo_ageb_2020 c
    ON a.clave_ageb = c.clave_ageb
LEFT JOIN coneval_pobreza_municipio p
    ON d.cve_municipio = p.cve_mun;

CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_denue_enriquecido_id ON mv_denue_enriquecido(id);
CREATE INDEX IF NOT EXISTS idx_mv_denue_enriquecido_ageb ON mv_denue_enriquecido(clave_ageb);
CREATE INDEX IF NOT EXISTS idx_mv_denue_enriquecido_mun  ON mv_denue_enriquecido(cve_municipio);

-- Potencial de mercado por municipio
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_potencial_mercado AS
SELECT
    c.cve_mun,
    c.pobtot,
    c.psinder,
    c.p60ymas,
    ROUND(c.psinder::numeric / NULLIF(c.pobtot,0) * 100, 2)    AS pct_psinder,
    ROUND(c.p60ymas::numeric / NULLIF(c.pobtot,0) * 100, 2)    AS pct_adultos_mayores,
    p.pobreza_pct,
    p.carencia_salud_pct,
    -- IMP: Índice de Mercado Potencial (0-100)
    ROUND(
        COALESCE(c.psinder::numeric / NULLIF(c.pobtot,0), 0) * 40 +
        COALESCE(c.p60ymas::numeric / NULLIF(c.pobtot,0), 0) * 30 +
        COALESCE(p.carencia_salud_pct / 100.0, 0) * 30,
        2
    ) * 100 AS imp_score
FROM censo_ageb_2020 c
LEFT JOIN coneval_pobreza_municipio p ON c.cve_mun = p.cve_mun
GROUP BY c.cve_mun, c.pobtot, c.psinder, c.p60ymas, p.pobreza_pct, p.carencia_salud_pct;
```

---

## 7. Preguntas habilitadas al completar Fase 1

### Capa DENUE × Censo (denominador real)

1. **Densidad correcta:** ¿Cuántos establecimientos por cada 10k habitantes sin derechohabiencia (`PSINDER`)? — no sobre población total
2. **Mapa de oportunidad:** ¿Qué AGEBs tienen alta `PSINDER` + alta `P60YMAS` + baja densidad de establecimientos? → score de oportunidad
3. **Desiertos calificados:** AGEBs sin establecimiento en 1km que además tienen alta `PSINDER` y alta `P60YMAS` → urgencia CRÍTICA / ALTA / MODERADA
4. **Demanda pediátrica:** ¿Dónde hay alta natalidad (`PROM_HNV`) y poca cobertura? → oportunidad foco pediátrico
5. **Adultos crónicos sin IMSS:** `P60YMAS × PSINDER / POBTOT` por AGEB → mercado de medicamentos de mantenimiento
6. **IVAF v1:** Score 0-100 por AGEB = f(densidad, PSINDER, P60YMAS, distancia_establecimiento)

### Capa DENUE × Censo × CONEVAL (capacidad de pago)

7. **Mercado real ajustado:** `PSINDER × (1 - pobreza_ext_pct)` — quién puede pagar, no solo quién no tiene IMSS
8. **IVAF v2:** Score mejorado que agrega `carencia_salud_pct` como cuarto componente
9. **Modelo de negocio por zona:** ¿Qué tipo de establecimiento tiene sentido según quintil IRS? — cadena premium en Q1, modelo popular en Q3-Q4, inviable en Q5
10. **Desiertos clasificados:** ¿Cuáles son "oportunidad comercial" vs "necesidad social" vs "bajo potencial"?
11. **Hipótesis carencia de salud:** ¿`carencia_salud_pct > 50%` predice alta demanda de servicios de primer nivel?
12. **IRS sintético por AGEB:** Construir el IRS de CONEVAL a nivel sub-municipal usando variables ITER — rompe la limitación de granularidad municipal

---

## 8. Queries de validación post-carga

```sql
-- 8.1 Verificar cobertura del join DENUE × AGEB
SELECT
    COUNT(*)                                    AS total_denue,
    COUNT(clave_ageb)                           AS con_ageb,
    ROUND(COUNT(clave_ageb)::numeric / COUNT(*) * 100, 2) AS pct_match
FROM mv_denue_enriquecido;
-- Esperado: >85% de establecimientos urbanos deberían tener AGEB asignado

-- 8.2 Top 10 municipios por IMP score
SELECT
    m.cve_mun,
    c.nom_mun,
    m.pobtot,
    m.pct_psinder,
    m.pct_adultos_mayores,
    m.imp_score
FROM mv_potencial_mercado m
JOIN coneval_pobreza_municipio c ON m.cve_mun = c.cve_mun
ORDER BY m.imp_score DESC
LIMIT 10;

-- 8.3 Desiertos críticos: AGEB sin establecimientos del sector con alta PSINDER
WITH ageb_sin_cobertura AS (
    SELECT
        a.clave_ageb,
        a.cve_mun,
        c.psinder,
        c.pobtot,
        ROUND(c.psinder::numeric / NULLIF(c.pobtot,0) * 100, 2) AS pct_psinder
    FROM ageb_urbana a
    JOIN censo_ageb_2020 c ON a.clave_ageb = c.clave_ageb
    WHERE NOT EXISTS (
        SELECT 1 FROM denue d
        WHERE ST_Within(d.geom, a.geom)
        -- Filtrar por SCIAN según el vertical analizado
    )
)
SELECT * FROM ageb_sin_cobertura
WHERE pct_psinder > 40
ORDER BY psinder DESC
LIMIT 20;
```

---

## 9. Valor en los dos modos de interfaz

### Modo Mapa (v0.4.0)
- **Polígonos AGEB** como capa base — color según NSE sintético o `pct_psinder`
- **Cloropleta de pobreza** municipal superpuesta a densidad de establecimientos DENUE
- **Puntos DENUE** coloreados por distancia al AGEB más vulnerable sin cobertura
- **Capa de desiertos** — polígonos rojos donde IVAF > umbral y densidad < 1 establecimiento/km²

### Modo Locust (v0.4.1)
- **Radar NSE:** 5 dimensiones (auto, PC, internet, escolaridad, ocupación) comparando municipios seleccionados
- **Scatter:** densidad DENUE vs. IMP score — detecta mercados sub-servidos
- **Barras:** distribución de establecimientos por quintil de pobreza municipal
- **Waterfall:** desglose del IMP score por componente (PSINDER, P60YMAS, carencia_salud)

---

## 10. Estrategia de versionado semántico

| Versión | Qué incluye | Estado |
|---------|-------------|--------|
| **v0.1.0** | DENUE base, API Hono, CLI analyze.ts, vistas mv_sector_summary + mv_coverage | ✅ Producción |
| **v0.1.x** | Patches: completar carga de 15 estados pendientes + Tlaxcala | En proceso |
| **v0.2.1** | **Fase 1: Censo 2020 AGEB + CONEVAL** — mv_denue_enriquecido + mv_potencial_mercado | **← Este documento** |
| **v0.2.2** | Fase 2: CE 2024 + CLUES + SESNSP | Pendiente |
| **v0.2.3** | Fase 3: Datatur + SINAIS + ENOE + ENIGH | Pendiente |
| **v0.3.x** | Fase 4: ENSANUT + ENVIPE + ENDUTIH + ENIGH 2024 | Pendiente |
| **v0.4.0** | Modo Mapa: MapLibre GL + deck.gl | Pendiente |
| **v0.4.1** | Modo Locust: ECharts visualizaciones analíticas | Pendiente |

**Convención:** `v0.FASE.PATCH` — el segundo dígito es la fase de datos; el tercero son correcciones dentro de esa fase.

---

## 11. Próximos pasos hacia Fase 2 (v0.2.2)

Una vez completada la Fase 1, el stack habilita automáticamente los prerrequisitos de Fase 2:

1. **CLUES se potencia** cuando cada punto GPS tiene su AGEB asignado y el IRS sintético calculado — cada unidad médica pública tendrá contexto demográfico completo
2. **CE 2024** se une a `mv_denue_enriquecido` por `cve_mun` — el revenue estimado por sector ya tendrá denominador de habitantes y capacidad de pago
3. **SESNSP** se cruza con municipios ya rankeados por IMP — el riesgo operacional se puede ponderar contra el potencial de mercado real

**Checklist de prerrequisitos para iniciar Fase 2:**
- [ ] `ageb_urbana` cargada con cobertura nacional (>95% AGEBs urbanas)
- [ ] `censo_ageb_2020` cargado con las 222 variables ITER
- [ ] `coneval_pobreza_municipio` cargado (2,469 municipios)
- [ ] `mv_denue_enriquecido` materializada y verificada (>85% match)
- [ ] `mv_potencial_mercado` materializada y verificada
- [ ] Endpoint API `/api/locust/radar-nse` funcional (smoke test)
- [ ] Endpoint API `/api/map/heatmap` con capa AGEB funcional (smoke test)

---

## 12. Prerrequisitos para iniciar Fase 1

- [x] DENUE base cargada (Fase 0 ✅ completada 2026-05-03)
- [x] PostGIS habilitado en Supabase con índice GIST en `denue.geom`
- [ ] Carga completa de los ~74K registros pendientes de Tlaxcala (v0.1.x patch)
- [ ] Completar ingestión de 15 estados pendientes en pipeline nacional (v0.1.x patch)
- [ ] Descargar ITER 2020 de INEGI (32 CSVs por entidad)
- [ ] Descargar Marco Geoestadístico 2020 (shapefiles AGEB urbana)
- [ ] Descargar CSV de medición de pobreza CONEVAL 2020 (nivel municipal)

---

*Documentación completa de Fase 2 (v0.2.2): `knowledge/denue-inteligencia/fase-2-ce2024-clues-sesnsp.md`*  
*Documentación completa de Fase 3 (v0.2.3): `/root/claude/projects/data-intelligence/docs/fase-3-detalle.md`*  
*Plan maestro: `/root/claude/projects/data-intelligence/docs/plan-integracion-datos-mexico.md`*
