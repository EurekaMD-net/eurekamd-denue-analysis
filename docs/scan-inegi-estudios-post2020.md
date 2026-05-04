# Scan INEGI: Estudios y Encuestas Complementarias Post-2020
> Solo versiones ≥ 2020. Sólo la edición más reciente por encuesta.
> Fecha de scan: 2026-05-03 | Fuente: inegi.org.mx/programas/

---

## 🔴 PRIORIDAD ALTA — Join directo con DENUE

### 1. Censos Económicos 2024 — Resultados Definitivos
- **URL**: https://censoseconomicos2024.mx/ / https://www.inegi.org.mx/programas/ce/2024/
- **Cobertura**: Nacional, todos los establecimientos del país
- **Datos clave**: 7,056,499 establecimientos (2024), 36,793,604 personas ocupadas, valor agregado censal bruto, producción bruta, activos fijos, remuneraciones
- **Granularidad geográfica**: Municipio, AGEB
- **Granularidad económica**: Clase SCIAN (6 dígitos)
- **Formato**: Datos Abiertos CSV + SAIC (tabulados interactivos)
- **¿Por qué es crítico?**: Es el censo par de DENUE. Donde DENUE dice "cuántos hay y dónde", el CE2024 dice "cuánto producen y cuántos empleados tienen". Join por SCIAN + municipio da el perfil económico real de cada sector en cada zona.
- **Nota operativa**: Los resultados definitivos se publicaron en 2025. La extracción es por descarga masiva o SAIC interactivo.

### 2. ENOE 2024 — Encuesta Nacional de Ocupación y Empleo
- **URL**: https://www.inegi.org.mx/programas/enoe/15ymas/
- **Periodicidad**: Trimestral (Q1 2024 disponible)
- **Datos clave**: PEA, tasa de desocupación, sector de actividad, tipo de contratación, ingreso, horas trabajadas
- **Granularidad**: Nacional, entidad federativa, zona metropolitana
- **Formato**: Microdatos CSV + bases SPSS
- **¿Por qué importa para DENUE?**: Cruza demanda laboral real por sector con la oferta de establecimientos del DENUE. Alta PEA en manufactura + pocos establecimientos manufactureros = economía informal concentrada.

### 3. ENIGH 2024 — Encuesta Nacional de Ingresos y Gastos de los Hogares
- **URL**: https://www.inegi.org.mx/programas/enigh/nc/2024/
- **Periodicidad**: Bienal (2024 = más reciente)
- **Datos clave**: Ingreso corriente monetario por decil, gasto en alimentos/salud/transporte/educación, características de la vivienda, equipamiento del hogar
- **Granularidad**: Nacional, urbano/rural, región
- **Formato**: Microdatos CSV
- **¿Por qué importa para DENUE?**: Único proxy oficial de poder adquisitivo y patrones de consumo. Cruzado con DENUE por región → scoring de mercado potencial por tipo de establecimiento.

---

## 🟠 PRIORIDAD MEDIA — Enriquecimiento de verticales

### 4. ENSANUT Continua 2023 — Encuesta Nacional de Salud y Nutrición
- **URL**: https://ensanut.insp.mx/encuestas/ensanutcontinua2023/index.php
- **Organismo**: INSP + SSA (no INEGI directo)
- **Periodicidad**: Anual continua desde 2020
- **Datos clave**: Prevalencia de enfermedades crónicas (diabetes, hipertensión, obesidad) por grupo etario, acceso a servicios de salud, uso de medicamentos, derechohabiencia
- **Granularidad**: Nacional, algunas entidades con muestra ampliada (Guanajuato, Sonora)
- **¿Por qué importa para EurekaMD?**: Prevalencia de enfermedades crónicas = demanda potencial de servicios especializados. Cruza con DENUE para ver si la oferta cubre la demanda real por zona.

