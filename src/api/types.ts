/**
 * Phase 5 — HTTP API request/response shapes.
 *
 * Validation regexes match the cluster runner — keep in sync if changed.
 * Public surface for any caller building dashboards / BI / scripts.
 */

export interface ApiServerConfig {
  /** Supabase Kong URL (e.g. http://localhost:8100) */
  supabaseUrl: string;
  /** Supabase service_role JWT */
  serviceRoleKey: string;
  /** Required X-Api-Key header value. Server fails to start if not set. */
  apiKey: string;
  /** Postgres docker container name for direct-SQL operations (clusters, ST_DWithin) */
  dbContainer: string;
  /**
   * Resolved at server start by `resolveCurrentRiskAno()` from
   * `MAX(ano) FROM mv_delitos_municipal_yearly WHERE ano <= EXTRACT(YEAR
   * FROM NOW())`. When omitted (e.g. tests, or DB query failed), handlers
   * fall back to `RISK_DEFAULT_CURRENT_ANO`. Audit W5 long-term fix.
   */
  currentRiskAno?: number;
  /**
   * Resolved at server start by `resolveCurrentMortalityAno()` from
   * `MAX(ano) FROM inegi_edr_defunciones_raw HAVING COUNT(*) >= 100k`.
   * Picks the year with the bulk of registered deaths so partial / lag
   * years don't become the default. When omitted (tests, DB failure at
   * boot), handlers fall back to `MORTALITY_DEFAULT_CURRENT_ANO`. v0.2.3-A.
   */
  currentMortalityAno?: number;
}

// Shared validation regexes — same bounds as src/analysis/cluster-by-sector.ts
export const ENTIDAD_RE = /^(0[1-9]|[12][0-9]|3[0-2])$/;
export const SCIAN_RE = /^[0-9]{2}$/;
// CLEE is uppercase in production data (verified against the real fixture).
// Audit W7: dropped /i flag so the handler regex matches DB casing — a lowercase
// CLEE input is rejected at validation (400) instead of silently producing 404.
export const CLEE_RE = /^[A-Z0-9]{20,30}$/;

// Pagination bounds
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 1000;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export interface SearchQuery {
  q?: string;
  entidad?: string;
  /** "lat,lon" pair */
  from?: string;
  /** Distance in km from `from`. Requires `from`. */
  radius_km?: number;
  page?: number;
  limit?: number;
}

export interface SearchResult {
  rows: Array<Record<string, unknown>>;
  page: number;
  limit: number;
  total_returned: number;
}

// ---------------------------------------------------------------------------
// Establishment
// ---------------------------------------------------------------------------

