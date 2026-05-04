# Fase 3 — Datatur + SINAIS + ENOE + ENIGH

**Estatus:** Pendiente (prerrequisito: Fases 1 y 2 completas)  
**Estimado:** 1-2 días de trabajo activo  
**Fecha documento:** 2026-05-03  

---

## Contexto del roadmap

| Fase | Fuentes | Estimado real |
|------|---------|---------------|
| **0 — DENUE base** | DENUE nacional | ✅ Completada 2026-05-03 |
| **1 — Censo + CONEVAL** | Censo 2020, CONEVAL | 1-2 días |
| **2 — CE 2024 + CLUES + SESNSP** | Censo Económico, infraestructura médica, seguridad | 2-3 días |
| **3 — Datatur + SINAIS + ENOE + ENIGH** | Turismo, egresos hospitalarios, empleo, gasto hogar | **1-2 días** |
| **Modo Mapa** | MapLibre + deck.gl | 2-3 días (frontend sobre API Fase 5) |
| **Modo Locust** | ECharts: barras, radar, 3D | 2-3 días (paralelo al mapa) |

**Total acumulado realista: ~10-12 días de trabajo activo para stack funcional y refinable.**

---

## Naturaleza de la Fase 3: Calibración + Join Selectivo

La Fase 3 combina dos tipos de fuente con mecánicas distintas:

| Tipo | Fuente | Granularidad | Mecánica |
|------|--------|--------------|----------|
| **Join municipal** | SINAIS (egresos hospitalarios) | Hospital → `cve_clues` → `cve_mun` | Join nativo vía CLUES |
| **Join municipal/estatal** | Datatur (ocupación hotelera) | `cve_mun` en destinos turísticos | Join donde aplica |
| **Calibrador regional** | ENOE (empleo/informalidad) | Entidad / Zona Metropolitana | Tabla de parámetros |
| **Calibrador regional** | ENIGH (gasto hogar) | Regional (6-8 regiones) | Tabla de parámetros |

SINAIS y Datatur enriquecen el score directamente. ENOE y ENIGH son **metadatos de calibración** — entran como constantes en la fórmula, no como filas en el join.

---

## Las cuatro fuentes de Fase 3

### 1. Datatur — Secretaría de Turismo (SECTUR)

**Qué es:** Estadísticas de ocupación hotelera, llegada de turistas, gasto turístico promedio por destino. Levantamiento mensual.

**Qué agrega que las fases anteriores no tienen:**
- `ocupacion_hotelera_pct` — % de habitaciones ocupadas por municipio × mes
- `turistas_nacionales` / `turistas_internacionales` — flujo real
- `gasto_promedio_turista` — capacidad de pago del visitante
- `ingresos_division_cuartos` — revenue del sector hospitalidad

**Mecánica de carga:**
- CSV descargable desde datatur.sectur.gob.mx
- Join por `cve_mun` en municipios con clave turística asignada (~200 destinos monitoreados)
- Para el resto: `NULL` — no confundir "sin dato" con "cero turismo"
- Clave de join: `cve_mun` de SECTUR debe mapearse a la clave INEGI (hay discrepancias en ~15 municipios)

**Uso en verticales:**
- Farmacias: menor — aplica solo en destinos turísticos (Los Cabos, Cancún, Puerto Vallarta, San Miguel de Allende)
- QSR / Restaurantes: alto — flujo turístico es predictor de demanda en SCIAN 722
- Xolo Rides / Transporte: alto — llegadas aéreas como proxy de demanda

**Fuente oficial:** https://www.datatur.sectur.gob.mx/SitePages/res_nal.aspx

---

### 2. SINAIS — Sistema Nacional de Información en Salud (SS / DGIS)

**Qué es:** Egresos hospitalarios, mortalidad por causa, morbilidad por municipio. Fuente: Dirección General de Información en Salud (DGIS), Secretaría de Salud.

