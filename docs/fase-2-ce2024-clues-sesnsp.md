# Fase 2 — CE 2024 + CLUES + SESNSP

**Estatus:** CLUES ✅ shipped 2026-05-04. CE 2024 + SESNSP **bloqueados — requieren URLs operadas por humano.** Re-probado 2026-05-05 (ver §"Verificación 2026-05-05" al final).  
**Estimado:** 2-3 días de trabajo activo  
**Fecha documento:** 2026-05-03 (actualizado 2026-05-05)

---

## Contexto del roadmap

| Fase                             | Fuentes                                            | Estimado real                        |
| -------------------------------- | -------------------------------------------------- | ------------------------------------ |
| **0 — DENUE base**               | DENUE nacional                                     | ✅ Completada 2026-05-03             |
| **1 — Censo + CONEVAL**          | Censo 2020, CONEVAL                                | 1-2 días (siguiente)                 |
| **2 — CE 2024 + CLUES + SESNSP** | Censo Económico, infraestructura médica, seguridad | **2-3 días**                         |
| **3 — Datatur + SINAIS + ENOE**  | Turismo, mortalidad, empleo                        | 1-2 días                             |
| **Modo Mapa**                    | MapLibre + deck.gl                                 | 2-3 días (frontend sobre API Fase 5) |
| **Modo Locust**                  | ECharts: barras, radar, 3D                         | 2-3 días (paralelo al mapa)          |

**Total acumulado realista: ~10-12 días de trabajo activo para stack funcional y refinable.**

---

## Las tres fuentes de Fase 2

### 1. CE 2024 — Censo Económico (INEGI)

**Qué es:** Levantamiento quinquenal de INEGI sobre actividad económica de todos los establecimientos del país. 2024 es el más reciente.

**Qué agrega que DENUE no tiene:**

- `valor_agregado` — producción neta por sector/municipio
- `remuneraciones` — masa salarial → proxy de formalidad
- `personal_ocupado_total` — empleo formal vs. DENUE que usa rangos
- `activos_fijos` — capitalización del sector
- `ingresos_por_suministro_de_bienes_y_servicios` — revenue real (no proxy)

**Mecánica de carga:**

- CSV por entidad federativa (32 archivos)
- Join por `cve_mun` (6 dígitos: 2 entidad + 3 municipio)
- Tabla destino: `ce2024_municipal` (~2,469 filas al colapsar a municipio)