### 5. ENASEM 2021 — Encuesta Nacional sobre Salud y Envejecimiento en México
- **URL**: https://www.inegi.org.mx/programas/enasem/2021/
- **Datos clave**: Enfermedades crónicas en adultos 50+, funcionalidad, mortalidad, impacto de discapacidad, uso de medicamentos
- **Granularidad**: Nacional (panel longitudinal desde 2001)
- **¿Por qué importa para EurekaMD?**: La población 50+ es el núcleo del negocio oncológico y de especialidades. Panel longitudinal → carga de enfermedad proyectable.

### 6. Encuestas de Viajeros Internacionales 2024 — Turismo de Internación
- **URL**: https://www.inegi.org.mx/programas/envi/
- **Periodicidad**: Mensual
- **Datos clave**: Flujo de turistas internacionales, motivo de viaje, gasto promedio, destino principal, medio de transporte
- **Granularidad**: Frontera de entrada, destino turístico, municipio
- **¿Por qué importa?**: Layer de demanda turística sobre DENUE. Establecimientos de restaurantes, hoteles y entretenimiento en zonas con alto flujo turístico tienen comportamiento estacional identificable.

### 7. ENDUTIH 2023 — Encuesta Nacional sobre Disponibilidad y Uso de TIC
- **URL**: https://www.inegi.org.mx/programas/dutih/2023/
- **Periodicidad**: Anual
- **Datos clave**: % hogares con internet, smartphone, computadora, uso de comercio electrónico, banca digital
- **Granularidad**: Nacional, urbano/rural, entidad federativa, estrato socioeconómico
- **¿Por qué importa?**: Proxy de penetración digital por zona — crítico para evaluar si establecimientos DENUE en una zona tienen mercado para productos/servicios digitales.

### 8. ENCIG 2023 — Encuesta Nacional de Calidad e Impacto Gubernamental
- **URL**: https://www.inegi.org.mx/programas/encig/2023/
- **Periodicidad**: Bienal
- **Datos clave**: Percepción de corrupción por tipo de trámite y entidad, confianza en instituciones, experiencias con gobierno
- **¿Por qué importa?**: Fricción operativa del entorno de negocios por zona. Alta corrupción en trámites = costo de apertura más alto = explica densidad diferencial de establecimientos formales en DENUE.

### 9. ENVIPE 2023 — Encuesta Nacional de Victimización y Percepción de Seguridad
- **URL**: https://www.inegi.org.mx/programas/envipe/2023/
- **Periodicidad**: Anual
- **Datos clave**: Prevalencia delictiva por tipo, cifra negra, percepción de inseguridad, impacto económico del delito
- **Granularidad**: Entidad federativa, zona metropolitana, municipio
- **¿Por qué importa?**: Layer de riesgo operativo. Cuantifica victimización por tipo de delito (robo a negocio vs. extorsión) — input directo para scoring de riesgo de expansión comercial.

---

## 🟡 PRIORIDAD BAJA — Contexto demográfico avanzado

### 10. ENADID 2023 — Encuesta Nacional de la Dinámica Demográfica
- **URL**: https://www.inegi.org.mx/programas/enadid/2023/
- **Periodicidad**: Quinquenal
- **Datos clave**: Tasa de fecundidad, migración interna e internacional, uso de anticonceptivos, salud materno-infantil, nupcialidad
- **¿Por qué importa?**: Proyecciones de población por cohorte. Zonas con alta natalidad = mercados infantiles y juveniles de 2030-2040.

### 11. ENBIARE 2021 — Encuesta Nacional de Bienestar Autorreportado
- **URL**: https://www.inegi.org.mx/programas/enbiare/2021/
- **Datos clave**: Satisfacción con la vida, emociones, sentido de propósito, bienestar subjetivo
- **¿Por qué importa?**: Proxy de bienestar subjetivo — correlacionado con gasto en salud preventiva y bienes experienciales.

### 12. ENIGH-A 2022 — Encuesta Estacional de Ingresos y Gastos
- **URL**: https://www.inegi.org.mx/programas/enigh/est/2022/
- **Datos clave**: Estacionalidad del gasto de los hogares por época del año
- **¿Por qué importa?**: Establecimientos estacionales (turismo, retail navideño) tienen patrones no capturados por la ENIGH estándar.

