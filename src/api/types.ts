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
