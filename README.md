# DENUE Data Analysis

Extractor y analizador de datos del **Directorio Estadístico Nacional de Unidades Económicas (DENUE)** del INEGI, implementado en TypeScript.

> **Fuente:** API live INEGI DENUE v1 — `/app/api/denue/v1/consulta/`. La API no expone metadatos de versión/snapshot; siempre devuelve la publicación corriente. Validado contra el conteo oficial de INEGI por estado (verificación manual vía https://www.inegi.org.mx/app/mapa/denue/).

---

## Versión actual: v0.3 P4 — live, supervisado, todas las capas v0.2.x integradas

**Live**: <https://uncharted.eurekamd.cloud/> (Caddy + LE TLS + dist/ + gzip + immutable cache, systemd-managed via `denue-analyzer.service`). El plan v1 sealed 2026-05-04 nombró `analyzer.denue.net`; al pivotear a la marca paraguas EurekaMD el dominio público se decidió en `uncharted.eurekamd.cloud` y P4 se colapsó dentro de v0.3 P3. Ver "Amendment 2026-05-06" en [`docs/analyzer-plan-v1.md`](docs/analyzer-plan-v1.md).

Backend v0.1 + v0.2.1 + v0.2.2 + v0.2.3-A + v0.2.3-C cargados en producción (**7 fuentes joinables por `cve_mun` 5-char**: DENUE × Censo 2020 × CONEVAL Pobreza × CONEVAL IRS × CLUES × CE 2024 × EDR mortalidad 2024, plus SESNSP RNID Delitos Municipal 2015–2026 como capa de riesgo operacional, plus **ENIGH 2024 + ENOE 2025 calibradores estatales** keyed por entidad para anclar pobreza/ingreso/informalidad al absoluto). El analyzer (`web/`) tiene **dos modos** sobre el mismo dataset:

- **Locust mode**: 5 charts ECharts (mosaico nacional treemap, sector × IRS heatmap, top sectores bar, densidad-vs-pobreza scatter, CLUES vs farmacias por 100k) + 4 endpoints comerciales (`/analytics/national-treemap`, `/sector-grade-matrix`, `/municipios`, `/top-sectors`).
- **Map mode**: MapLibre + Carto Positron/Dark Matter basemap, vector source sobre `/tiles/:z/:x/:y.mvt` con heatmap (zoom <14) + circles (zoom ≥11) y deck.gl `ScatterplotLayer` overlay para cluster centroids cuando entidad+sector están seleccionados. Click en punto → detalle del establecimiento via `/establishment/:clee`.
- **Risk surface (backend only, sin UI todavía)**: 2 endpoints SESNSP — `/analytics/risk-summary?entidad=NN[&ano=&baseline_ano=]` (perfil per-municipio con totales por subtipo + per-1k normalización + cambio % vs baseline) y `/analytics/risk-trend?cve_mun=NNNNN` (serie mensual ~135 puntos 2015–2026 Mar). Mat-view `mv_delitos_municipal_yearly` con fallback gracioso a agregación live si la MV no existe. El default `ano` se resuelve al arranque desde `MAX(ano)` con todos los 12 meses reportados (audit W5, 2026-05-05) — rollover automático cuando la siguiente carga de diciembre cierre el año. UI integration es la siguiente conversación.

v0.2.3-A **shipped 2026-05-05**: EDR mortalidad 2024 (819,672 deaths registered, 809,063 con residencia válida en 2,472 municipios). Mat-view `mv_mortalidad_municipal_yearly` + 2 endpoints (`/analytics/mortality-summary`, `/analytics/mortality-trend`) con cause-of-death breakdown CIE-10 (circulatorio, neoplasias, endocrinas, externas, infantil) y tasa cruda por 1k habitantes. `currentMortalityAno` resuelto al boot vía `MAX(ano) WHERE COUNT >= 100k` para evitar lag-artifact years como default.

v0.2.3-C-1 **ENIGH** shipped 2026-05-05: 91,414 hogares aggregated to 32 entidades. Tabla `calibrators_enigh_state` con weighted percentile P10/P50/P90 (cumulative-sum-window), ingreso/gasto promedio factor-weighted, y Engel coefficient (`pct_gasto_alimentos`). Live: NL 19 mean $117k/yr vs Chiapas 07 mean $41k/yr; Engel 35% vs 47%.

v0.2.3-C-2 **ENOE** shipped 2026-05-05: 1.69M sdem rows × 4 trimestres aggregated to 32 entidades year-averaged. Tabla `calibrators_enoe_state` con tasa_participacion/desocupacion/informalidad + ingreso_promedio_mensual_ocupado. Loader sidesteps INEGI's mid-2025 column rename (`ent`→`cve_ent`) by extracting 7 columns by **POSITION** (idx 11/25/53/55/56/97/107) via `awk -F,`. Endpoint `/analytics/state-calibrators` LEFT JOINs both calibrator tables — single-row response per entidad. Live: NL 19 = 34% informal / $14k/mo vs Chiapas 07 = 77% informal / $7k/mo (cross-source coherent with ENIGH income gap).

v0.2.3 restante: **Datatur** = mixed (~50/70 destinos direct-join post-crosswalk; ~20 calibradores zonales) — pendiente crosswalk. Patrón general: fuentes que no joinan a `cve_mun` no se descartan; condicionan / multiplican / contextualizan las filas municipales. Plan completo en [`docs/v0.2.3-plan.md`](docs/v0.2.3-plan.md).

v0.2.4-A **AGEB analytics primitive** shipped 2026-05-05: tres endpoints exponen análisis sub-municipal sobre la infraestructura existente (`ageb_polygons` 81,451 polígonos × `establecimientos.ageb` 99.99% backfill × `clues_raw` lat/lon spatial-join via PostGIS). `GET /analytics/agebs-by-municipio?cve_mun=NNNNN[&order_by=establecimientos|farmacias|clues|area][&limit≤200]` lista AGEBs en un municipio con conteos + geometría. `GET /analytics/ageb-detail?cvegeo=NNNNNNNNNNNNN` devuelve identidad + bbox + top-10 SCIAN sectores + sample CLUES (cap 30). `GET /analytics/ageb-farmacia-opportunity?cve_mun=NNNNN[&limit≤100]` ranquea AGEBs por score `(CLUES × 0.5 + establecimientos × 0.3 − farmacias × 1.0)` (raw).

v0.2.4-B **Census-AGEB** shipped 2026-05-05: cargados los 32 ZIPs de INEGI RESAGEBURB urbana 2020 (236 MB total, URL pattern descubierta via búsqueda directa: `/ccpv/2020/datosabiertos/ageb_manzana/ageb_mza_urbana_<EE>_cpv2020_csv.zip`). `censo_ageb_raw` (1.68M rows todas granularidades) + `censo_ageb` view (64,313 AGEB-level rows) + `censo_manzana` view (1.6M manzana-level rows). `ageb-detail` ahora devuelve campos `population` + `census: { pobtot, pobfem, p_60ymas, p_15ymas, pea, pocupada, graproes, vph_inter, vph_autom, ... }` al nivel AGEB. `ageb-farmacia-opportunity` agrega `population` + `score_per_1k` para ranking normalizado por residentes. CVEGEO_RE relajada (`^[0-9]{12}[0-9A-Z]$`) para aceptar AGEBs con sufijo de letra (~9% del universo). 99.49% match cross-source con `ageb_polygons`. Ejemplo live: AGEB centro Puebla (`2111400010412`) → pop 2,175 (vs 1.5M de la localidad), 354 adultos mayores (60+), 458 viviendas con internet, 128 con automóvil. Performance: agregado `idx_establecimientos_ageb` btree parcial (15× speedup en ageb-detail, 14s → 1s).

v0.2.7 **Capa de demanda de salud** shipped 2026-05-05: cierra el gap "F2 pobreza-as-proxy" identificado en deep-search session. Dos integraciones complementarias:

(a) **SINBA Enfermedades Crónicas (DGIS SIS 2023)**: 141k filas / 2,204 munis con DM2 + HTA + obesidad activos en clínicas SUS. View `sinba_morbidity_municipal` agrega `SUM(case-cols)/12 = casos promedio mensual activos`. Iztapalapa = 8,780 DM2 / 6,918 HTA / 3,363 obesidad (mayor caseload nacional). Loader: ZIP→CSV→iconv Latin-1→\copy (NULL='NULL' sentinel). Ejemplo: ferreterías + farmacias en Iztapalapa, 09007 = AGEB Alto-rezago 0900700015658 con 7,959 pop / 2 farmacias / **46.4% sin cobertura institucional** / muni-DM2 8,780.

(b) **Censo 2020 derechohabiencia (existing data)**: alternativa AL IMSS PDA loader que Jarvis propuso. Probe descubrió que IMSS publica por _subdelegación interna_ (A01, H46, Z64) no por cve_mun INEGI — unjoinable. La buena noticia: el Censo 2020 RESAGEBURB (cargado v0.2.4-B) ya tiene `psinder` + 7 columnas más de derechohabiencia A NIVEL AGEB. Extendí `censo_ageb` view + `AgebCensusFields` type. `pct_sin_cobertura_salud` = `psinder/pobtot×100` se computa per-AGEB y se expone en `/opportunity-by-ageb` y `/ageb-detail`. Strict reading: NO incluye `pafil_ipriv` (privately-insured); operator combina si quiere "private-pharma-dependent" amplio.

`/analytics/opportunity-by-ageb` ahora retorna 4 nuevos campos per-row: `pct_sin_cobertura_salud` (AGEB-level), `casos_dm2_muni` / `casos_hta_muni` / `casos_obesidad_muni` (muni-level broadcast). qa-audit fixes pre-deploy: W4 (Latin-1 detection in loader), W5 (anchored regex on prefix-match para case-count columns). Rechazadas de la propuesta original de Jarvis: IMSS PDA (subdelegación≠cve_mun), Padrón Bienestar (state-level only), DGE (no chronic-disease), SIEM (defunct), CANAFARMACIA (paywall).

v0.2.9 **Sub-AGEB drilldown** shipped 2026-05-06: cierra el "AGEB returns 13-digit key, but I need a specific block / corner" gap que Jarvis flagueó en su experimento AGEB §4.5. Dos endpoints nuevos sobre la vista `censo_manzana` (1,611,448 manzanas) extendida con `tvivpar`/`vph_inter`/`vph_autom`. **`GET /analytics/manzanas-by-ageb?cvegeo=NNNNNNNNNNNNN&order_by=pobtot|tvivpar|vph_inter&limit=N`** retorna manzanas (city blocks) dentro del AGEB con pobtot/pobfem/pobmas + tvivpar (viviendas particulares) + vph_inter (proxy de ingreso block-level) + vph_autom. INEGI suprime por LSNIEG art. 37 los blocks con <3 viviendas (NULLs explícitos). **`GET /analytics/colonias-by-ageb?cvegeo=NNNNNNNNNNNNN`** agrupa `establecimientos.ageb=cvegeo` por `UPPER(TRIM(colonia))` — porque las colonias INEGI no son polígonos sino labels populares que el broker reconoce. Workflow completo: `/opportunity-by-ageb` → AGEB winner → `/manzanas-by-ageb` → block winner → `/colonias-by-ageb` → label para el broker. View migration `tvivpar/vph_inter/vph_autom` aplicada vía `CREATE OR REPLACE VIEW` y pinned en loader. qa-audit pre-deploy: 0 Critical / 0 Major / 4 Warnings, W1 + W2 fixed inline (3 SQL-injection contract tests + dead MZA_RE removal). 16 new tests (191 passing). Live Iztapalapa AGEB 0900700012475: top mza 005 = 24 pop / 8 viviendas. Top colonia same AGEB: CENTRAL DE ABASTOS (2,594 establecimientos).

v0.2.8 **COFEPRIS Padrón licencias farmacias** shipped 2026-05-05: cierra el "DENUE knows there's a farmacia, only COFEPRIS knows what kind" gap. Pipeline: PDF (3.7 MB / 123 pp) → `pdfplumber` Python extractor (14 cols + 6 boolean control-class flags + ASCII-normalized colonia/localidad) → geocoder Python (CP+colonia exact match → AGEB, modal AGEB within CP fallback con tie-break alfabético determinístico) → loader TS con header pin-check + assertUtf8 + C1 force-required-on-populated + 2 partial-on-Vigente indexes (matching planner predicate exactly). **2,381 farmacias loaded (2,195 Vigente). 92.3% geocoded a AGEB** (74.7% precise CP+colonia + 17.6% modal + 7.7% unmatched). 151 munis con farmacia licenciada Vigente. **2 nuevos endpoints**: `GET /analytics/licensed-pharmacies-by-municipio?cve_mun=NNNNN` retorna total + 6 contadores controlados (Estupefacientes, Psicotrópicos II/III, Vacunas, Toxoides, Sueros+Antitoxinas, Hemoderivados) + 3 giro counts (hospitalarias/boticas/droguerias). `GET /analytics/licensed-pharmacies-by-ageb?cvegeo=NNNNNNNNNNNNN` retorna total + bandera `con_controlados` bundled. Zero-row response (no 404) para munis/AGEBs sin farmacias licenciadas. **Lección**: DENUE.ageb stores the FULL 13-char cvegeo (no solo el sufijo de 4-char). v1 del geocoder concatenaba `cve_mun + ageb` → 18-char garbage truncado. Fix: usar `establecimientos.ageb` directamente (saved as `feedback_denue_ageb_column_is_cvegeo`). qa-audit M1 (dead AGEB view) → fixed con AGEB endpoint, M2 (wasted status index) → fixed con partial-on-Vigente, M3 (modal-tie nondeterminism) → fixed con alphabetical tie-break. Live: Cuauhtémoc 09015 = 299 farmacias / 117 estupefacientes / 280 psicotrópicos. Coyoacán AGEB 0900300010681 = 60 farmacias / 59 controlados.

v0.2.6 **CONEVAL GRS al nivel AGEB** shipped 2026-05-05: ingest del dataset INEGI/CONEVAL `GRS_AGEB_urbana_2020.xlsx` (61,430 AGEBs, 95.5% del universo urbano `censo_ageb`). Resuelve la trampa "IRS muncipal aplicado a AGEB es ruido estadístico" — Iztapalapa contiene AGEBs desde Muy bajo (zonas comerciales) hasta Muy alto rezago (Sierra de Santa Catarina); el IRS municipal lo aplana a un solo valor. Pipeline: XLSX→CSV via Python openpyxl + `\copy` (\* sentinel CONEVAL → NULL). Tabla `coneval_grs_ageb_raw` + view `coneval_grs_ageb` (5-grado allowlist + 17 indicadores cast a numeric). `/analytics/ageb-detail` agrega campo `rezago_social: { grado, pobtot, vivpar_hab, indicators: {...17} }` (null fuera de CONEVAL). `/analytics/opportunity-by-ageb` agrega filtro opcional `&rezago_grado=Alto,Muy alto` (allowlist + dedup) y expone per-row `rezago_grado` sin importar filtro. Audit C1 fix (XLSX `None` cells → `*` sentinel, no `""` que rompería el cast de la view) + W1 fix (post-load stress-SELECT).

v0.2.5 **Vertical-agnostic opportunity engine** shipped 2026-05-05: 3 nuevos endpoints generalizan el scoring de v0.2.4 (que hardcodeaba farmacias) a cualquier vertical de establecimiento. `GET /analytics/opportunity-by-ageb?cve_mun=NNNNN&target_scian=NNNN[NN][,...]&order_by=score|pobtot|target_count|total_estab&limit≤100` devuelve ranking por AGEB con `score = pobtot / NULLIF(target_count, 0)` (población por competidor existente — más alto = más desatendido). `GET /analytics/opportunity-by-colonia?cve_mun=NNNNN&target_scian=NNNN[NN][,...]` el mismo análisis a nivel colonia (sin pobtot — score = total_estab/target_count). `GET /analytics/colonias-by-municipio?cve_mun=NNNNN` lista colonias como primitivo. SCIAN dispatch automático: 2/3/4/5/6 dígitos → sector/subsector/rama/subrama/clase columns. Validación: `target_scian` máx 10 códigos, todos con misma longitud, regex `\d{2,6}`. Score es NULL en greenfield (target_count=0) — operator ordena por pobtot DESC para encontrarlos. Ejemplo live: ferreterías (rama 4673) en Benito Juárez → 3 AGEBs greenfield top con pop 6,309 / 5,644 / 4,064.

---

## Estado del proyecto

### v0.1 (DENUE base) — ✅ Completo

| Fase interna | Descripción                                                     | Estado        |
| ------------ | --------------------------------------------------------------- | ------------- |
| 1            | Extractor paginado — cliente HTTP, reintentos, streaming        | ✅ Completado |
| 2            | Schema PostgreSQL + PostGIS, loader con upsert                  | ✅ Completado |
| 3            | Pipeline nacional reanudable (32 estados)                       | ✅ Completado |
| 4            | Pipeline de análisis y reportes (mat-views, clusters, coverage) | ✅ Completado |
| 5            | API interna queryable (Hono, X-Api-Key auth)                    | ✅ Completado |

### v0.2.1 (Censo 2020 + CONEVAL) — ✅ Cerrado a nivel municipal

| Tier | Descripción                                                                                   | Estado                                                                    |
| ---- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1    | Backfill `area_geo` (CVE_MUN_5) + SCIAN ids (×5) desde el CLEE — desbloquea joins municipales | ✅ Completado                                                             |
| 2    | Backfill `ageb` (CVEGEO 13-char) vía spatial join contra polígonos AGEB urbana del MGN 2020   | ✅ Completado                                                             |
| 2.5  | Polígonos ENT/MUN/LOC/AGEB cargados a PostGIS (mapa base + futuros joins espaciales)          | ✅ Completado                                                             |
| —    | Censo 2020 ITER: 195k filas × 286 cols + view `censo_municipios` (14 cols, pobtot/pea/etc.)   | ✅ Completado                                                             |
| —    | CONEVAL Pobreza Municipal: % pobreza/extrema, vulnerabilidad, 6 carencias, línea de pobreza   | ✅ Completado                                                             |
| —    | CONEVAL IRS Municipal: índice + grado + rezago educativo/salud/calidad-vivienda × 7           | ✅ Completado                                                             |
| —    | AGEB-level Censo (RESAGEBURB) y rezago social AGEB                                            | ⏳ Pendiente — portal CONEVAL/INEGI cerrado, requiere asistencia operador |

### v0.2.2 (CE 2024 + CLUES + SESNSP) — ✅ Completo

| Sub | Descripción                                                                                                                                                                                                | Estado                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| —   | **CLUES** (DGIS Catálogo Establecimientos de Salud, ene-2026): 63,708 raw → 41,381 EN OPERACION → 39,946 (96.5%) geocodificadas. `clues` materialized view con cve_mun + cve_loc + geom POINT(4326) + GIST | ✅ Completado                                                                         |
| —   | **CE 2024** (Censo Económico INEGI): 32 state ZIPs → `ce2024_municipal` MV con 1.80M filas (sector × estrato × municipio), métricas UE/personal/valor agregado/remuneraciones/ingresos                     | ✅ Completado 2026-05-05                                                              |
| —   | **SESNSP RNID** (Incidencia Delictiva 2015–2026 Mar): 31.6M filas long-form en `sesnsp_delitos_municipal` + `mv_delitos_municipal_yearly` (28k filas pre-roll) + 2 endpoints `/analytics/risk-*`           | ✅ Completado 2026-05-05 (sólo Delitos Municipal — Estatal y Víctimas se descartaron) |

---

## Hoja de Ruta — Versionado Semántico

La evolución del stack se organiza por **fuente de datos integrada**. Cada versión v0.2.x agrega una capa nueva al modelo analítico sin romper la API existente.

| Versión        | Fuentes                   | Descripción                                                                                                                                                                                                                        | Estado              | Docs                                                                |
| -------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------- |
| **v0.1**       | DENUE                     | Baseline — extracción, carga, análisis y API. Farmacias y todos los verticales SCIAN                                                                                                                                               | ✅ Done             | este README                                                         |
| **v0.2.1**     | Censo 2020 + CONEVAL      | ITER municipal + Pobreza/IRS municipal. Join por `cve_mun`. AGEB-level pendiente                                                                                                                                                   | ✅ Done (municipal) | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.2**     | CE 2024 + CLUES + SESNSP  | Revenue sectorial, infraestructura médica, riesgo de seguridad. Score combinado Fase 2                                                                                                                                             | ✅ Done             | [fase-2-ce2024-clues-sesnsp.md](docs/fase-2-ce2024-clues-sesnsp.md) |
| **v0.2.3-A**   | EDR mortalidad 2024       | 819,672 deaths × cve_mun + cause-of-death breakdown + tasa por 1k. Mat-view + 2 endpoints + boot resolver                                                                                                                          | ✅ Done             | [v0.2.3-plan.md](docs/v0.2.3-plan.md)                               |
| **v0.2.3-C-1** | ENIGH 2024 calibrador     | 91,414 hogares → 32 entidades. Weighted decil P10/P50/P90 + Engel coefficient. 1 endpoint `/state-calibrators`                                                                                                                     | ✅ Done             | [v0.2.3-plan.md](docs/v0.2.3-plan.md)                               |
| **v0.2.3-C-2** | ENOE 2025 calibrador      | 1.69M sdem rows × 4 trimestres → 32 entidades year-averaged. tasa_participacion/desocupacion/informalidad + ingreso/mes                                                                                                            | ✅ Done             | [v0.2.3-plan.md](docs/v0.2.3-plan.md)                               |
| **v0.2.3-B**   | Datatur turismo           | Mixed: ~50/70 destinos direct-join post-crosswalk; ~20 = calibradores zonales                                                                                                                                                      | ⏸ Defer crosswalk   | [v0.2.3-plan.md](docs/v0.2.3-plan.md)                               |
| **v0.2.4-A**   | AGEB analytics primitive  | 3 endpoints sub-municipales sobre `ageb_polygons` × `establecimientos.ageb` × `clues_raw` (PostGIS spatial). Score raw                                                                                                             | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.4-B**   | Census-AGEB indicators    | INEGI RESAGEBURB 2020 urbana — 64,313 AGEBs × 230 cols. ageb-detail returns nested census; opportunity adds score_per_1k                                                                                                           | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.5**     | Vertical-agnostic engine  | 3 endpoints: opportunity-by-ageb / opportunity-by-colonia / colonias-by-municipio. SCIAN dispatch 2-6 dig, score=pobtot/target                                                                                                     | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.6**     | CONEVAL GRS al AGEB       | 61,430 AGEBs × 5-grado + 17 indicadores. ageb-detail `rezago_social`; opportunity-by-ageb `rezago_grado` filter                                                                                                                    | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.7**     | Capa demanda salud        | SINBA EC 2023 (DM2/HTA/obesidad por muni) + Censo 2020 derechohabiencia (psinder per-AGEB). 4 nuevos campos en opportunity-by-ageb                                                                                                 | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.8**     | COFEPRIS Padrón licencias | 2,381 farmacias (2,195 Vig), 92.3% geocoded a AGEB. 2 endpoints muni+AGEB con 6 controlados-class counts                                                                                                                           | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.9**     | Sub-AGEB drilldown        | 2 endpoints `/manzanas-by-ageb` + `/colonias-by-ageb`. Vista censo_manzana extendida con tvivpar/vph_inter/vph_autom                                                                                                               | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.10**    | Censo wider + tres-grain  | View extension: `censo_municipios` 14→50 cols + new `censo_localidades` (193k) + new `censo_entidades` (32). 4 endpoints: `/localities-by-municipio` + `/locality-detail` + `/municipio-detail` + `/entidad-detail`                | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.2.11**    | Bienestar federal trim.   | Padrón Único de Bienestar (datos.gob.mx) — 736 rows × 23 trimestres × 32 entidades + national rolled. `bienestar_estatal_trimestral` + `bienestar_estatal_latest` views. `/entidad-detail` extendido con nested `bienestar_latest` | ✅ Done             | [v0.2-status.md](docs/v0.2-status.md)                               |
| **v0.3 P2**    | Locust mode (analyzer)    | 5 charts ECharts (treemap, heatmap, top sectores, scatter, salud) + 4 endpoints `/analytics/*`                                                                                                                                     | ✅ Done             | [analyzer-plan-v1.md](docs/analyzer-plan-v1.md)                     |
| **v0.3 P3**    | Map mode (analyzer)       | MapLibre + Carto basemap + MVT vector source (heatmap + circles) + deck.gl cluster overlay + click-to-detail                                                                                                                       | ✅ Done             | [analyzer-plan-v1.md](docs/analyzer-plan-v1.md)                     |
| **v0.3 P4**    | Deploy                    | Live at [`uncharted.eurekamd.cloud`](https://uncharted.eurekamd.cloud) via Caddy + Let's Encrypt + systemd. EurekaMD-brand URL superseded sealed-plan `analyzer.denue.net`                                                         | ✅ Done             | [analyzer-plan-v1.md](docs/analyzer-plan-v1.md)                     |

**Total realista: ~10-12 días de trabajo activo** para stack funcional y refinable (v0.4).

### Lógica de versiones

- `v0.1.x` — parches y fixes sobre el extractor/API base
- `v0.2.x` — cada `.x` es una fuente de datos nueva integrada al pipeline
- `v0.3+` — capa de presentación (frontend) sobre la API estable

---

## Descripción

El DENUE es el directorio más completo de establecimientos económicos en México. Este proyecto automatiza la extracción, transformación y persistencia de esos datos para inteligencia de negocios, segmentación de mercados y análisis geoespacial.

### Casos de uso implementados

- Extracción filtrada por estado, municipio y condición de búsqueda
- Pipeline nacional reanudable (32 entidades, ~6.1M establecimientos)
- Análisis de densidad, cobertura y clustering por SCIAN
- Detección de hipersaturación y desiertos comerciales
- API HTTP interna con autenticación por API key
- **v0.2.1**: análisis cruzado DENUE × Censo 2020 × CONEVAL Pobreza × IRS — densidad comercial vs pobreza/educación/infraestructura por municipio
- **v0.2.1**: tiles vectoriales (`ST_AsMVT`) listos para frontend de mapa
- **v0.2.2**: proximidad espacial DENUE × CLUES — `ST_DWithin` para "farmacias dentro de 2km de una unidad médica pública" + ratios CLUES-por-100k para detectar desiertos de salud
- **v0.3 P3**: navegación geográfica del dataset — heatmap de densidad zoom-out, puntos individuales clickables zoom-in, filtros entidad+sector cascadean a la URL del MVT, cluster centroids superpuestos cuando ambos filtros están activos

### Verticales analizados (v0.1)

| Vertical                       | SCIAN        | Notas                        |
| ------------------------------ | ------------ | ---------------------------- |
| Farmacias                      | 46591, 46592 | Farmacia sin/con consultorio |
| Hospitales y clínicas privadas | 621–623      | Candidato principal v0.2.1+  |
| Restaurantes / QSR             | 722          | Relevante para Xolo Rides    |
| Educación privada              | 611          | Mercado mid-size             |
| Conveniencia / abarrotes       | 461          | Competencia OXXO             |
| Gimnasios / fitness            | 7139         | NSE alto                     |

### Validación end-to-end (2026-05-04)

Pipeline nacional completado en una sola corrida desatendida (~8h 24min, 0 fallas, 32/32 entidades).

| Métrica                           | Valor                        | Notas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Filas en Supabase                 | **6,097,681**                | `SELECT COUNT(*) FROM establecimientos`                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Cobertura PostGIS (`geom`)        | 6,097,681 (100%)             | `ST_SetSRID(ST_MakePoint(lon, lat), 4326)` aplicado a cada registro                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| CLEEs únicos                      | 6,097,681                    | sin duplicados después del fix `?on_conflict=clee` (ver Gotcha PostgREST)                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Entidades                         | 32 + 1 anomalía              | `01`–`32` + 1 fila con `entidad='50'` (anomalía INEGI, 1 registro)                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CDMX (`09`)                       | 460,866                      | piloto inicial — coincide con conteo INEGI dentro del margen                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Tlaxcala (`29`)                   | 98,729                       | INEGI autoritativo: 98,711 (∆ +0.018%, dentro del margen)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Colima (`06`)                     | 41,765                       | INEGI autoritativo: 41,756 (∆ +0.022%, dentro del margen)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Mat-views aplicadas               | 0                            | Definidas en `src/analysis/*.ts`; aún no ejecutadas contra el DB                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Endpoints API funcionales         | 32 (+ `/health` = 33 routes) | 8 base + 24 `/analytics/*` cubriendo treemap nacional, sector-grade matrix, municipios×entidad, opportunity engine (vertical-agnostic AGEB/colonia), AGEB primitives (detail, by-municipio, opportunity), risk surface (SESNSP), mortality (EDR), state calibrators (ENIGH+ENOE), licensed pharmacies (COFEPRIS), sub-AGEB drilldown (manzanas, colonias), airports-by-municipio (SCT/AFAC traveler influx), **simetría tres-grain detail (entidad/muni/locality) + localities-by-municipio** (Censo wider surface) |
| Frontend analyzer (Locust)        | 5 charts ECharts             | Mosaico nacional treemap + Sector×IRS heatmap + Top sectores bar + Densidad-vs-Pobreza scatter + CLUES vs farmacias por 100k                                                                                                                                                                                                                                                                                                                                                                                        |
| Frontend analyzer (Map)           | MapLibre + deck.gl           | Carto Positron/Dark Matter basemap + MVT vector source (heatmap zoom<14, circles zoom≥11) + cluster centroids overlay + click-to-detail panel                                                                                                                                                                                                                                                                                                                                                                       |
| Web bundle (production split)     | 487 + 467 KB gz              | `index-*.js` Locust + shared (487 KB gz) + `MapMode-*.js` lazy chunk (467 KB gz, only on `/map` navigation). Caddy serves with gzip + immutable cache                                                                                                                                                                                                                                                                                                                                                               |
| Mat-views perf-backed             | 4 mat-views                  | `mv_sector_grade_matrix` (13.7s→91ms) + `mv_national_treemap` (1.15s→88ms) + `mv_delitos_municipal_yearly` (~6s build, 28k rows / 100ms reads) + `mv_mortalidad_municipal_yearly` (5,752 rows / EDR 2024). DDL: `scripts/perf-matviews.sql`. Manual refresh: `scripts/refresh-matviews.sh` (~22-90s all 4). Auto refresh: `denue-matview-refresh.timer` daily 04:00 UTC                                                                                                                                             |
| Tests                             | 581 backend + 33 web = 614   | Backend src + scripts + web. Vitest, mocked fetch + execFileSync + execFile, no live HTTP/Supabase                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Polígonos PostGIS (Tier 2)        | 4 tablas                     | `ent_polygons` (32) + `mun_polygons` (2,469) + `loc_polygons` (50,308) + `ageb_polygons` (81,451), todos SRID 4326 + GIST                                                                                                                                                                                                                                                                                                                                                                                           |
| Cobertura `ageb` (CVEGEO 13-char) | 6,097,666 (99.99975%)        | Spatial join con `ageb_polygons.cvegeo`; 15 puntos sin AGEB son lat/lon malos                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Censo 2020 ITER                   | 195,662 filas                | Tabla `censo_iter` (286 cols TEXT) + view `censo_municipios` (2,469 con 14 cols casteadas)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CONEVAL Pobreza Municipal         | 2,469 filas                  | View `coneval_pobreza_municipal` — % pobreza/extrema, vulnerabilidad, 6 carencias sociales                                                                                                                                                                                                                                                                                                                                                                                                                          |
| CONEVAL IRS Municipal             | 2,469 filas                  | View `coneval_irs_municipal` — analfabetismo, asistencia escolar, calidad vivienda × 7, IRS índice                                                                                                                                                                                                                                                                                                                                                                                                                  |
| CLUES (DGIS, ene-2026)            | 41,381 EN OPERACION          | `clues` materialized view — 39,946 (96.5%) geocodificadas, GIST sobre geom POINT(4326), btree sobre cve_mun + cve_loc + institucion + nivel_atencion                                                                                                                                                                                                                                                                                                                                                                |
| CE 2024 (Censo Económico)         | 1,796,546 filas              | `ce2024_municipal` MV — sector × estrato × municipio, métricas UE/personal_ocupado/producción_bruta/valor_agregado/remuneraciones/ingresos. Bootstrap: `ce2024_raw` (1.92M filas, 105 cols TEXT, mezcla state-level + municipal)                                                                                                                                                                                                                                                                                    |
| SESNSP RNID Delitos Municipal     | 31.6M long-form              | `sesnsp_delitos_municipal` — 12 años × ~2,500 munis × ~38 delitos × 12 meses, 2015–2026 Mar (~22.2M eventos). Pre-roll: `mv_delitos_municipal_yearly` (28,663 filas, 100ms reads). Cve.Municipio LPAD'd a 5 chars para join con DENUE.                                                                                                                                                                                                                                                                              |
| Airports SCT/AFAC (Mar 2006-2026) | 1,258 (airport×year cells)   | `aeropuertos_movements_raw` (raw pivot) + `aeropuertos_cvemun_lookup` (64 airports → cve_mun, city-served not airfield) + 2 views (`aeropuertos_movements_yearly`, `aeropuertos_by_municipio`). Endpoint `/analytics/airports-by-municipio?cve_mun=NNNNN` returns per-airport mar26/recent-avg/2019-baseline/%change. Source: gob.mx producto-aeropuertos-2006-2026-mar-NNN.xlsx (F5/Imperva-gated, fetched via Playwright stealth).                                                                                |

---

## Estructura

```
denue-data-analysis/
├── src/
│   ├── extractor/          # Cliente DENUE API + paginación
│   ├── db/                 # loader.ts: upsert a Supabase + PostGIS geom
│   ├── pipeline/           # Orquestador nacional reanudable
│   ├── analysis/           # Runners de mat-views, clusters, coverage
│   └── api/                # Hono HTTP server (Fase 5 + P1 + v0.3 P2 analytics)
│       ├── server.ts       # createServer factory (testeable)
│       ├── handlers/       # /search, /establishment, /summary/*, /clusters, /entidades, /sectors, /tiles, /analytics/*
│       └── middleware/     # auth (X-Api-Key), error, log, rate-limit
├── scripts/
│   ├── extract.ts          # Extractor de un estado individual
│   ├── pipeline.ts         # Pipeline nacional reanudable (DENUE)
│   ├── load.ts             # Carga manual JSON → Supabase (DENUE)
│   ├── analyze.ts          # Correr runners de análisis
│   ├── coverage.ts         # Reporte de cobertura por entidad
│   ├── serve.ts            # Arranca el servidor HTTP (Fase 5)
│   ├── backfill-ageb.ts    # Spatial join: rellena `ageb` con CVEGEO 13-char (Tier 2)
│   ├── load-censo.ts       # Cargar Censo 2020 ITER → censo_iter / censo_municipios (v0.2.1)
│   ├── load-coneval.ts     # Cargar CONEVAL Pobreza + IRS Municipal (v0.2.1)
│   ├── load-clues.ts       # Cargar CLUES DGIS → clues_raw / clues mat-view + GIST (v0.2.2)
│   ├── load-ce2024.ts      # Cargar CE 2024 (32 state ZIPs) → ce2024_raw / ce2024_municipal MV (v0.2.2)
│   ├── load-sesnsp.ts      # Cargar SESNSP RNID Delitos Municipal → sesnsp_delitos_municipal MV (v0.2.2)
│   ├── perf-matviews.sql   # Bootstrap analytics MVs (sector_grade_matrix, national_treemap, delitos_municipal_yearly)
│   └── refresh-matviews.sh # Refresh todos los MVs analíticos en una pasada (~22-90s; daily via denue-matview-refresh.timer)
├── web/                    # Analyzer frontend — Vite + React + Tailwind + ECharts + MapLibre + deck.gl
│   └── src/
│       ├── api/            # client.ts + types.ts (Zod) + queries.ts (TanStack hooks)
│       ├── charts/         # 5 Locust charts + theme.ts + ChartCard wrapper
│       ├── map/            # MapShell (MapLibre+MVT) + ClusterOverlay (deck.gl) + EstablishmentCard + style
│       ├── components/     # ApiKeyGate, FilterPanel, SearchBar, Layout, ErrorBoundary
│       └── modes/          # LocustMode (charts), MapMode (MapLibre + deck.gl)
├── docs/
│   ├── analyzer-plan-v1.md         # Plan sellado del frontend (v0.3+v0.4)
│   ├── v0.2-status.md              # Hoja de estado del roadmap v0.2.x (sobrevive /compact)
│   ├── plan-integracion-datos-mexico.md
│   ├── fuentes-datos-gubernamentales.md
│   ├── fase-1-censo-coneval.md
│   ├── fase-2-ce2024-clues-sesnsp.md
│   └── fase-3-detalle.md
├── data/
│   ├── raw/                # JSON crudo del extractor (.gitignore)
│   └── state/              # pipeline-state.json (checkpoint reanudable)
├── env.example
├── package.json
└── tsconfig.json
```

---

## Instalación

```bash
npm install
cp env.example .env
# Editar .env con SUPABASE_URL, SUPABASE_SERVICE_KEY, DENUE_TOKEN, API_KEY
```

### Dependencias

| Paquete             | Tipo    | Uso                                    |
| ------------------- | ------- | -------------------------------------- |
| `hono`              | runtime | Router HTTP de Fase 5                  |
| `@hono/node-server` | runtime | Adapter Node.js para Hono              |
| `tsx`               | dev     | Ejecución TypeScript sin compilación   |
| `typescript`        | dev     | Compilador (`npm run typecheck/build`) |
| `vitest`            | dev     | Test runner                            |
| `@types/node`       | dev     | Tipos Node                             |

El acceso a Supabase usa la API REST (PostgREST) vía `fetch` nativo y `docker exec ... psql` para el SQL directo (clusters, geom). No hay cliente `@supabase/supabase-js` ni dependencias de validación/logging — la superficie de runtime se mantiene mínima a propósito.

---

## Configuración

```env
# .env
SUPABASE_URL=http://localhost:8100               # URL de Supabase (Kong)
SUPABASE_SERVICE_KEY=<service_role_jwt>          # JWT service_role
DENUE_TOKEN=<token_inegi>                        # https://www.inegi.org.mx/app/api/denue/v1/tokenVerify.aspx
API_KEY=<clave_para_api_interna>                 # Header X-Api-Key requerido en Fase 5

# Opcionales (con defaults)
# API_PORT=3030                                  # puerto del servidor HTTP
# SUPABASE_DB_CONTAINER=supabase-db              # contenedor Postgres
# OUTPUT_DIR=./data                              # raíz para artefactos del pipeline (lee scripts/pipeline.ts; scripts/extract.ts hardcodea ./data/raw)
# STATE_DIR=./data/state                         # ubicación de pipeline-state.json
```

---

## Uso

### Extracción de uno o varios estados

```bash
# pipeline.ts (orquestador con checkpoint y carga a Supabase)  — flag plural
npx tsx --env-file=.env scripts/pipeline.ts --estados=09
npx tsx --env-file=.env scripts/pipeline.ts --estados=09,15,14

# extract.ts (extractor crudo a JSON, sin carga a Supabase)    — flag singular
npx tsx --env-file=.env scripts/extract.ts --estado=09
npx tsx --env-file=.env scripts/extract.ts --estado=all --condicion=farmacia
# 09 = CDMX, 15 = México, 14 = Jalisco. Ver tabla de claves INEGI.
```

### Pipeline nacional (todos los estados)

```bash
npx tsx --env-file=.env scripts/pipeline.ts --all
# Reanudable: guarda estado en data/state/pipeline-state.json
```

Para pipelines de larga duración, usar tmux:

```bash
tmux new-session -d -s denue-national \
  "cd /root/claude/projects/data-intelligence/denue-data-analysis && \
   npx tsx --env-file=.env scripts/pipeline.ts --all 2>&1 | tee /tmp/denue-national.log"
```

### Carga manual a Supabase

```bash
npx tsx --env-file=.env scripts/load.ts --file=data/raw/09_distrito-federal.json
```

### API HTTP (v0.1 — Fase 5)

```bash
npx tsx --env-file=.env scripts/serve.ts
# Default: escucha en :3030. Cambiar con API_PORT.
```

Endpoints disponibles:

| Método | Ruta                      | Auth | Rate-limit | Descripción                                                                                                     |
| ------ | ------------------------- | ---- | ---------- | --------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/health`                 | ✗    | ✗          | Liveness check (sin auth, para probes)                                                                          |
| `GET`  | `/search`                 | ✓    | ✗          | Búsqueda paginada: `?q=`, `?entidad=`, `?from=lat,lon&radius_km=`, `?page=&limit=` (`limit` máx 1000)           |
| `GET`  | `/establishment/:clee`    | ✓    | ✗          | Lookup por CLEE individual (28 caracteres alfanuméricos)                                                        |
| `GET`  | `/summary/sector/:scian`  | ✓    | ✗          | Resumen nacional por sector SCIAN de 2 dígitos: total nacional + top entidades (agrega CLEE chars 6-7)          |
| `GET`  | `/summary/entidad/:clave` | ✓    | ✗          | Resumen por entidad (`01`–`32`): cargados + total INEGI + cobertura % + top sectores + distribución de estratos |
| `GET`  | `/clusters`               | ✓    | ✗          | Clustering K-means PostGIS: `?entidad=&scian=&k=` — agrupa establecimientos por sector dentro de una entidad    |
| `GET`  | `/entidades`              | ✓    | ✗          | Dropdown source para el frontend: 32 estados con `loaded` + `inegi_total` + `status` (`Cache-Control: 60s`)     |
| `GET`  | `/sectors`                | ✓    | ✗          | Dropdown source para el frontend: 23+ SCIAN de 2 dígitos con `national_count` (ordenado DESC)                   |
| `GET`  | `/tiles/:z/:x/:y.mvt`     | ✓    | 5 req/s/IP | Vector tile MVT (PostGIS `ST_AsMVT`): `?entidad=&sector=`, `Cache-Control: 1h`, cap 50k features/tile           |

Autenticación: header `X-Api-Key: <API_KEY>` en todas las rutas excepto `/health`. Sin la clave o con clave incorrecta el servidor responde `401`.

### Tests

```bash
npm test                    # vitest run — suite completa
npm run typecheck           # tsc --noEmit
```

---

## Notas de implementación

### Interfaz canónica de la API (`DenueRawRecord`)

Todos los módulos de análisis consumen `DenueRawRecord` — no los tipos raw de la API INEGI. El extractor normaliza antes de persistir.

### Extracción de entidad

La API INEGI pagina por `registro_inicio` + `registro_fin`. El extractor mantiene checkpoint en `data/state/` para reanudar después de interrupciones.

### Formato de `Ubicacion`

`{ latitud: number, longitud: number }` — siempre números, nunca strings. La API INEGI devuelve strings; el extractor hace el cast.

### Throttle global de API

500ms entre requests por defecto, configurable vía el parámetro `delayMs` que el extractor pasa al cliente (`src/extractor/denue-client.ts`). Subir si la API INEGI devuelve 429.

### pageSize = 500

Máximo permitido por la API INEGI. Valores mayores se truncan silenciosamente a 500.

### Gotcha PostgREST — `?on_conflict=` es obligatorio

PostgREST requiere el query param `?on_conflict=<column>` para que el header `Prefer: resolution=merge-duplicates` haga upsert sobre una columna `UNIQUE` que no es la PK. Sin ese query param, PostgREST silenciosamente convierte el upsert en INSERT puro y descarta filas que colisionan con la `UNIQUE` constraint, sin error.

Síntoma: `loadRecords` reporta `inserted=N` pero `SELECT COUNT(*)` muestra muchos menos. En la corrida nacional este bug provocó ~75% de pérdida hasta detectarlo. Fix actual: `loader.ts` envía `POST /establecimientos?on_conflict=clee` con `Prefer: resolution=merge-duplicates,return=minimal`.

### Filtro por municipio

La API INEGI acepta `municipio` como string de 5 dígitos (`cve_ent` + `cve_mun`). Ejemplo CDMX Benito Juárez: `"09014"`.

### Mat-views: definidas, no aplicadas

El DDL vive en `src/db/materialized-views.sql` y se aplica con `scripts/analyze.ts`. Los runners en `src/analysis/*.ts` solo _leen_ las vistas (vía PostgREST). Tres vistas definidas:

- `mv_sector_summary` — agregados por sector (clase_actividad) y entidad
- `mv_coverage` — conteo cargado por entidad + comparación contra INEGI autoritativo
- `mv_estrato_por_entidad` — distribución por estrato de personal ocupado por entidad

Hoy la base no tiene ninguna mat-view aplicada (`SELECT * FROM pg_matviews` → 0 filas). Los handlers de `/summary/*` que dependen de ellas funcionarán solo después de ejecutar `npx tsx --env-file=.env scripts/analyze.ts`.

---

## Estimaciones de volumen (extracción nacional)

| Alcance                 | Establecimientos | Tiempo medido      |
| ----------------------- | ---------------- | ------------------ |
| 1 estado (CDMX, `09`)   | 460,866          | ~45 min            |
| 1 estado (Colima, `06`) | 41,765           | ~5 min             |
| Nacional (32 entidades) | 6,097,681        | ~8h 24min (medido) |

Con tmux + checkpoint, el pipeline nacional es completamente desatendido.

---

## Fuente de datos

- **DENUE:** https://www.inegi.org.mx/servicios/api_denue.html
- **Documentación API:** https://www.inegi.org.mx/app/api/denue/v1/consulta/
- **Documentación de fases (v0.2.x+):** `docs/` en este repositorio

---

## Integración con agentes (Jarvis)

Cuando el operador hace preguntas en lenguaje natural sobre el DENUE Analyzer, Jarvis (mission-control) carga dos directivas KB que viven en `/root/claude/jarvis-kb/directives/`:

- **`denue-analyzer-granularities.md`** — schema reference: qué tablas y endpoints existen, cuándo usar cada nivel territorial (entidad → muni → AGEB → manzana → colonia → establecimiento), tablas calientes con cheatsheet de columnas, anti-patrones de schema (e.g., `mun_polygons` es geometría sólo, no demografía).

- **`denue-patterns.md`** — pattern catalog: 12 patrones operacionales que mapean **intención del operador → ruta de ejecución → output template**, con quick-lookup table de triggers verbatim, decision tree, y log de patrones nuevos para crecimiento orgánico. Cubre: site selection end-to-end, demographic ranking, brand/razón-social lookup, vertical footprint, competitive saturation, cross-layer intersection, public-data drilldown (delitos/mortalidad/pobreza), establishment detail, coverage/health-check, travel/tourism influx, license/regulatory pharma, census microdata.

Estas directivas son la fuente canónica de cómo se debe consultar el analyzer desde un agente. Si añades un endpoint nuevo o detectas un patrón de pregunta recurrente, actualiza la directiva correspondiente.

## Organización

Proyecto de inteligencia de datos. Uso interno.
Documentación de integración completa en `/root/claude/projects/data-intelligence/docs/`.