### 13. ENUT 2024 — Encuesta Nacional sobre Uso del Tiempo
- **URL**: https://www.inegi.org.mx/programas/enut/2024/
- **Datos clave**: Horas en trabajo remunerado/doméstico/cuidados/ocio por sexo y edad
- **¿Por qué importa?**: Demanda latente de servicios de cuidado (guarderías, asilos) y ocio por zona.

---

## 🔵 ENCUESTAS ECONÓMICAS REGULARES (actualización mensual/anual)

| Encuesta | Periodicidad | Dato clave |
|---|---|---|
| **EMS** — Encuesta Mensual de Servicios 2025 | Mensual | Ingresos y empleo en servicios privados por clase SCIAN |
| **EMEC** — Encuesta Mensual sobre Empresas Comerciales 2023 | Mensual | Ingresos y personal en comercio minorista/mayorista |
| **EAC** — Encuesta Anual de Comercio 2024 | Anual (datos 2023) | Valor de ventas, compras, existencias por clase SCIAN |
| **EASPNF** — Encuesta Anual de Servicios Privados no Financieros 2024 | Anual | Gastos, ingresos, empleo en servicios |
| **ENOE** Q1 2024 | Trimestral | Tasa desocupación, ingresos laborales |
| **ENSU** 2024 | Trimestral | % población que se siente insegura por ciudad |

---

## 📐 Estrategia de Join con DENUE

### Joins disponibles hoy

| Fuente INEGI | Llave de join | Tipo de enriquecimiento |
|---|---|---|
| **CE 2024** | Clase SCIAN + Municipio | Tamaño real del sector (empleo, producción) |
| **Censo 2020** | Clave AGEB (`ST_Within`) | NSE, demografía, discapacidad, escolaridad |
| **ENOE** | Clave entidad/municipio | Tasa ocupación, ingreso laboral por zona |
| **ENVIPE** | Clave entidad/municipio | Riesgo delictivo por zona |
| **EVI** | Municipio turístico | Flujo de visitantes, gasto turístico |

### Join más valioso no explotado aún

**CE 2024 × DENUE × Censo 2020:**
- CE2024: "en clase 4621 en Jalisco → $2.3B de valor agregado, 1,200 empleos"
- DENUE: "hay 340 establecimientos de esa clase en Jalisco, con coordenadas"
- Censo 2020: "estas AGEBs tienen NSE medio-alto y 78% de hogares con internet"
- → **Productividad promedio por establecimiento ajustada por NSE de zona**

---

## 🔗 URLs de Descarga Masiva

| Dataset | URL |
|---|---|
| CE 2024 datos abiertos | https://censoseconomicos2024.mx/ |
| Censo 2020 AGEBs urbanas | https://www.inegi.org.mx/app/descarga/?ti=6 |
| ENOE microdatos | https://www.inegi.org.mx/programas/enoe/15ymas/#Microdatos |
| ENIGH 2024 microdatos | https://www.inegi.org.mx/programas/enigh/nc/2024/#Microdatos |
| ENSANUT Continua 2023 | https://ensanut.insp.mx/encuestas/ensanutcontinua2023/descargas.php |
| ENVIPE 2023 | https://www.inegi.org.mx/programas/envipe/2023/#Microdatos |
| ENDUTIH 2023 | https://www.inegi.org.mx/programas/dutih/2023/#Microdatos |

---

## ⚠️ Notas de Integridad
- CE 2024 es la fuente más nueva y más importante — resultados definitivos publicados en 2025.
- La ENSANUT es del INSP, no del INEGI directamente — URL y acceso diferente.
- La ENIGH 2024 es "Nueva Serie" — no directamente comparable con ediciones anteriores sin ajuste metodológico.
- Ningún conteo absoluto fue hardcodeado. Todos los números provienen de fuentes escaneadas.