**Qué agrega que CLUES no tiene:**
- CLUES = infraestructura (dónde están los hospitales, cuántas camas)
- SINAIS = demanda real (cuántos egresos, por qué causa, con qué diagnóstico)
- `causa_egreso` / `causa_defuncion` a nivel CIE-10
- `egresos_diabetes` / `egresos_hipertension` / `egresos_cancer` — morbilidad crónica
- `tasa_mortalidad_municipio` — mortalidad general y por causa específica

**Mecánica de carga:**
- Join primario: `cve_clues` → tabla `clues` → `cve_mun`
- Algunos datasets SINAIS ya traen `cve_mun` directo
- Requiere que CLUES esté cargado (Fase 2 prerrequisito)

**Por qué es el más potente de la Fase 3:**
- Municipios con alta mortalidad por diabetes/hipertensión → mercado de medicamentos crónicos **demostrado**, no inferido del Censo
- Egresos hospitalarios sin IMSS/ISSSTE → demanda de farmacias post-hospitalización (el momento de mayor gasto en medicamentos)
- Cruce con CLUES: egresos hospitalarios altos + pocas farmacias cercanas → oportunidad real cuantificada

**Fuente oficial:** https://www.dgis.salud.gob.mx/contenidos/sinais/s_egresoshosp.html

---

### 3. ENOE — Encuesta Nacional de Ocupación y Empleo (INEGI)

**Qué es:** Empleo formal/informal, salarios, sector de actividad. Levantamiento trimestral. Edición más reciente: Q1 2025.

**Limitación crítica — igual que ENIGH:**
- Representativa a nivel **entidad federativa y zonas metropolitanas**, no municipal
- No tiene `cve_mun` utilizable para join directo
- **No entra al pipeline de join** — igual que ENIGH

**Qué provee como calibrador:**
- `tasa_informalidad_entidad` — % de trabajadores sin prestaciones por entidad
- `ingreso_promedio_sector` — salario promedio por SCIAN a nivel estatal
- `pea_activa` — Población Económicamente Activa como denominador de mercado laboral

**Mecánica:** Se carga como tabla `parametros_enoe_entidad` — una fila por entidad, sin join municipal. Se usa para escalar estimaciones del modelo cuando el Censo 2020 ya cumplió 5+ años.

**Fuente oficial:** https://www.inegi.org.mx/programas/enoe/15ymas/

---

### 4. ENIGH — Encuesta Nacional de Ingresos y Gastos de los Hogares (INEGI)

**Qué es:** Gasto mensual por rubro (incluyendo salud y medicamentos) por decil de ingreso. Bienal. Edición más reciente: 2022 (nueva serie).

**Limitación crítica:**
- Representativa a nivel **regional** (~6-8 regiones), no municipal ni estatal
- No tiene `cve_mun` ni `cve_ent` utilizable
- **No entra al pipeline de join** — es un calibrador de parámetros

**Qué provee:**

| Parámetro | Uso concreto |
|---|---|
| Gasto mensual en medicamentos por decil | Estima revenue potencial por zona una vez que tienes el IRS sintético |
| % del ingreso destinado a salud por estrato | Calibra el ticket esperado en el score final |
| Distribución farmacia vs consulta vs hospitalización | Segmenta la demanda dentro del sector salud |
| Elasticidad precio por decil | Ajusta proyecciones de revenue en zonas de pobreza media |

**Mecánica:** Se carga como tabla `parametros_enigh_decil` — ~10 filas (una por decil). Se consulta al construir el score final, no en cada query operacional.

**Fuente oficial:** https://www.inegi.org.mx/programas/enigh/nc/2022/

---

## Preguntas que habilita la Fase 3

### Datatur — Mercado turístico

1. ¿Los municipios turísticos tienen sobre-representación de farmacias vs su población residente? → ¿el mercado ya encontró el turismo?
2. ¿Hay municipios con alto flujo turístico y poca farmacia? → oportunidad de farmacia orientada al visitante (ticket más alto)
3. ¿El gasto promedio del turista justifica un modelo diferente (marca blanca vs Similares)? → segmentación por destino
4. ¿Qué sectores DENUE (SCIAN 72 — hospitalidad) se benefician más del flujo turístico? → para Xolo Rides / QSR advertising

### SINAIS — Demanda de salud real

