# ENSANUT × DENUE-Salud — Análisis del Problema y Plan de Integración

> **Estado:** Análisis técnico + plan de ejecución  
> **Fecha:** 2026-05-03  
> **Contexto:** Fase 4 del pipeline de integración de datos México  

---

## 1. El Problema Real (por qué el join "directo" no existe)

### 1.1 Cómo funciona ENSANUT internamente

ENSANUT Continua es una **encuesta de hogares muestral**. No mide a toda la población — selecciona una muestra probabilística y luego aplica **factores de expansión** para inferir prevalencias a nivel poblacional.

La arquitectura del muestreo es:

```
Nación
 └── Estrato (urbano alto / urbano bajo / rural)
      └── UPM — Unidad Primaria de Muestreo (grupos de manzanas)
           └── Vivienda
                └── Persona encuestada  ← el microdato
```

Cada persona en los microdatos trae un campo `factor_exp` (o `fac_mod`, según la edición). Ese número dice: *"esta persona representa a N personas en la población real"*. Sin aplicar ese factor, cualquier suma o promedio es estadísticamente inválido.

### 1.2 El dominio de estimación = el techo de granularidad

ENSANUT está **diseñada para ser representativa** en:
- Nacional
- Entidad federativa (32 estados)
- Estrato urbano/rural dentro de cada entidad

**No está diseñada para ser representativa a nivel:**
- Municipio (2,469 municipios)
- Localidad
- AGEB (64,313 zonas)
- Punto geográfico

Esto no es un bug — es una decisión estadística intencional. La muestra es demasiado pequeña para garantizar estimaciones confiables por debajo del estrato estatal. Forzar un join a nivel municipio o AGEB produce **estimaciones con errores estándar enormes**, potencialmente no publicables y estadísticamente sin sentido.

### 1.3 La trampa del lat/lon en microdatos

Algunos microdatos del INEGI incluyen coordenadas aproximadas de la vivienda o de la UPM. La tentación obvia es:

```sql
-- ❌ ESTO ES INCORRECTO
UPDATE establecimientos e
SET prevalencia_diabetes = (
  SELECT AVG(tiene_diabetes) * factor_exp
  FROM ensanut_microdatos m
  WHERE ST_DWithin(e.geom, m.vivienda_geom, 5000)
)
```

Este query produce un número. El número **es estadísticamente inválido** porque:
1. Promedia factores de expansión diseñados para escalar a nivel estatal, no local
2. Ignora el diseño complejo de la muestra (estratos, conglomerados)
3. Las UPM no son una muestra representativa del municipio — son una muestra representativa del estrato estatal

---

## 2. Lo que SÍ podemos hacer — Tres rutas viables

### Ruta A: Estimación Directa por Estrato Estatal (recomendada como base)

**Qué es:** Calcular prevalencias correctamente con los factores de expansión, al nivel que ENSANUT garantiza: entidad × estrato urbano/rural.

**Resultado:** Una tabla de ~64 filas (32 estados × 2 estratos):

```
estado | estrato    | prev_diabetes | prev_hipertension | prev_obesidad | n_encuestados | error_estandar
CDMX   | urbano     | 12.3%         | 24.1%             | 36.8%         | 847           | ±1.2pp
CDMX   | rural      | 9.1%          | 21.3%             | 31.2%         | 203           | ±3.1pp
JAL    | urbano     | 10.8%         | 22.7%             | 34.1%         | 612           | ±1.8pp
...
```

**Join con DENUE:**
```sql
-- ✅ ESTO ES CORRECTO Y VÁLIDO
ALTER TABLE establecimientos ADD COLUMN ensanut_estrato VARCHAR(20);

UPDATE establecimientos e
SET ensanut_estrato = CASE
  WHEN e.entidad = 'CDMX' AND e.tamanio_localidad >= 15000 THEN 'CDMX_urbano'
  ELSE e.entidad || '_' || CASE WHEN e.tamanio_localidad >= 15000 THEN 'urbano' ELSE 'rural' END
END;

-- Luego join por esa clave
SELECT 
  e.nombre,
  e.clee,
  s.prev_diabetes,
  s.prev_hipertension
FROM establecimientos e
JOIN ensanut_prevalencias_estrato s ON s.clave = e.ensanut_estrato
WHERE e.actividad_scian LIKE '621%';  -- establecimientos de salud
```