export interface EstablishmentResult {
  clee: string;
  data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Sector summary
// ---------------------------------------------------------------------------

export interface SectorSummaryResult {
  scian: string;
  total_national: number;
  top_entidades: Array<{ entidad: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Entidad summary
// ---------------------------------------------------------------------------

export interface EntidadSummaryResult {
  entidad: string;
  loaded: number;
  inegi_total: number | null;
  coverage_pct: number | null;
  status: "green" | "yellow" | "red" | "unverified";
  top_sectors: Array<{
    scian_id: string;
    clase_actividad: string | null;
    count: number;
  }>;
  estrato_distribution: Array<{ estrato: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Clusters
// ---------------------------------------------------------------------------

export interface ClustersQuery {
  entidad: string;
  scian: string;
  k?: number;
}

// Re-export the runner's centroid type so API consumers have one place
export type { ClusterCentroid } from "../analysis/cluster-by-sector.js";

// ---------------------------------------------------------------------------
// Entidades dropdown
// ---------------------------------------------------------------------------

export interface EntidadDropdownEntry {
  clave: string;
  nombre: string;
  loaded: number;
  inegi_total: number | null;
  status: "green" | "yellow" | "red" | "unverified";
}

export interface EntidadesResult {
  entidades: EntidadDropdownEntry[];
}

// ---------------------------------------------------------------------------
// Sectors dropdown
// ---------------------------------------------------------------------------

export interface SectorEntry {
  scian: string;
  name: string;
  national_count: number;
}

export interface SectorsResult {
  sectors: SectorEntry[];
}

// ---------------------------------------------------------------------------
// Analytics endpoints (P2 — Locust mode joins DENUE × Censo × CONEVAL × CLUES)
// ---------------------------------------------------------------------------

export type IrsGrado =
  | "Muy bajo"
  | "Bajo"
  | "Medio"
  | "Alto"
  | "Muy alto"
  | "sin_dato";

export interface NationalTreemapEntry {
  /** 2-char zero-padded entidad clave */
  entidad: string;
  nombre: string;
  establecimientos: number;
  modal_irs_grado: IrsGrado;
  pobreza_pct_promedio: number | null;
}

export interface NationalTreemapResult {
  entidades: NationalTreemapEntry[];
}

export interface SectorGradeMatrixCell {
  scian: string;
  irs_grado: IrsGrado;
  count: number;
}

export interface SectorGradeMatrixResult {
  cells: SectorGradeMatrixCell[];
}

export interface MunicipioAnalyticsRow {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | null;
  establecimientos: number;
  farmacias: number;
  unidades_clues: number;
  pobreza_pct: number | null;
  irs_grado: IrsGrado | null;
  irs_indice: number | null;
}

export interface MunicipiosAnalyticsResult {
  entidad: string;
  municipios: MunicipioAnalyticsRow[];
}

export interface TopSectorRow {
  scian: string;
  name: string;
  count: number;
}

export interface TopSectorsResult {
  entidad: string;
  sectors: TopSectorRow[];
}

// ---------------------------------------------------------------------------
// Risk surface (SESNSP) — see scripts/perf-matviews.sql for the underlying
// mv_delitos_municipal_yearly aggregation.
// ---------------------------------------------------------------------------

/**
 * 4-digit year. Hard-bounded at the handler boundary by `RISK_ANO_RE` so SQL
 * composition cannot receive arbitrary text.
 */
export const RISK_ANO_RE = /^(20[1-3][0-9])$/;

/**
 * 5-char zero-padded cve_mun. Same bounds as the existing CONEVAL / Censo
 * join key (entidad 01-32, municipio 001-999).
 */
export const CVE_MUN_RE = /^(0[1-9]|[12][0-9]|3[0-2])[0-9]{3}$/;

/**
 * Hardcoded fallback for "current year" risk-summary comparisons. Used when
 * `resolveCurrentRiskAno()` cannot reach the DB at server start (and in
 * tests where no DB is wired up). Production reads `config.currentRiskAno`
 * which is resolved from `MAX(ano) FROM mv_delitos_municipal_yearly WHERE
 * ano <= EXTRACT(YEAR FROM NOW())`. Audit W5 (2026-05-05) closed by the
 * runtime resolver; this constant remains as the airbag.
 */
export const RISK_DEFAULT_CURRENT_ANO = 2025;
/** Default lookback for the YoY-change column. 5 years covers the canonical
 * "did this municipality get safer or worse" question. */
export const RISK_DEFAULT_BASELINE_ANO = 2020;

export interface RiskSummaryRow {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | null;
  total_delitos: number;
  robo_negocio: number;
  homicidio_doloso: number;
  extorsion: number;
  patrimoniales: number;
  violentos: number;
  total_baseline: number | null;
  /** Total delitos per 1k inhabitants — null when poblacion is 0/null. */
  delitos_per_1k_pop: number | null;
  /** Percent change vs `baseline_ano`. null when baseline=0 or missing. */
  delitos_change_pct: number | null;
}

export interface RiskSummaryResult {
  entidad: string;
  current_ano: number;
  baseline_ano: number;
  municipios: RiskSummaryRow[];
}

export interface RiskTrendPoint {
  ano: number;
  mes: number;
  robo_negocio: number;
  homicidio_doloso: number;
  extorsion: number;
  total: number;
}

export interface RiskTrendResult {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | null;
  series: RiskTrendPoint[];
}

// ---------------------------------------------------------------------------
// Mortality (EDR/SINAIS) — see scripts/perf-matviews.sql for the underlying
// mv_mortalidad_municipal_yearly aggregation. v0.2.3-A.
// ---------------------------------------------------------------------------

/**
 * Hardcoded fallback for "current year" mortality comparisons. Used when
 * `resolveCurrentMortalityAno()` cannot reach the DB at server start (and
 * in tests where no DB is wired up). Production reads
 * `config.currentMortalityAno` resolved from the data — picks the year
 * with the bulk of registered deaths so partial / lag-artifact years
 * don't become the default.
 */
export const MORTALITY_DEFAULT_CURRENT_ANO = 2024;

export interface MortalitySummaryRow {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | null;
  total_defunciones: number;
  def_menores_1ano: number;
  def_circulatorio: number;
  def_neoplasias: number;
  def_endocrinas: number;
  def_externas: number;
  /** Mortalidad cruda per 1k inhabitants — null when poblacion is 0/null. */
  tasa_mortalidad_per_1k: number | null;
  /** Mortalidad infantil per 1k births (proxied by < 1yr deaths / poblacion). null when poblacion is 0/null. */
  tasa_infantil_per_1k: number | null;
}

export interface MortalitySummaryResult {
  entidad: string;
  current_ano: number;
  municipios: MortalitySummaryRow[];
}

export interface MortalityTrendPoint {
  ano: number;
  total_defunciones: number;
  def_menores_1ano: number;
  def_circulatorio: number;
  def_neoplasias: number;
  def_endocrinas: number;
  def_externas: number;
}

export interface MortalityTrendResult {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | null;
  series: MortalityTrendPoint[];
}

// ---------------------------------------------------------------------------
// State calibrators (ENOE / ENIGH) — v0.2.3-C. Parameter tables keyed by
// entidad that condition / multiply / contextualize the cve_mun-grain rows.
// "Can't infer at municipio" ≠ "no value at municipio" (calibrator pattern).
// ---------------------------------------------------------------------------

export interface StateCalibratorsRow {
  entidad: string;
  // --- ENIGH (annual household income/expense, biennial) ---
  /** ENIGH wave year (2024, 2026, ...). Null if no ENIGH row loaded yet. */
  enigh_ano: number | null;
  /** Hogares represented (factor sum, ~ENIGH-published total). */
  hogares_estimados: number | null;
  /** Población represented (factor * tot_integ sum). */
  poblacion_estimada: number | null;
  /** Ingreso corriente promedio MXN/año, factor-weighted. */
  ingreso_corriente_promedio: number | null;
  /** Mediana del ingreso corriente, factor-weighted. */
  ingreso_corriente_mediana: number | null;
  /** P10 del ingreso corriente. */
  decil_1_ingreso: number | null;
  /** P90 del ingreso corriente. */
  decil_9_ingreso: number | null;
  /** Gasto corriente promedio, factor-weighted. */
  gasto_corriente_promedio: number | null;
  /** % del gasto monetario en alimentos (Engel coefficient). */
  pct_gasto_alimentos: number | null;
  pct_gasto_vivienda: number | null;
  pct_gasto_salud: number | null;
  pct_gasto_transporte: number | null;
  pct_gasto_educacion: number | null;
  // --- ENOE (quarterly labor force, year-averaged across 4 trimestres) ---
  /** ENOE wave year (2025, 2026, ...). Null if no ENOE rows loaded yet. */
  enoe_ano: number | null;
  /** Number of quarters present in the ENOE rollup (1..4). */
  enoe_trimestres_cargados: number | null;
  /** Population 15+ years (per-quarter average, factor-weighted). */
  poblacion_15_mas: number | null;
  /** Población Económicamente Activa (per-quarter avg). */
  pea: number | null;
  /** Población ocupada (per-quarter avg). */
  ocupada: number | null;
  /** Población desocupada (per-quarter avg). */
  desocupada: number | null;
  /** Población ocupada en sector informal (per-quarter avg). */
  informal: number | null;
  /** PEA / Población 15+ × 100. */
  tasa_participacion: number | null;
  /** Desocupada / PEA × 100 (open unemployment rate, INEGI methodology). */
  tasa_desocupacion: number | null;
  /** Informal / Ocupada × 100 (TIL1, INEGI methodology). */
  tasa_informalidad: number | null;
  /** Ingreso promedio mensual de ocupados (factor-weighted, MXN). */
  ingreso_promedio_mensual_ocupado: number | null;
}

export interface StateCalibratorsResult {
  entidad: string;
  /** Single-row response: the calibrator parameters for the requested state. */
  calibrators: StateCalibratorsRow;
}

// ---------------------------------------------------------------------------
// AGEB analytics (v0.2.4-A — sub-municipal primitive)
// ---------------------------------------------------------------------------

/**
 * 13-character AGEB key: ENT(2)+MUN(3)+LOC(4)+AGEB(4). Same shape as the
 * `cvegeo` column in `ageb_polygons` and the `ageb` column in
 * `establecimientos`. INEGI assigns letter suffixes to ~9% of AGEBs
 * (e.g. `211140001086A`) when an existing AGEB is subdivided — the first
 * 12 chars are always digits, the last is digit or uppercase A-Z.
 * v0.2.4-B fix: previous `^[0-9]{13}$` rejected 7,461 valid AGEBs.
 */
export const CVEGEO_RE = /^[0-9]{12}[0-9A-Z]$/;

/** order_by for /analytics/agebs-by-municipio. Constrains the SQL ORDER BY. */
export const AGEBS_ORDER_BY = [
  "establecimientos",
  "farmacias",
  "clues",
  "area",
] as const;
export type AgebsOrderBy = (typeof AGEBS_ORDER_BY)[number];

/** Default + cap for /analytics/agebs-by-municipio limit param. */
export const AGEBS_DEFAULT_LIMIT = 50;
export const AGEBS_MAX_LIMIT = 200;

/** Default + cap for /analytics/ageb-farmacia-opportunity limit param. */
export const AGEB_FARMACIA_DEFAULT_LIMIT = 20;
export const AGEB_FARMACIA_MAX_LIMIT = 100;

/** Cap on CLUES list length in /analytics/ageb-detail (response size guard). */
export const AGEB_DETAIL_CLUES_CAP = 30;

export interface AgebsByMunicipioRow {
  cvegeo: string;
  ambito: "Urbana" | "Rural" | null;
  centroid_lat: number | null;
  centroid_lon: number | null;
  area_km2: number | null;
  establecimientos: number;
  farmacias: number;
  clues: number;
}

export interface AgebsByMunicipioResult {
  cve_mun: string;
  order_by: AgebsOrderBy;
  total_returned: number;
  agebs: AgebsByMunicipioRow[];
}

export interface AgebDetailTopSector {
  scian2: string;
  /** "Industrias manufactureras" / "Comercio al por menor" / etc. */
  nombre: string;
  count: number;
}

export interface AgebDetailClues {
  clues: string;
  nombre: string;
  tipo: string;
  lat: number;
  lon: number;
}

/**
 * AGEB-level census fields from INEGI Censo 2020 RESAGEBURB (urban only).
 * v0.2.4-B (2026-05-05): loaded for 64,313 urban AGEBs across 32 entidades.
 * Rural AGEBs (~17k of 81k total) are NOT in this dataset — fields are
 * null when the cvegeo doesn't match a row in censo_ageb.
 */
export interface AgebCensusFields {
  pobtot: number | null;
  pobfem: number | null;
  pobmas: number | null;
  p_60ymas: number | null;
  p_15ymas: number | null;
  p_18ymas: number | null;
  pea: number | null;
  pocupada: number | null;
  graproes: number | null;
  tvivhab: number | null;
  tvivpar: number | null;
  vph_inter: number | null;
  vph_autom: number | null;
  /**
   * v0.2.7 health-coverage block — derechohabiencia a servicios de salud,
   * Censo 2020. Replaces the rejected IMSS PDA loader (PDA's cve_municipio
   * is IMSS internal subdelegation codes, not joinable to INEGI cve_mun).
   *
   * `psinder` = population WITHOUT institutional derechohabiencia (IMSS /
   * ISSSTE / IMSS-Bienestar / Seguro Popular successor). It does NOT
   * include `pafil_ipriv` (privately-insured folks). For a strict "private-
   * pharma-dependent" estimate combine `psinder + pafil_ipriv` — the
   * institutionally-covered get free meds at SUS clinics, while private-
   * insurance holders typically still buy at retail. We surface both here
   * and let the operator choose the combination per use case.
   */
  pder_ss: number | null;
  pder_imss: number | null;
  pder_imssb: number | null;
  pder_iste: number | null;
  pder_istee: number | null;
  pder_segp: number | null;
  pafil_ipriv: number | null;
  psinder: number | null;
}

/**
 * CONEVAL "Grado de Rezago Social" — 5-level ordinal classification
 * applied per AGEB urbana, derived from a composite of 17 indicators.
 *
 * Loaded from CONEVAL GRS_AGEB_urbana_2020.xlsx (v0.2.6 — 2026-05-05).
 * 61,430 AGEBs — 95.5% of `censo_ageb` urbano. Rural AGEBs not in this
 * dataset.
 */
export const REZAGO_GRADOS = [
  "Muy bajo",
  "Bajo",
  "Medio",
  "Alto",
  "Muy alto",
] as const;
export type RezagoGrado = (typeof REZAGO_GRADOS)[number];

/** Narrow an unknown SQL-returned value to RezagoGrado. */
export function isRezagoGrado(v: unknown): v is RezagoGrado {
  return (
    typeof v === "string" && (REZAGO_GRADOS as readonly string[]).includes(v)
  );
}

/**
 * 17 rezago social indicators per AGEB. Each is a percentage (0..100).
 * NULL when CONEVAL applied LSNIEG art. 37 confidentiality (AGEBs with
 * <3 viviendas habitadas — ~0.5% of rows). Field names mirror loader's
 * lowercase TEXT columns.
 */
export interface RezagoIndicators {
  /** % población 15+ analfabeta */
  ind_analfabeta: number | null;
  /** % población 6-14 que no asiste a la escuela */
  ind_no_escuela_6_14: number | null;
  /** % población 15-24 que no asiste a la escuela */
  ind_no_escuela_15_24: number | null;
  /** % población 15+ con educación básica incompleta */
  ind_basica_incompleta: number | null;
  /** % población sin derechohabiencia a servicios de salud */
  ind_sin_salud: number | null;
  /** % viviendas con hacinamiento */
  ind_hacinamiento: number | null;
  /** % viviendas sin agua entubada */
  ind_sin_agua: number | null;
  /** % viviendas sin excusado/sanitario */
  ind_sin_excusado: number | null;
  /** % viviendas sin drenaje */
  ind_sin_drenaje: number | null;
  /** % viviendas sin energía eléctrica */
  ind_sin_luz: number | null;
  /** % viviendas con piso de tierra */
  ind_piso_tierra: number | null;
  /** % viviendas sin lavadora */
  ind_sin_lavadora: number | null;
  /** % viviendas sin refrigerador */
  ind_sin_refri: number | null;
  /** % viviendas sin teléfono fijo */
  ind_sin_telfijo: number | null;
  /** % viviendas sin celular */
  ind_sin_celular: number | null;
  /** % viviendas sin computadora */
  ind_sin_compu: number | null;
  /** % viviendas sin internet */
  ind_sin_internet: number | null;
}

/**
 * Composite rezago social bundle for one AGEB. v0.2.6 addition.
 *
 * `grado` is the headline 5-level classifier (CONEVAL methodology).
 * `pobtot` and `vivpar_hab` are population/dwelling totals from the
 * CONEVAL row — usually identical to `censo_ageb.pobtot` / `tvivpar` but
 * occasionally differ (~few hundred AGEBs) because CONEVAL released its
 * own censo extraction. We expose both so callers can detect drift.
 */
export interface RezagoSocial {
  grado: RezagoGrado;
  pobtot: number | null;
  vivpar_hab: number | null;
  indicators: RezagoIndicators;
}

export interface AgebDetailResult {
  cvegeo: string;
  cve_ent: string;
  cve_mun: string;
  cve_loc: string;
  cve_ageb: string;
  ambito: "Urbana" | "Rural" | null;
  area_km2: number | null;
  centroid_lat: number | null;
  centroid_lon: number | null;
  /** Bounding box [minLon, minLat, maxLon, maxLat]. */
  bbox: [number, number, number, number] | null;
  /** Population at the containing locality (locality-level, from censo_iter). */
  loc_population: number | null;
  loc_name: string | null;
  /**
   * Population at the AGEB itself (from censo_ageb 2020 urban dataset).
   * null when AGEB is rural (not in RESAGEBURB) or not yet ingested.
   * Prefer this over loc_population when non-null. v0.2.4-B addition.
   */
  population: number | null;
  /**
   * Demographic + dwelling breakdown at AGEB level (Censo 2020 urbana).
   * null for rural AGEBs not in RESAGEBURB. v0.2.4-B addition.
   */
  census: AgebCensusFields | null;
  /**
   * CONEVAL Grado de Rezago Social + 17 indicators, AGEB granularity.
   * null when AGEB is not in CONEVAL GRS_AGEB_urbana_2020 (rural or
   * post-2020 subdivision). v0.2.6 addition.
   *
   * Resolves the "muni-IRS-applied-to-AGEB is statistical noise" trap
   * that motivated v0.2.6: a single muni like Iztapalapa contains AGEBs
   * spanning Muy bajo → Muy alto rezago.
   */
  rezago_social: RezagoSocial | null;
  total_establecimientos: number;
  total_farmacias: number;
  top_sectors: AgebDetailTopSector[];
  clues_count: number;
  /** Capped at AGEB_DETAIL_CLUES_CAP. */
  clues_sample: AgebDetailClues[];
}

export interface AgebFarmaciaOpportunityRow {
  cvegeo: string;
  ambito: "Urbana" | "Rural" | null;
  centroid_lat: number | null;
  centroid_lon: number | null;
  area_km2: number | null;
  num_establecimientos: number;
  num_farmacias: number;
  num_clues: number;
  /**
   * Coarse demand-minus-supply proxy.
   *   score = num_clues × 0.5 + num_establecimientos × 0.3 − num_farmacias × 1.0
   * Higher = more attractive AGEB to place a farmacia. NOT population-normalized.
   * Use ranking, not absolute value. v0.2.4-B adds `score_per_1k` for the
   * population-aware variant.
   */
  score: number;
  /**
   * AGEB population from censo_ageb 2020 urbana. null for rural AGEBs.
   * v0.2.4-B addition.
   */
  population: number | null;
  /**
   * Score normalized by AGEB population: `score / population × 1000`.
   * null when population is null or 0. Use to compare opportunity per
   * resident across AGEBs of different sizes — small AGEBs with no
   * farmacias rank lower on raw score (less absolute demand) but can
   * surface here. v0.2.4-B addition.
   */
  score_per_1k: number | null;
}

export interface AgebFarmaciaOpportunityResult {
  cve_mun: string;
  total_returned: number;
  agebs: AgebFarmaciaOpportunityRow[];
}

// ---------------------------------------------------------------------------
// Generic opportunity engine (v0.2.5 — agnostic vertical targeting)
//
// v0.2.4 hard-coded `clase_actividad_id IN ('464111','464112')` for farmacias.
// v0.2.5 generalizes by accepting comma-separated SCIAN codes at any level
// (2/3/4/5/6 digits) and dispatching to the matching `*_actividad_id` column.
// All codes within a single request must share the same length — mixing
// `46,461` rejects at the handler boundary.
// ---------------------------------------------------------------------------

/**
 * Single SCIAN code: 2-6 digits. Used per-element after the comma split.
 * The `target_scian` parameter as a whole is validated by length-uniformity
 * + per-element length in `parseTargetScian()`. We don't combine into a
 * single regex because the same-length constraint is easier to express in
 * code than in regex.
 */
export const SCIAN_CODE_RE = /^\d{2,6}$/;

/** Comma-separated raw param shape — each component validated separately. */
export const TARGET_SCIAN_LIST_RE = /^\d{2,6}(,\d{2,6})*$/;

/** Max number of SCIAN codes accepted in a single `target_scian` param. */
export const TARGET_SCIAN_MAX_CODES = 10;

/** Default + cap for /analytics/opportunity-by-ageb. */
export const OPPORTUNITY_AGEB_DEFAULT_LIMIT = 20;
export const OPPORTUNITY_AGEB_MAX_LIMIT = 100;

/** Default + cap for /analytics/opportunity-by-colonia. */
export const OPPORTUNITY_COLONIA_DEFAULT_LIMIT = 50;
export const OPPORTUNITY_COLONIA_MAX_LIMIT = 200;

/** Default + cap for /analytics/colonias-by-municipio. */
export const COLONIAS_DEFAULT_LIMIT = 50;
export const COLONIAS_MAX_LIMIT = 200;

/** SCIAN level labels — matches `establecimientos.{sector,subsector,rama,subrama,clase}_actividad_id`. */
export type ScianLevel = "sector" | "subsector" | "rama" | "subrama" | "clase";

/** order_by for /analytics/opportunity-by-ageb. */
export const OPPORTUNITY_AGEB_ORDER_BY = [
  "score",
  "pobtot",
  "target_count",
  "total_estab",
] as const;
export type OpportunityAgebOrderBy = (typeof OPPORTUNITY_AGEB_ORDER_BY)[number];

/** order_by for /analytics/opportunity-by-colonia. */
export const OPPORTUNITY_COLONIA_ORDER_BY = [
  "score",
  "target_count",
  "total_estab",
  "colonia",
] as const;
export type OpportunityColoniaOrderBy =
  (typeof OPPORTUNITY_COLONIA_ORDER_BY)[number];

/** order_by for /analytics/colonias-by-municipio. */
export const COLONIAS_ORDER_BY = ["num_establecimientos", "colonia"] as const;
export type ColoniasOrderBy = (typeof COLONIAS_ORDER_BY)[number];

export interface OpportunityByAgebRow {
  cvegeo: string;
  ambito: "Urbana" | "Rural" | null;
  centroid_lat: number | null;
  centroid_lon: number | null;
  area_km2: number | null;
  /** AGEB population from censo_ageb urbana 2020. null for rural AGEBs. */
  pobtot: number | null;
  /** Count of establecimientos in this AGEB matching the requested SCIAN target. */
  target_count: number;
  /** Total establecimientos in this AGEB (foot-traffic / market-activity proxy). */
  total_estab: number;
  /**
   * Population per existing target competitor: `pobtot / NULLIF(target_count, 0)`.
   * Higher = more underserved. NULL when pobtot is null/0 OR target_count is 0
   * (greenfield AGEB — no existing competition; sort by `pobtot` to find these).
   */
  score: number | null;
  /**
   * CONEVAL Grado de Rezago Social per AGEB (v0.2.6 addition). null when the
   * AGEB is not in CONEVAL GRS_AGEB_urbana_2020 (rural / post-2020 / orphan).
   * Returned in every row regardless of whether the `rezago_grado` query
   * filter was applied — operator sees the rezago context inline.
   */
  rezago_grado: RezagoGrado | null;
  /**
   * v0.2.7: % of AGEB population WITHOUT institutional derechohabiencia
   * (= psinder / pobtot × 100). Strict reading — does NOT add `pafil_ipriv`
   * (privately-insured). Use as a baseline coverage gap; combine with
   * `census.pafil_ipriv` if you want the wider "private-pharma-dependent"
   * estimate. NULL when pobtot is null/0 or psinder is null. Drawn from
   * Censo 2020 derechohabiencia at AGEB granularity.
   */
  pct_sin_cobertura_salud: number | null;
  /**
   * v0.2.7: avg monthly active DM2 cases at the **municipio** level (not
   * AGEB — SINBA reports by CLUES + muni). Same value broadcasts to every
   * AGEB inside the muni; treat as a muni-scale demand multiplier rather
   * than an AGEB-discriminating feature. NULL when SINBA didn't report
   * the muni in 2023 (~265 munis missing, mostly tiny rural).
   */
  casos_dm2_muni: number | null;
  /** v0.2.7: avg monthly active HTA cases at muni level. Same caveats as casos_dm2_muni. */
  casos_hta_muni: number | null;
  /** v0.2.7: avg monthly active obesidad cases at muni level. */
  casos_obesidad_muni: number | null;
}

export interface OpportunityByAgebResult {
  cve_mun: string;
  scian_level: ScianLevel;
  target_scian: string[];
  order_by: OpportunityAgebOrderBy;
  /**
   * If the request applied a `rezago_grado` filter, the parsed list. Empty
   * array when no filter was applied (= no constraint, all AGEBs eligible).
   * v0.2.6 addition.
   */
  rezago_grado_filter: RezagoGrado[];
  total_returned: number;
  agebs: OpportunityByAgebRow[];
}

export interface OpportunityByColoniaRow {
  colonia: string;
  /** Count of establecimientos in this colonia matching the SCIAN target. */
  target_count: number;
  /** Total establecimientos in this colonia. */
  total_estab: number;
  /**
   * Activity-per-target proxy: `total_estab / NULLIF(target_count, 0)`.
   * Higher = more market activity per existing target competitor. NULL when
   * target_count is 0 (greenfield colonia — sort by `total_estab` to surface).
   * Less robust than AGEB-level score because there's no population denominator.
   */
  score: number | null;
}

export interface OpportunityByColoniaResult {
  cve_mun: string;
  scian_level: ScianLevel;
  target_scian: string[];
  order_by: OpportunityColoniaOrderBy;
  total_returned: number;
  colonias: OpportunityByColoniaRow[];
}

export interface ColoniasByMunicipioRow {
  colonia: string;
  num_establecimientos: number;
}

export interface ColoniasByMunicipioResult {
  cve_mun: string;
  order_by: ColoniasOrderBy;
  total_returned: number;
  colonias: ColoniasByMunicipioRow[];
}

// ---------------------------------------------------------------------------
// COFEPRIS licensed pharmacies (v0.2.8 — 2026-05-05)
//
// Per-pharmacy table loaded from the COFEPRIS Padrón de Licencias Sanitarias
// PDF (2,381 rows, 2,195 Vigente). 92.3% geocoded to AGEB via DENUE join on
// (cve_ent, cp, colonia). The flag fields encode whether each license
// authorizes that controlados class.
//
// Why this matters: DENUE knows there's a farmacia at the address; only
// COFEPRIS knows what kind. Estupefacientes/Psicotrópicos/Vacunas/
// Hemoderivados are the highest-margin SKUs in the entire pharma OTC
// universe. This is the licensure floor for site-selection of any
// higher-margin pharma network.
// ---------------------------------------------------------------------------

export interface LicensedPharmaciesByMunicipioResult {
  cve_mun: string;
  total_licenciadas: number;
  con_estupefacientes: number;
  con_psicotropicos: number;
  con_vacunas: number;
  con_toxoides: number;
  con_sueros_antitoxinas: number;
  con_hemoderivados: number;
  hospitalarias: number;
  boticas: number;
  droguerias: number;
}

export interface LicensedPharmaciesByAgebResult {
  cvegeo: string;
  total_licenciadas: number;
  /**
   * Subset authorized for any controlados class (Estupefacientes, Psicotrópicos
   * II/III, Vacunas, or Hemoderivados). Excludes Toxoides + Sueros + Antitoxinas
   * which are largely co-licensed with Vacunas anyway and would inflate this
   * count via double-counting. The single bundled flag is more decision-useful
   * at AGEB granularity than 6 separate per-class counts on a small base.
   */
  con_controlados: number;
}

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

/**
 * Z/X/Y bounds. Hard-clamped at the handler boundary so SQL composition
 * cannot receive a Z above 22 or negative X/Y.
 */
export const MAX_TILE_ZOOM = 22;
/** Soft cap on features per tile to protect the browser. Sample at SQL. */
export const TILE_FEATURE_CAP = 50_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ApiError {
  error: string;
  code: string;
  details?: unknown;
}