**Fuente oficial:** [https://www.inegi.org.mx/programas/ce/2024/](https://www.inegi.org.mx/programas/ce/2024/)

---

### 2. CLUES — Catálogo de Infraestructura Médica (SS / DGIS)

**Qué es:** Registro nacional de todas las unidades médicas públicas y algunas privadas del Sistema de Salud mexicano.

**Qué agrega:**

- Ubicación GPS de hospitales, clínicas, IMSS, ISSSTE, SSA, SEDENA, PEMEX, IMSS-Bienestar
- `tipo_unidad` — primer nivel (consultorios), segundo (especialidades), tercer nivel (hospitales de alta complejidad)
- `consultorios`, `camas_censables`, `camas_no_censables`
- `institucion` — diferencia IMSS vs SSA vs ISSSTE

**Mecánica de carga:**

- Un solo CSV nacional (~25,000 registros)
- Tiene coordenadas lat/lon → carga directa a PostGIS o Supabase con columna `geom`
- Join con DENUE por proximidad geoespacial (ST_DWithin) + por `cve_mun`

**Fuente oficial:** [https://www.gob.mx/salud/documentos/datos-abiertos-252529](https://www.gob.mx/salud/documentos/datos-abiertos-252529)

---

### 3. SESNSP — Incidencia Delictiva (Secretariado Ejecutivo SNS)

**Qué es:** Cifras mensuales de delitos del fuero común denunciados por municipio, reportadas por las fiscalías estatales.

**Qué agrega:**

- `robo_a_negocio` — riesgo operacional directo para cualquier establecimiento
- `homicidio_doloso` — proxy de violencia general del municipio
- `extorsion` — impacto en rentabilidad real de negocios
- Series históricas mensuales → permite ver tendencia, no solo snapshot

**Mecánica de carga:**

- CSV mensual descargable, acumulable por año
- Join por `cve_mun`
- Tabla destino: `sesnsp_municipal` con columna `periodo` (YYYY-MM)

**Fuente oficial:** [https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva](https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva)

---

## Preguntas que habilita la Fase 2

### CE 2024 — Revenue y formalidad del sector

1. ¿Cuánto factura el sector farmacia (46591+46592) por municipio? → tamaño de mercado real, no estimado
2. ¿Cuál es el valor agregado por empleado en farmacias? → proxy de productividad / margen
3. ¿Qué municipios tienen alta remuneración en el sector? → señal de cadenas formales dominantes
4. ¿Dónde hay discrepancia entre establecimientos DENUE y empleados CE? → detecta sub-registro o micronegocios
5. ¿Qué sectores económicos dominan por municipio? → contexto de demanda (¿es zona industrial, comercial, residencial?)

### CLUES — Infraestructura pública y brechas de acceso

6. ¿Cuántas farmacias privadas hay por cada unidad médica pública en el municipio?
7. **Desierto total de salud:** AGEBs sin farmacia + sin CLUES en 2km → necesidad crítica sin atender
8. ¿Las farmacias privadas se ubican cerca de unidades CLUES? → ¿capturan la demanda post-consulta?
9. ¿Qué municipios tienen alta capacidad hospitalaria pública pero poca farmacia privada? → oportunidad de captación de egresados hospitalarios
10. ¿Dónde hay solo unidades de primer nivel CLUES (sin hospitales)? → mayor dependencia de farmacia privada para medicamentos especializados
11. ¿Las zonas con más CLUES por habitante tienen menos farmacias privadas? → ¿la oferta pública inhibe el mercado privado?

### SESNSP — Viabilidad operacional

12. ¿Qué municipios tienen `robo_a_negocio` > umbral X? → descartarlos para apertura sin análisis adicional de seguridad
13. ¿La densidad de farmacias se correlaciona negativamente con incidencia delictiva? → ¿el mercado ya preció el riesgo?
14. ¿Dónde hay alta oportunidad (IVAF v2) + bajo riesgo delictivo? → **los municipios objetivo reales**
15. Tendencia de seguridad en últimos 24 meses → ¿el municipio está mejorando o deteriorándose?

### Combinadas — El score definitivo

16. **Score de ubicación Fase 2:**

    ```
    score = (ivaf_v2 × 0.4)
          + (revenue_ce_normalizado × 0.2)
          + (clues_proximidad × 0.15)
          + (seguridad_inversa × 0.25)
    ```

    → Una sola cifra por municipio para decisión de apertura

17. **Matriz de decisión completa:**

| Zona                                                 | Diagnóstico                               |
| ---------------------------------------------------- | ----------------------------------------- |
| IVAF alto + CE alto + CLUES lejos + seguridad alta   | ⭐⭐⭐ Prioridad máxima de apertura       |
| IVAF alto + CE medio + CLUES cerca + seguridad media | ⭐⭐ Evaluar modelo (Similares vs cadena) |
| IVAF alto + pobreza extrema + CE bajo                | 🔴 Necesidad social — no rentable         |
| IVAF bajo + CE alto + seguridad baja                 | 🟡 Zona saturada — no entrar              |
| Cualquier perfil + `robo_a_negocio` > umbral         | ⛔ Descartar hasta mejorar seguridad      |

---

## Tablas nuevas requeridas

```sql
-- CE 2024 colapsado a municipio
CREATE TABLE ce2024_municipal (
  cve_mun         TEXT PRIMARY KEY,
  codigo_act      TEXT,           -- SCIAN a 6 dígitos
  nombre_act      TEXT,
  num_establecimientos INTEGER,
  personal_ocupado_total INTEGER,
  remuneraciones  NUMERIC,
  valor_agregado  NUMERIC,
  ingresos        NUMERIC,
  activos_fijos   NUMERIC
);

-- CLUES — unidades médicas públicas con coordenadas
CREATE TABLE clues (
  clave_clues     TEXT PRIMARY KEY,
  nombre          TEXT,
  institucion     TEXT,
  tipo_unidad     TEXT,           -- 'UNIDAD DE CONSULTA EXTERNA', 'HOSPITAL GENERAL', etc.
  nivel_atencion  INTEGER,        -- 1, 2, 3
  camas_censables INTEGER,
  consultorios    INTEGER,
  cve_mun         TEXT,
  lat             NUMERIC,
  lon             NUMERIC
  -- agregar columna geom para PostGIS si Supabase lo soporta
);

-- SESNSP — incidencia delictiva mensual
CREATE TABLE sesnsp_municipal (
  cve_mun              TEXT,
  periodo              TEXT,       -- 'YYYY-MM'
  robo_a_negocio       INTEGER,
  homicidio_doloso     INTEGER,
  extorsion            INTEGER,
  robo_transeuntes     INTEGER,
  PRIMARY KEY (cve_mun, periodo)
);
```

---

## Queries de validación post-carga

```sql
-- Municipios con alta oportunidad Y baja seguridad (a descartar)
SELECT
  m.nombre_municipio,
  m.entidad,
  ivaf.score AS ivaf_v2,
  s.robo_a_negocio_promedio_12m
FROM municipios m
JOIN ivaf_v2 ivaf USING (cve_mun)
JOIN (
  SELECT cve_mun, avg(robo_a_negocio) AS robo_a_negocio_promedio_12m
  FROM sesnsp_municipal
  WHERE periodo >= '2025-05'
  GROUP BY cve_mun
) s USING (cve_mun)
WHERE ivaf.score > 60
ORDER BY s.robo_a_negocio_promedio_12m DESC
LIMIT 20;

-- Desiertos totales de salud (sin farmacia + sin CLUES en 2km)
-- Requiere PostGIS o cálculo por cve_mun aproximado
SELECT
  m.cve_mun,
  m.nombre_municipio,
  COUNT(DISTINCT e.id) AS farmacias_en_municipio,
  COUNT(DISTINCT c.clave_clues) AS clues_en_municipio,
  censo.psinder,
  censo.p60ymas
FROM municipios m
LEFT JOIN establecimientos e
  ON e.cve_mun = m.cve_mun AND e.codigo_act IN ('46591','46592')
LEFT JOIN clues c ON c.cve_mun = m.cve_mun
LEFT JOIN censo_municipal censo ON censo.cve_mun = m.cve_mun
GROUP BY m.cve_mun, m.nombre_municipio, censo.psinder, censo.p60ymas
HAVING COUNT(DISTINCT e.id) = 0 AND COUNT(DISTINCT c.clave_clues) = 0
  AND censo.psinder > 5000
ORDER BY censo.psinder DESC;

-- Score combinado Fase 2 por municipio (Farmacias)
SELECT
  m.cve_mun,
  m.nombre_municipio,
  m.entidad,
  ivaf.score                           AS ivaf_score,
  ce.ingresos / NULLIF(ce.num_establecimientos, 0) AS revenue_por_estab,
  clues_cnt.total                      AS unidades_clues,
  seg.robo_promedio                    AS robo_negocio_12m,
  ROUND(
    (ivaf.score * 0.4)
    + (LEAST(ce.ingresos / 1000000.0, 100) * 0.2)
    + (LEAST(clues_cnt.total * 5.0, 100) * 0.15)
    + (GREATEST(100 - (seg.robo_promedio / 10.0), 0) * 0.25)
  , 2) AS score_fase2
FROM municipios m
JOIN ivaf_v2 ivaf USING (cve_mun)
LEFT JOIN ce2024_municipal ce ON ce.cve_mun = m.cve_mun AND ce.codigo_act LIKE '465%'
LEFT JOIN (SELECT cve_mun, count(*) AS total FROM clues GROUP BY 1) clues_cnt USING (cve_mun)
LEFT JOIN (
  SELECT cve_mun, avg(robo_a_negocio) AS robo_promedio
  FROM sesnsp_municipal WHERE periodo >= '2024-05'
  GROUP BY 1
) seg USING (cve_mun)
ORDER BY score_fase2 DESC NULLS LAST
LIMIT 50;
```

---

## Prerrequisitos antes de iniciar Fase 2

- [x] DENUE nacional cargado (Fase 0) — ✅ completado
- [ ] Censo 2020 cargado (`censo_municipal`, `censo_ageb`) — **Fase 1 pendiente**
- [ ] CONEVAL municipal cargado (`coneval_municipal`) — **Fase 1 pendiente**
- [ ] IVAF v1 e IVAF v2 como vistas materializadas — generados en Fase 1
- [ ] Supabase con extensión PostGIS habilitada (para joins geoespaciales con CLUES)

---

## Estimado de implementación

| Tarea                                             | Tiempo                              |
| ------------------------------------------------- | ----------------------------------- |
| Descarga y limpieza CE 2024 (32 CSVs por entidad) | 4-6 horas                           |
| Carga CE 2024 a Supabase + validación             | 2-3 horas                           |
| Descarga CLUES + normalización + carga            | 2-3 horas                           |
| Descarga SESNSP (2024-2026) + carga               | 1-2 horas                           |
| Queries de validación y vistas materializadas     | 3-4 horas                           |
| Documentación de hallazgos                        | 1-2 horas                           |
| **Total**                                         | **13-20 horas (~2-3 días activos)** |

---

## Conexión con verticales

El mismo stack CE 2024 + CLUES + SESNSP aplica a **cualquier vertical**:

| Vertical               | CE 2024 (código SCIAN) | CLUES relevante                                 | SESNSP relevante                 |
| ---------------------- | ---------------------- | ----------------------------------------------- | -------------------------------- |
| Farmacias              | 465                    | Todas las unidades                              | Robo a negocio                   |
| Hospitales privados    | 622                    | Hospitales públicos como competencia/referencia | Robo + homicidio                 |
| Restaurantes           | 722                    | N/A                                             | Robo a negocio + extorsión       |
| Escuelas privadas      | 611                    | N/A                                             | Homicidio (seguridad perimetral) |
| Gimnasios              | 713                    | N/A                                             | Robo + extorsión                 |
| Conveniencia/abarrotes | 461                    | N/A                                             | Robo a negocio                   |

---

## Nota sobre ENIGH — Parámetros de calibración (Fase 3)

**Decisión:** El ENIGH **no entra al pipeline de join**. No es una tabla más.

**Por qué:** La encuesta es representativa a nivel regional (6-8 regiones), no municipal. No tiene `cve_mun` utilizable. Intentar un join produciría datos incorrectos.

**Dónde sí aplica:** Como **tabla de parámetros estáticos** que calibran el modelo analítico después de que el IVAF esté construido.

| Parámetro que provee ENIGH                           | Uso concreto                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| Gasto mensual en medicamentos por decil de ingreso   | Estima revenue potencial por zona una vez que tienes el IRS sintético |
| % del ingreso destinado a salud por estrato          | Calibra el ticket esperado en el score IVAF v2                        |
| Distribución farmacia vs consulta vs hospitalización | Segmenta la demanda dentro del sector salud                           |
| Elasticidad precio por decil                         | Ajusta proyecciones de revenue en zonas de pobreza media              |

**Cuándo usarlo:** En Fase 3 junto con ENOE — ambas son fuentes regionales que **calibran parámetros del modelo**, no fuentes de join. Se cargan como una sola tabla de referencia estática (`parametros_enigh_decil`) que se consulta al momento de construir el score final, no en cada query operacional.

**Resumen:**

> ENIGH = metadatos de calibración. Entra como constante en la fórmula, no como fila en el join.

---

## Verificación 2026-05-05 — qué bloquea CE 2024 + SESNSP

Re-probadas las dos fuentes pendientes de v0.2.2. Ambas siguen requiriendo intervención humana, con confirmación adicional sobre el mecanismo de bloqueo:

### CE 2024 (Censos Económicos 2024 — INEGI)

- `https://www.censoseconomicos2024.mx/datosabiertos/` → 404
- Probes directos a candidatos de ZIP/CSV en `inegi.org.mx/contenidos/programas/ce/2024/datosabiertos/*` → todos 200 con HTML de **2,263 bytes** (decoy de UA-gating estándar de INEGI). Idéntico al resultado del 2026-05-04.
- **Bloqueo:** la SPA de `censoseconomicos2024.mx` renderiza los enlaces de descarga vía JS; las URLs reales se generan client-side y no son externamente derivables.
- **Acción del operador:** abrir el sitio en navegador, copiar las URLs reales de la pestaña "Datos abiertos" y pasármelas para escribir el loader.

### SESNSP (Incidencia Delictiva del Fuero Común)

- `gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva` → 200, **pero el cuerpo es 1,869 bytes con `<title>Challenge Validation</title>`** (gate anti-bot tipo Cloudflare). Lo mismo aplica al slug `incidencia-delictiva-del-fuero-comun-nueva-metodologia`.
- Probes directos a `gob.mx/cms/uploads/attachment/file/*/IDEFC_NM_*.csv` (patrones documentados en otras fuentes) → mismo gate de 1,869 bytes. **Cambio respecto al 2026-05-04**: ese día los slugs devolvían 404; ahora hay un challenge wall activo. La descarga directa con `curl`/`wget` es imposible.
- `datos.gob.mx` CKAN (`/busca/api/3/action/package_search`) no devuelve resultados para "incidencia delictiva" sin auth/UA específico.
- **Acción del operador:** descargar el CSV mensual desde el navegador (autenticado por la sesión que pasa el challenge), guardarlo localmente y pasarme la ruta para alimentar el loader.

### Implicación de calendario

Se cierra v0.2.2 como **parcialmente entregada** (CLUES ✅, CE 2024 + SESNSP deferidas). El roadmap de Fase 2 no avanza sin operator-input; los loaders están diseñados (esquema, índices, mecánica de join) pero no se pueden cablear hasta tener bytes reales.