**Limitación:** Todos los hospitales del Estado de México urbano reciben el mismo valor de prevalencia. Es una asignación contextual, no una medición local. Pero es **estadísticamente honesta y publicable**.

---

### Ruta B: Small Area Estimation (SAE) — Estimación en Área Pequeña

**Qué es:** Técnica estadística para inferir métricas a niveles sub-muestrales usando modelos. Se usa globalmente para descender encuestas nacionales a municipios, condados o census tracts.

**Cómo funciona:**

```
ENSANUT (muestra de personas)
    ↓ modelo logístico con covariables
Censo 2020 (toda la población, por AGEB)
    ↓ aplicar coeficientes del modelo a cada AGEB
Estimación sintética por AGEB
```

El modelo dice: *"Dado que una persona con estas características (edad, escolaridad, NSE, urbano/rural) tiene X% de probabilidad de tener diabetes según ENSANUT, y el Censo me dice cuántas personas con esas características hay en cada AGEB..."*

**Variables del Censo que actúan como predictoras:**
- `P_60YMAS` / `POBTOT` → proporción de adultos mayores (correlaciona con diabetes, hipertensión)
- `GRAPROES` → escolaridad promedio (proxy NSE → obesidad, sedentarismo)
- `VPH_AUTOM` / `TVIVPARHAB` → NSE de vivienda
- `PCON_DISC` → ya incluye discapacidad por enfermedad crónica

**Resultado:** Prevalencias estimadas por AGEB con intervalos de confianza. No son mediciones reales — son **estimaciones sintéticas** calibradas con encuesta + Censo.

**Complejidad:** Alta. Requiere:
- Modelo logístico o Fay-Herriot en R o Python (`sae`, `emdi` packages)
- Manejo correcto de pesos de encuesta (`survey` package en R)
- Validación cruzada con estratos donde SÍ hay suficiente muestra

**Validez:** Publicable si se documentan los supuestos. El CDC usa exactamente esta metodología para el programa "500 Cities" / "PLACES" de EEUU — prevalencias de diabetes por census tract para 30,000 áreas.

---

### Ruta C: Proxy Variables desde el Censo (workaround inmediato)

**Qué es:** Usar variables del Censo 2020 como proxies de demanda de salud, sin tocar los microdatos de ENSANUT en absoluto.

**Lógica:** ENSANUT dice que la diabetes está fuertemente correlacionada con edad, NSE, sedentarismo, obesidad. El Censo tiene proxies de todo eso. Si no podemos bajar la prevalencia al municipio, sí podemos construir un **índice de riesgo** que captura la misma señal.

```python
# Índice de Vulnerabilidad de Salud (IVS) por AGEB
IVS = (
    0.35 × (P_60YMAS / POBTOT)       # adultos mayores
    + 0.25 × (1 - GRAPROES/15)       # baja escolaridad (invertido)
    + 0.20 × (1 - VPH_AUTOM/TVIVPARHAB)  # bajo NSE
    + 0.20 × (PCON_DISC / POBTOT)    # discapacidad existente
)
# Normalizado 0-100. Alta IVS = alta demanda potencial de salud.
```

**Ventaja:** Se puede calcular hoy, con los datos del Censo que ya estamos ingiriendo en Fase 1. No requiere procesar microdatos de ENSANUT.

**Limitación:** No es prevalencia de una enfermedad específica — es un índice compuesto. Suficiente para análisis de mercado y decisiones de expansión, pero no para estudios epidemiológicos.

---

## 3. Decisión recomendada — Las tres rutas son complementarias, no excluyentes

