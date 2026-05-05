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
 * Default "current year" for risk-summary comparisons. 2026 is partial (only
 * Q1 reported as of the loader run on 2026-05-05) so the rolling baseline
 * prefers the latest full year.
 *
 * TODO (audit W5, 2026-05-05): bump to 2026 once the operator confirms 2026
 * has at least Q3 reported (~Oct 2026), and to 2027 once that year closes.
 * Long-term: derive from `MAX(ano) FROM mv_delitos_municipal_yearly WHERE
 * ano <= EXTRACT(YEAR FROM NOW())` once at server start so this stops being
 * a redeploy-coupled constant.
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