5. ¿Qué municipios tienen los mayores egresos hospitalarios por diabetes/hipertensión? → mercado de crónicos **demostrado**
6. ¿Dónde hay alta tasa de egreso hospitalario sin derechohabiencia? → máxima demanda de farmacia privada post-hospitalización
7. ¿El ratio egresos/camas hospitalarias indica hospitales saturados? → señal de demanda no cubierta
8. ¿Los municipios con alta mortalidad prematura (< 60 años) tienen correlación con baja densidad de farmacias? → hipótesis de impacto en outcomes de salud
9. ¿SINAIS confirma o contradice la hipótesis CONEVAL sobre carencia de salud? → validación cruzada de proxies

### Combinadas Fase 3 — Score acumulado

10. **Municipios de máxima prioridad real:** IVAF v2 alto + CE 2024 alto + SINAIS alto (egresos crónicos) + seguridad alta + NO zona turística (menor competencia estacional)
11. **Perfil de farmacia por municipio:**
    - Alta mortalidad crónica + PSINDER alta → farmacia con foco en crónicos (metformina, losartán, atorvastatina)
    - Turístico + NSE alto → farmacia de conveniencia (ticket alto, menor volumen)
    - Egresados hospitalarios + CLUES lejos → farmacia de especialidad o con delivery
12. **Ticket esperado calibrado:** IRS sintético × parámetros ENIGH × informalidad ENOE → estimación de revenue anualizado por zona

---

## Vistas materializadas

```sql
-- Perfil turístico: DENUE hospitalidad × ocupación × gasto turista
mv_perfil_turistico
  -- denue (SCIAN 72) × datatur_municipal × ocupacion_promedio_anual × gasto_turista

-- Demanda hospitalaria real
mv_demanda_hospitalaria
  -- sinais_egresos × clues (camas, consultorios) × cve_mun
  -- campos clave: tasa_egresos_cronicos, ratio_egresos_por_cama, pct_sin_derechohabiencia

-- Mercado laboral estatal (calibración)
mv_mercado_laboral
  -- PEA × tasa_informalidad × ingreso_promedio × cve_ent
```

---

## Tablas nuevas requeridas

```sql
-- Datatur: ocupación hotelera municipal × mes
CREATE TABLE datatur_municipal (
  cve_mun              TEXT,
  periodo              TEXT,       -- 'YYYY-MM'
  ocupacion_pct        NUMERIC,
  turistas_nacionales  INTEGER,
  turistas_internacionales INTEGER,
  gasto_promedio_turista NUMERIC,
  ingresos_cuartos     NUMERIC,
  PRIMARY KEY (cve_mun, periodo)
);

-- SINAIS: egresos hospitalarios por municipio × causa (colapsado)
CREATE TABLE sinais_municipal (
  cve_mun                TEXT,
  anio                   INTEGER,
  total_egresos          INTEGER,
  egresos_sin_derechohabiencia INTEGER,
  egresos_diabetes       INTEGER,
  egresos_hipertension   INTEGER,
  egresos_cancer         INTEGER,
  egresos_traumatismo    INTEGER,
  tasa_mortalidad_general NUMERIC,
  PRIMARY KEY (cve_mun, anio)
);

-- ENOE: parámetros de empleo por entidad (calibrador)
CREATE TABLE parametros_enoe_entidad (
  cve_ent               TEXT PRIMARY KEY,
  trimestre             TEXT,       -- 'YYYY-QN'
  pea_activa            INTEGER,
  tasa_informalidad     NUMERIC,
  ingreso_promedio_salud NUMERIC,  -- sector SCIAN 62
  ingreso_promedio_retail NUMERIC  -- sector SCIAN 46
);

-- ENIGH: parámetros de gasto por decil (calibrador — ~10 filas)
CREATE TABLE parametros_enigh_decil (
  decil                         INTEGER PRIMARY KEY,
  gasto_mensual_medicamentos    NUMERIC,
  gasto_mensual_consulta        NUMERIC,
  gasto_mensual_hospitalizacion NUMERIC,
  pct_ingreso_salud             NUMERIC,
  elasticidad_precio_medicamentos NUMERIC
);
```