| Ruta | Cuándo usar | Tiempo | Validez estadística |
|------|------------|--------|---------------------|
| **C — Proxy Censo** | Dashboard comercial, análisis de mercado EurekaMD | Ya (Fase 1) | Alta para decisiones de negocio |
| **A — Estatal directa** | Reportes de cobertura, análisis epidemiológico regional | 1-2 días | Alta, publicable |
| **B — SAE municipal** | Producto diferenciado, análisis profundo, publicación científica | 2-3 semanas | Alta si se documenta, publicable |

**Para Fase 4 del pipeline:**

```
Fase 4a (inmediata, dentro de Fase 1):  Ruta C — IVS por AGEB desde Censo
Fase 4b (después de Fase 1):            Ruta A — prevalencias estatales ENSANUT correctas
Fase 4c (producto premium, Q3 2026):    Ruta B — SAE municipal con R + Censo + ENSANUT
```

---

## 4. Plan de Ejecución

### Fase 4a — IVS por AGEB (2 días, dentro de Fase 1)

**Prerequisito:** Censo 2020 AGEBs cargado (Fase 1).

```sql
-- Nueva vista materializada
CREATE MATERIALIZED VIEW mv_ageb_salud AS
SELECT
  cvegeo,
  POBTOT,
  P_60YMAS,
  PCON_DISC,
  GRAPROES,
  VPH_AUTOM,
  -- Índice de Vulnerabilidad de Salud (0-100)
  ROUND(
    (0.35 * COALESCE(P_60YMAS::float/NULLIF(POBTOT,0), 0)
    + 0.25 * (1 - LEAST(COALESCE(GRAPROES::float/15, 0), 1))
    + 0.20 * (1 - COALESCE(VPH_AUTOM::float/NULLIF(TVIVPARHAB,0), 0))
    + 0.20 * COALESCE(PCON_DISC::float/NULLIF(POBTOT,0), 0)) * 100
  , 2) AS ivs_salud
FROM censo_ageb_2020;

-- Join a establecimientos de salud
SELECT 
  e.nombre_act,
  e.municipio,
  COUNT(*) as establecimientos,
  AVG(a.ivs_salud) as ivs_zona,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY a.ivs_salud) as ivs_mediana
FROM establecimientos e
JOIN mv_ageb_enriched a ON a.cvegeo = e.ageb
WHERE e.actividad_scian LIKE '621%'
  OR e.actividad_scian LIKE '622%'  -- hospitales
  OR e.actividad_scian LIKE '623%'  -- residencias médicas
GROUP BY e.nombre_act, e.municipio
ORDER BY ivs_zona DESC;
```

### Fase 4b — Prevalencias ENSANUT por estrato estatal (1-2 días)

**Descarga:** https://ensanut.insp.mx/encuestas/ensanutcontinua2023/descargas.php  
**Archivo requerido:** Microdatos de adultos + diccionario de variables

```python
# Script de procesamiento (Python + survey library o pandas con pesos manuales)
import pandas as pd

df = pd.read_stata('ensanut2023_adultos.dta')

# Calcular prevalencias ponderadas correctamente
results = []
for estado in df['entidad'].unique():
    for estrato in ['urbano', 'rural']:
        mask = (df['entidad'] == estado) & (df['area'] == estrato)
        subset = df[mask]
        if len(subset) < 30:  # umbral mínimo de confiabilidad
            continue
        
        # Prevalencia ponderada con factor de expansión
        weight_sum = subset['factor_exp'].sum()
        prev_diabetes = (subset['tiene_diabetes'] * subset['factor_exp']).sum() / weight_sum
        prev_hta = (subset['tiene_hta'] * subset['factor_exp']).sum() / weight_sum
        prev_obesidad = (subset['imc_obeso'] * subset['factor_exp']).sum() / weight_sum
        
        # Error estándar (método linearización de Taylor)
        se_diabetes = subset['tiene_diabetes'].std() / (len(subset) ** 0.5)
        
        results.append({
            'clave': f'{estado}_{estrato}',
            'n': len(subset),
            'prev_diabetes': prev_diabetes,
            'prev_hta': prev_hta,
            'prev_obesidad': prev_obesidad,
            'se_diabetes': se_diabetes
        })

pd.DataFrame(results).to_csv('ensanut_prevalencias_estrato.csv', index=False)
```

