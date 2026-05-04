# Fuentes de Datos Gubernamentales para el Pipeline de Inteligencia

> Investigado: 2026-05-03 | Fuente: Deep search multi-vertical
> Complementa: `aplicaciones-censo-denue.md` y `resumen-estrategico-denue.md`

---

## Contexto

El agente de búsqueda ejecutó 16 web_searches abarcando salud, turismo, seguridad, bienestar social y datos urbanos. Lo que sigue es el consolidado de fuentes verificadas — con URL, granularidad, y aplicación concreta al pipeline DENUE.

---

## 🏥 SALUD — Secretaría de Salud / DGIS

### CLUES — Catálogo de Establecimientos de Salud
- **URL**: http://www.dgis.salud.gob.mx/contenidos/sinais/s_clues.html
- **Descarga directa**: https://datos.gob.mx/dataset/?q=catalogo-de-clave-unica-de-establecimientos-de-salud-clues
- **Granularidad**: Establecimiento individual (hospital, clínica, consultorio, farmacia)
- **Variables clave**: CLUES (ID único), nombre, tipo (IMSS/ISSSTE/SSA/privado), municipio, coordenadas, camas, quirófanos, especialidades
- **Formato**: CSV / XLS descargable
- **Actualización**: Anual

**Aplicación al pipeline:**
- Join directo con DENUE: un establecimiento de salud en DENUE tiene coordenadas → buscar su CLUES correspondiente → enriquece con número de camas y servicios que DENUE no captura
- Identifica establecimientos públicos vs. privados (DENUE no distingue)
- Capa de "infraestructura real de salud" para calcular desiertos vs. saturación

### Egresos Hospitalarios (SINAIS)
- **URL**: https://datos.gob.mx/dataset/datos_egresos_hospitalarios
- **Granularidad**: Evento de egreso por hospital y diagnóstico (CIE-10)
- **Variables**: Diagnóstico principal, tiempo de estancia, tipo de seguro, municipio de residencia del paciente
- **Formato**: CSV por año
- **Actualización**: Anual

**Aplicación al pipeline:**
- Demand mapping real: cuántos egresos por diagnóstico por municipio → el flujo de pacientes va de zonas sin hospitales hacia zonas con hospitales
- Para EurekaMD: identifica hospitales con alta carga de un diagnóstico específico (oncología, cardiología)

### Datos Abiertos DGIS (completo)
- **URL**: http://www.dgis.salud.gob.mx/contenidos/basesdedatos/Datos_Abiertos_gobmx.html
- Incluye: mortalidad, nacimientos, enfermedades notificables, recursos humanos en salud

---

## ✈️ TURISMO — SECTUR / Datatur

### Datatur — Sistema de Información Turística
- **URL**: https://datatur.sectur.gob.mx
- **Datasets principales**:
  - Visitantes por nacionalidad: https://datatur.sectur.gob.mx/SitePages/Visitantes%20por%20Nacionalidad.aspx
  - Visitantes internacionales: https://datatur.sectur.gob.mx/SitePages/VisitantesInternacionales.aspx
- **Granularidad**: Por destino turístico (ciudad/zona), mensual
- **Variables**: Llegadas a hoteles, ocupación hotelera, gasto promedio, procedencia (doméstico vs. internacional)
- **Formato**: CSV / Excel descargable

**Aplicación al pipeline:**
- Layer de "intensidad turística" por municipio → los municipios turísticos tienen patrones DENUE radicalmente distintos (restaurants, hoteles, guías turísticos concentrados)
- Cruzar ocupación hotelera vs. densidad de negocios de servicio → identifica zonas donde la oferta turística está desbalanceada respecto a la demanda
- Segmentación de mercado: municipios turísticos requieren análisis DENUE diferente (negocios estacionales)

### Datos Abiertos SECTUR
- **URL**: https://www.sectur.gob.mx/gobmx/transparencia/datos-abiertos/
- Incluye: directorio de hoteles, RNT (Registro Nacional de Turismo), estadísticas de empleo turístico

### Datos Turismo Puebla (ejemplo ciudad)
- **URL**: https://datos.pueblacapital.gob.mx/dataset/estadística-de-turismo-datatur
- Muestra que varias ciudades tienen sus propios portales de datos abiertos con series Datatur locales

---

## 📊 BIENESTAR SOCIAL — CONEVAL

### Pobreza Municipal 2010-2020
- **URL**: https://www.coneval.org.mx/Medicion/Paginas/Pobreza-municipio-2010-2020.aspx
- **Granularidad**: Municipio
- **Variables**: % pobreza, % pobreza extrema, carencias sociales (6 dimensiones), índice de rezago social
- **Formato**: CSV descargable
- **Actualización**: Cada 2 años (ligado al MCS-ENIGH)