---

## Queries de validación post-carga

```sql
-- Municipios con alta demanda crónica Y poca cobertura farmacéutica
SELECT 
  m.nombre_municipio,
  m.entidad,
  s.egresos_diabetes + s.egresos_hipertension AS egresos_cronicos,
  s.egresos_sin_derechohabiencia,
  COUNT(e.id) AS farmacias_privadas,
  ROUND((s.egresos_diabetes + s.egresos_hipertension) 
        / NULLIF(COUNT(e.id), 0), 1) AS egresos_cronicos_por_farmacia
FROM municipios m
JOIN sinais_municipal s ON s.cve_mun = m.cve_mun AND s.anio = 2023
LEFT JOIN establecimientos e 
  ON e.cve_mun = m.cve_mun AND e.codigo_act IN ('46591','46592')
GROUP BY m.cve_mun, m.nombre_municipio, m.entidad, 
         s.egresos_diabetes, s.egresos_hipertension, s.egresos_sin_derechohabiencia
HAVING s.egresos_sin_derechohabiencia > 500
ORDER BY egresos_cronicos_por_farmacia DESC
LIMIT 30;

-- Municipios turísticos con oportunidad farmacéutica
SELECT
  m.nombre_municipio,
  m.entidad,
  d.ocupacion_pct,
  d.gasto_promedio_turista,
  ivaf.score AS ivaf_v2,
  COUNT(e.id) AS farmacias_privadas
FROM municipios m
JOIN (
  SELECT cve_mun, 
         AVG(ocupacion_pct) AS ocupacion_pct,
         AVG(gasto_promedio_turista) AS gasto_promedio_turista
  FROM datatur_municipal 
  WHERE periodo >= '2024-01'
  GROUP BY cve_mun
) d ON d.cve_mun = m.cve_mun
LEFT JOIN ivaf_v2 ivaf ON ivaf.cve_mun = m.cve_mun
LEFT JOIN establecimientos e 
  ON e.cve_mun = m.cve_mun AND e.codigo_act IN ('46591','46592')
WHERE d.ocupacion_pct > 50
GROUP BY m.cve_mun, m.nombre_municipio, m.entidad, 
         d.ocupacion_pct, d.gasto_promedio_turista, ivaf.score
ORDER BY d.gasto_promedio_turista DESC
LIMIT 20;

-- Score final Fase 3: acumulado sobre score Fase 2
SELECT
  m.cve_mun,
  m.nombre_municipio,
  m.entidad,
  s2.score_fase2,
  COALESCE(sin.egresos_cronicos_norm, 0)    AS sinais_score,
  COALESCE(dat.turismo_norm, 0)             AS datatur_score,
  ROUND(
    (s2.score_fase2 * 0.65)
    + (COALESCE(sin.egresos_cronicos_norm, 0) * 0.25)
    + (COALESCE(dat.turismo_norm, 0) * 0.10)
  , 2) AS score_fase3
FROM municipios m
JOIN score_fase2_municipal s2 USING (cve_mun)
LEFT JOIN (
  SELECT cve_mun,
         LEAST(
           (egresos_diabetes + egresos_hipertension) / 100.0,
           100
         ) AS egresos_cronicos_norm
  FROM sinais_municipal WHERE anio = 2023
) sin USING (cve_mun)
LEFT JOIN (
  SELECT cve_mun,
         LEAST(gasto_promedio_turista / 5000.0 * 100, 100) AS turismo_norm
  FROM datatur_municipal WHERE periodo LIKE '2024-%'
  GROUP BY cve_mun
  ORDER BY MAX(periodo)
) dat USING (cve_mun)
ORDER BY score_fase3 DESC NULLS LAST
LIMIT 50;
```

---

## Score final acumulado al terminar Fase 3

Después de las tres fases tienes **una sola fila por municipio** que combina todas las capas:

```
score_final = f(
  ivaf_v2,                   -- Fase 1: densidad + demografía + pobreza + carencia salud
  score_fase2,               -- Fase 2: CE 2024 + CLUES + SESNSP
  egresos_cronicos_norm,     -- Fase 3: SINAIS — demanda de salud real
  turismo_norm,              -- Fase 3: Datatur — mercado turístico
  ticket_esperado,           -- Fase 3: ENIGH decil × IRS sintético (calibrador)
  ajuste_informalidad,       -- Fase 3: ENOE tasa_informalidad_entidad (calibrador)
)
```

**Ponderación sugerida (ajustable por vertical):**
```
score_final = (ivaf_v2 × 0.30)
            + (score_fase2 × 0.35)
            + (sinais × 0.20)
            + (turismo × 0.05)
            + calibradores_enigh_enoe × [ajuste multiplicativo]
```

Este score alimenta directamente:
- **Modo Locust:** barras de ranking, radar multi-eje, scatter 3D (oportunidad × tamaño × riesgo)
- **Modo Mapa:** capa de calor municipal, clasificación cromática de oportunidad

---

## Prerrequisitos antes de iniciar Fase 3

- [x] DENUE nacional cargado (Fase 0) — ✅ completado
- [ ] Censo 2020 cargado (`censo_municipal`, `censo_ageb`) — Fase 1 pendiente
- [ ] CONEVAL municipal cargado (`coneval_municipal`) — Fase 1 pendiente
- [ ] IVAF v1 e IVAF v2 construidos — generados en Fase 1
- [ ] CE 2024 cargado (`ce2024_municipal`) — Fase 2 pendiente
- [ ] CLUES cargado (`clues`) — **Prerrequisito directo de SINAIS** (join `cve_clues` → `cve_mun`)
- [ ] SESNSP cargado (`sesnsp_municipal`) — Fase 2 pendiente
- [ ] `score_fase2_municipal` como vista materializada — generada en Fase 2

---

## Estimado de implementación

| Tarea | Tiempo |
|-------|--------|
| Descarga y limpieza Datatur (CSV mensual por año) | 2-3 horas |
| Carga Datatur + mapeo cve_mun SECTUR → INEGI | 1-2 horas |
| Descarga SINAIS egresos + normalización CIE-10 | 3-4 horas |
| Join SINAIS → CLUES → cve_mun + carga | 1-2 horas |
| Carga ENOE parámetros estatales | 1 hora |
| Carga ENIGH parámetros decil | 1 hora |
| Vistas materializadas + score final | 2-3 horas |
| Queries de validación y documentación | 1-2 horas |
| **Total** | **12-18 horas (~1-2 días activos)** |

---

## Conexión con verticales

El mismo stack aplica a cualquier vertical — solo cambia el código SCIAN de interés:

| Vertical | SINAIS relevante | Datatur relevante | ENOE relevante |
|----------|-----------------|-------------------|----------------|
| **Farmacias** | Egresos crónicos (diabetes, HTA) sin derechohabiencia | Menor (solo destinos turísticos) | Informalidad → ticket |
| **Hospitales privados** | Egresos totales × tipo de unidad pública (competencia) | Turismo médico en fronteras/destinos | Empleo en sector salud |
| **Restaurantes QSR** | N/A | **Alto** — flujo turístico directo | Ingreso promedio por estrato |
| **Escuelas privadas** | N/A | N/A | Informalidad (padres que no pueden pagar) |
| **Xolo Rides** | N/A | **Alto** — llegadas aéreas, gasto turista | Población activa × transporte |
| **Conveniencia / abarrotes** | N/A | Moderado (consumibles turistas) | Ingreso promedio → ticket |

---

## Nota SINAIS: join en dos pasos

SINAIS no tiene `cve_mun` directo en todos sus datasets. El join es:

```
sinais_egreso.cve_clues  →  clues.clave_clues  →  clues.cve_mun
```

Esto significa que CLUES debe estar cargado **antes** de intentar cargar SINAIS. El script de ingestión debe:
1. Verificar que `clues` tiene datos
2. Hacer el join en memoria durante la carga, no post-carga
3. Agregar a nivel `cve_mun` antes de insertar en `sinais_municipal`

Si `cve_clues` no encuentra match en `clues` → registrar en log de carga como `unmatched_clues`, no descartar silenciosamente.