**Tabla destino en Supabase:**
```sql
CREATE TABLE ensanut_prevalencias_estrato (
  clave VARCHAR(30) PRIMARY KEY,  -- ej: 'CDMX_urbano'
  cve_ent CHAR(2),
  estrato VARCHAR(10),            -- 'urbano' | 'rural'
  n_encuestados INTEGER,
  prev_diabetes NUMERIC(5,4),
  prev_hipertension NUMERIC(5,4),
  prev_obesidad NUMERIC(5,4),
  se_diabetes NUMERIC(5,4),       -- error estándar — siempre publicar esto
  fuente VARCHAR(50) DEFAULT 'ENSANUT_2023',
  dominio_valido BOOLEAN DEFAULT TRUE
);
```

### Fase 4c — SAE Municipal (proyecto separado, Q3 2026)

**Herramientas:** R + paquetes `sae`, `emdi`, `survey`  
**Tiempo estimado:** 2-3 semanas incluyendo validación  
**Output:** Tabla `ensanut_sae_municipal` con prevalencias estimadas + IC al 95% por municipio

**No entra en el pipeline actual.** Se diseña como producto premium.

---

## 5. Tabla resumen de variables ENSANUT utilizables

| Variable ENSANUT | Tipo | Nivel válido | Aplicación en DENUE |
|-----------------|------|-------------|---------------------|
| `prev_diabetes` | Prevalencia ponderada | Estatal/estrato | Ratio establecimientos endocrinología vs demanda |
| `prev_hipertension` | Prevalencia ponderada | Estatal/estrato | Demanda cardiología, farmacias |
| `prev_obesidad` | Prevalencia ponderada | Estatal/estrato | Mercado nutrición, gimnasios |
| `derechohabiencia` | % con seguro médico | Estatal/estrato | Mix público/privado de establecimientos |
| `prev_depresion` | Prevalencia ponderada | Nacional solamente | Contexto general |
| `uso_servicios_salud_12m` | % que buscó atención | Estatal/estrato | Demanda realizada vs potencial |

> **Nota crítica:** `prev_depresion` y variables de salud mental solo son confiables a nivel nacional en ENSANUT Continua. La muestra es insuficiente para desagregación estatal. No usar a nivel subnacional.

---

## 6. Anti-patrones a evitar

| Anti-patrón | Por qué es incorrecto |
|-------------|----------------------|
| `JOIN ensanut ON ST_DWithin(geom, 5km)` | UPMs no son representativas del punto — el join espacial da falsa precisión |
| `AVG(prevalencia) GROUP BY municipio` | Sin pesos de expansión, el promedio es estadísticamente inválido |
| Publicar estimaciones sin error estándar | Oculta incertidumbre — cualquier análisis serio requiere IC |
| Usar municipios con n < 30 en ENSANUT | Por debajo de 30 observaciones ponderadas el error es inaceptablemente alto |
| Comparar ENSANUT ediciones distintas (2018 vs 2022) | Las metodologías cambiaron — no son comparables directamente |

---

## 7. Valor final para EurekaMD

Con las tres rutas implementadas, el analizador puede responder:

1. **"¿Dónde hay mayor demanda potencial de cardiología?"**  
   → IVS_salud alto (Ruta C) + `prev_hipertension` estatal (Ruta A) + pocos establecimientos de cardiología (DENUE)

2. **"¿Qué municipios son desiertos de salud con alta carga de enfermedad?"**  
   → `ratio_salud` bajo (DENUE/Censo) + IVS_salud alto + `prev_diabetes` del estrato

3. **"¿Cuál es el catchment area realista de una nueva clínica?"**  
   → Polígono AGEB + IVS_salud de los AGEBs vecinos + establecimientos competidores en radio

La combinación DENUE + Censo + ENSANUT (bien aplicada) es más potente que cualquiera de las tres fuentes solas. El secreto es respetar los niveles de inferencia de cada fuente.

---

*Documento generado: 2026-05-03 | Proyecto: data-intelligence/denue-data-analysis*