**Aplicación al pipeline:**
- NSE municipio como capa macro (complementa el NSE sintético de vivienda del Censo)
- Segmentación de mercado: municipios de alta pobreza tienen perfil DENUE dominado por comercio informal / micronegocios
- Para retail o distribución: ajustar estrategia de entrada según índice de rezago social

### DataMun — Fichas Municipales
- **URL**: https://sistemas.coneval.org.mx/DATAMUN
- Dashboard interactivo con 40+ indicadores por municipio (pobreza, acceso a servicios, rezago educativo)
- Tiene API-style queries

### Bases de Datos CONEVAL en datos.gob.mx
- **URL**: https://www.datos.gob.mx/dataset/?organization=coneval&res_format=CSV
- Todo en CSV directo, sin necesidad de scraping

---

## 🚨 SEGURIDAD — SESNSP

### Incidencia Delictiva por Municipio
- **URL**: https://www.gob.mx/sesnsp/acciones-y-programas/datos-abiertos-de-incidencia-delictiva
- **Descarga directa**: https://www.datos.gob.mx/dataset/incidencia_delictiva
- **Granularidad**: Municipio × mes × tipo de delito
- **Variables**: Delitos del fuero común (robo, homicidio, secuestro, extorsión) y fuero federal, por año/mes
- **Formato**: CSV mensual actualizado
- **Actualización**: Mensual

**Aplicación al pipeline:**
- Layer de "riesgo operativo" por municipio → directamente relevante para decisiones de apertura de establecimientos
- Para negocios que ya están en DENUE: correlación entre tasa de robo a negocio y densidad de ciertos giros (joyerías, farmacias, gasolineras)
- Para distribución y logística: rutas de alto riesgo por municipio
- Cruzar con DENUE: ¿los municipios con mayor delincuencia tienen menor densidad de establecimientos formales?

---

## 🏙️ DATOS URBANOS Y CIUDAD

### Portal Nacional: datos.gob.mx
- **URL**: https://www.datos.gob.mx/
- Más de 4,522 bases de datos etiquetadas como "crimen", cientos más en salud, educación, economía
- Categoría seguridad: https://www.datos.gob.mx/group/seguridad

### Portales Municipales/Estatales con Datos Propios
Ciudades grandes tienen sus propios portales — calidad variable pero con datos únicos:

| Ciudad/Estado | Portal | Datos relevantes |
|---|---|---|
| CDMX | datos.cdmx.gob.mx | Colonias, alcaldías, movilidad, SEMOVI |
| Jalisco | datos.jalisco.gob.mx | Municipios, padrón empresarial estatal |
| Nuevo León | datos.nl.gob.mx | Catastro, empleo, salud |
| Puebla Capital | datos.pueblacapital.gob.mx | Turismo Datatur local, comercio |
| Monterrey | datos.monterrey.gob.mx | Infraestructura urbana |

---

## 🔗 Matriz de Aplicación al Pipeline

| Fuente | Join con DENUE | Granularidad | Valor agregado |
|---|---|---|---|
| CLUES (Salud) | CLUES ID + coords | Establecimiento | Capacidad real (camas, especialidades) |
| SINAIS Egresos | Municipio + diagnóstico | Hospital × mes | Flujo de demanda de pacientes |
| Datatur | Municipio | Mensual | Intensidad turística, estacionalidad |
| CONEVAL Pobreza | Municipio | Cada 2 años | NSE macro, segmentación socioeconómica |
| SESNSP Delitos | Municipio × mes | Mensual | Riesgo operativo, viabilidad comercial |
| CDMX datos | Colonia (AGEB proxy) | Variable | Movilidad, uso de suelo (solo CDMX) |

---

## 📥 Prioridad de Ingesta Recomendada

### Fase A — Impacto inmediato (EurekaMD + B2B)
1. **CLUES** — join directo con DENUE salud, enriquece sin costo
2. **CONEVAL Pobreza Municipal** — layer NSE macro, CSV limpio, una descarga

### Fase B — Inteligencia comercial
3. **SESNSP Delitos** — layer de riesgo, mensual, limpio
4. **Datatur** — para clientes de turismo o retail en destinos turísticos

### Fase C — Análisis avanzado
5. **SINAIS Egresos** — demand mapping real para salud
6. **Portales municipales** — CDMX primero (mayor granularidad disponible)

---

## Notas de Implementación

- Todos los joins de municipio usan la **clave INEGI de municipio** (2 dígitos entidad + 3 dígitos municipio = 5 dígitos). DENUE, Censo, CLUES y CONEVAL usan la misma clave — el join es nativo.
- SESNSP y Datatur están en CSV mensuales → candidatos para un colector automático (tmux + cron).
- CLUES es el único dataset con coordenadas propias — puede alimentar directamente las vistas PostGIS.
- Los portales municipales son inconsistentes: CDMX es el más maduro y vale la inversión; el resto requiere evaluación caso por caso.
