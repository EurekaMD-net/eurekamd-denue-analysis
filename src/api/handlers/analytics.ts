/**
 * GET /analytics/* — joined DENUE × Censo 2020 × CONEVAL × CLUES × SESNSP
 * queries powering the Locust-mode dashboard (v0.3 P2) plus the risk
 * surface (v0.2.2 SESNSP, 2026-05-05).
 *
 * Six endpoints. All shell to docker exec psql for the joins because
 * PostgREST cannot express GROUP BY across views nor LEFT JOIN to a
 * different table. Same pattern as src/analysis/cluster-by-sector.ts.
 *
 *   GET /analytics/national-treemap
 *     32 rows (one per entidad): establecimientos count + modal IRS grade
 *     + population-weighted average pobreza %.
 *
 *   GET /analytics/sector-grade-matrix
 *     ≤95 cells (19 SCIAN sectors × 5 IRS grades + sin_dato): count of
 *     establishments by sector × IRS grade of their municipio.
 *
 *   GET /analytics/municipios?entidad=XX
 *     ~80-200 rows (one per municipio in the requested entidad):
 *     establecimientos count, farmacias subtotal, CLUES count, poblacion,
 *     pobreza_pct, IRS índice + grado.
 *
 *   GET /analytics/top-sectors?entidad=XX[&limit=N]
 *     Top SCIAN sectors by establishment count for one entidad.
 *
 *   GET /analytics/risk-summary?entidad=XX[&ano=YYYY&baseline_ano=YYYY]
 *     Per-municipio SESNSP profile: total_delitos + robo_negocio +
 *     homicidio_doloso + extorsion + delitos_per_1k_pop + change vs
 *     baseline. Mat-view-first (mv_delitos_municipal_yearly) with live
 *     fallback to sesnsp_delitos_municipal aggregation.
 *
 *   GET /analytics/risk-trend?cve_mun=NNNNN
 *     Monthly SESNSP time series (~140 points 2015-01..2026-08) for one
 *     municipio. Reads sesnsp_delitos_municipal directly via cve_mun btree.
 *
 * Caching: national queries are extremely static (max-age=3600 = 1 hour).
 * Per-entidad query is lightly more dynamic (max-age=300 = 5 min) since
 * a re-run of the DENUE pipeline could shift counts. risk-summary uses
 * max-age=300 to bound staleness when the operator forgets to refresh
 * mv_delitos_municipal_yearly after a SESNSP loader rerun (audit M2).
 *
 * SQL values are INLINED into the query text (no bind parameters): every
 * request-derived value must first pass an anchored regex or an allowlist
 * at the handler boundary (ENTIDAD_RE, CVE_MUN_RE, RISK_ANO_RE, the
 * *_ORDER_BY allowlists, ...) before the SQL ever sees it. Queries run
 * through the shared psql runner (src/api/db/psql-runner.ts) in a
 * read-only session.
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import { runJson, runJsonSync } from "../db/psql-runner.js";
import {
  AGEB_DETAIL_CLUES_CAP,
  AGEB_FARMACIA_DEFAULT_LIMIT,
  AGEB_FARMACIA_MAX_LIMIT,
  AGEBS_DEFAULT_LIMIT,
  AGEBS_MAX_LIMIT,
  AGEBS_ORDER_BY,
  COLONIAS_DEFAULT_LIMIT,
  COLONIAS_MAX_LIMIT,
  COLONIAS_ORDER_BY,
  CVE_LOC_RE,
  CVE_MUN_RE,
  CVEGEO_RE,
  ENTIDAD_RE,
  isRezagoGrado,
  MORTALITY_DEFAULT_CURRENT_ANO,
  OPPORTUNITY_AGEB_DEFAULT_LIMIT,
  OPPORTUNITY_AGEB_MAX_LIMIT,
  OPPORTUNITY_AGEB_ORDER_BY,
  OPPORTUNITY_COLONIA_DEFAULT_LIMIT,
  OPPORTUNITY_COLONIA_MAX_LIMIT,
  OPPORTUNITY_COLONIA_ORDER_BY,
  REZAGO_GRADOS,
  RISK_ANO_RE,
  RISK_DEFAULT_BASELINE_ANO,
  RISK_DEFAULT_CURRENT_ANO,
  SCIAN_CODE_RE,
  TARGET_SCIAN_LIST_RE,
  TARGET_SCIAN_MAX_CODES,
  type AgebDetailResult,
  type AgebFarmaciaOpportunityResult,
  type AgebsByMunicipioResult,
  type AgebsOrderBy,
  type ApiServerConfig,
  type ColoniasByMunicipioResult,
  type ColoniasOrderBy,
  type IrsGrado,
  type LicensedPharmaciesByAgebResult,
  type LicensedPharmaciesByMunicipioResult,
  type ResolveAgebResult,
  type ColoniasByAgebResult,
  type DatosVialesResult,
  type EntidadDetailResult,
  type InclusionFinancieraResult,
  type ViviendaCreditoComercialResult,
  type ViviendaFinanciamientosResult,
  type LocalitiesByMunicipioResult,
  type LocalitiesOrderBy,
  type LocalityDetailResult,
  type MunicipioDetailResult,
  LOCALITIES_ORDER_BY,
  type AirportInMunicipio,
  type AirportsByMunicipioResult,
  type ManzanasByAgebResult,
  type ManzanasOrderBy,
  COLONIAS_BY_AGEB_DEFAULT_LIMIT,
  COLONIAS_BY_AGEB_MAX_LIMIT,
  MANZANAS_DEFAULT_LIMIT,
  MANZANAS_MAX_LIMIT,
  MANZANAS_ORDER_BY,
  type MortalitySummaryResult,
  type MortalityTrendResult,
  type MunicipiosAnalyticsResult,
  type NationalTreemapResult,
  type OpportunityAgebOrderBy,
  type OpportunityByAgebResult,
  type OpportunityByColoniaResult,
  type OpportunityColoniaOrderBy,
  type RezagoGrado,
  type RiskSummaryResult,
  type RiskTrendResult,
  type ScianLevel,
  type LocustAgebResult,
  type LocustEstadoResult,
  type LocustMuniResult,
  type SectorGradeMatrixResult,
  type StateCalibratorsResult,
  type StateCalibratorsRow,
  type TopSectorsResult,
} from "../types.js";
import { ESTADOS, type EstadoClave } from "../../extractor/types.js";
import { loadScianNames } from "./sectors.js";

const VALID_GRADOS: ReadonlySet<string> = new Set([
  "Muy bajo",
  "Bajo",
  "Medio",
  "Alto",
  "Muy alto",
  "sin_dato",
]);

function normalizeGrado(g: string | null | undefined): IrsGrado {
  if (g && VALID_GRADOS.has(g)) return g as IrsGrado;
  return "sin_dato";
}

// SCIAN clases for pharmacies: 464111 (sin minisúper), 464112 (con
// minisúper). One list for every farmacia count so municipios, AGEB and
// Locust endpoints cannot drift apart again (audit #57/#66: two sites used
// LIKE '4659%', which is pets/gifts/religious goods, not pharmacies).
const FARMACIA_CLASES = ["464111", "464112"] as const;
const FARMACIA_CLASES_SQL = FARMACIA_CLASES.map((c) => `'${c}'`).join(",");

/**
 * `ageb` range predicate for AGEBs of one municipio (AGEB keys start with
 * the 5-char cve_mun). A btree range can use idx_establecimientos_ageb;
 * `LIKE 'X%'` cannot under the en_US collation. Keys are alphanumeric, so
 * the range is exactly the prefix. cveMun pre-validated by CVE_MUN_RE.
 */
function agebOfMunicipioSql(cveMun: string): string {
  const next = String(Number(cveMun) + 1).padStart(5, "0");
  return `ageb >= '${cveMun}' AND ageb < '${next}'`;
}

/**
 * `cve_mun` range predicate for the municipios of one entidad (audit #134).
 * `LEFT(col, 2) = 'NN'` cannot use a btree on the column; the half-open
 * range selects the same 5-digit keys and can. entidad pre-validated by
 * ENTIDAD_RE (01-32), so the upper bound is at most '33'.
 */
function entidadCveMunRangeSql(column: string, entidad: string): string {
  const next = String(Number(entidad) + 1).padStart(2, "0");
  return `${column} >= '${entidad}' AND ${column} < '${next}'`;
}

/**
 * Wrap a one-cell `SELECT json_...;` statement as a scalar subquery so
 * several of them fold into one `json_build_object(...)` round-trip
 * (audit #103: one psql spawn + one PG backend per request, not 2-8).
 */
function scalarSubquery(sql: string): string {
  return `(${sql.trim().replace(/;$/, "")})`;
}

// Audit #140: SINBA morbidity is read from its mat-view (unique on
// (cve_mun, anio)); the view re-aggregates ~141k raw rows with regex
// filters per call (~200 ms). The view stays as the relation-missing
// fallback: load-sinba.ts drops sinba_ec_raw CASCADE, which takes the MV
// with it until scripts/migrations/018-mv-sinba-morbidity.sql is re-run.
const SINBA_MORBIDITY_MV = "mv_sinba_morbidity_municipal";
const SINBA_MORBIDITY_VIEW = "sinba_morbidity_municipal";
type SinbaMorbidityRel =
  typeof SINBA_MORBIDITY_MV | typeof SINBA_MORBIDITY_VIEW;

/**
 * Detect whether a postgres error is the "relation does not exist"
 * fingerprint (psql code 42P01). Used by analytics handlers to fall
 * back from a missing mat-view to the live aggregation. We test the
 * combined message+stderr so it works regardless of which path the
 * error text arrived through (message, or the raw `stderr` field).
 *
 * Audit hardening note: this is a substring check, not a code match —
 * but the psql runner already wraps the throw in HttpError("postgres.error")
 * (raw stderr on its `stderr` field) so this helper only sees
 * postgres-origin errors. Safe.
 */
export function isRelationMissingError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const msg = err instanceof Error ? err.message : String(err);
  // Guard .stderr lookup so primitive throws (string, number) don't
  // throw "Cannot read properties of undefined".
  const stderrField =
    typeof err === "object" ? (err as { stderr?: unknown }).stderr : undefined;
  const stderr =
    typeof stderrField === "string"
      ? stderrField
      : stderrField instanceof Buffer
        ? stderrField.toString("utf-8")
        : "";
  const haystack = `${msg}\n${stderr}`;
  // psql may emit `relation "X" does not exist` (quoted name) OR rarely
  // `relation does not exist` (schema-stripped). Allow zero chars between.
  return /relation\b.*does not exist/i.test(haystack) || /42P01/.test(haystack);
}

/**
 * Mat-view-first read with graceful fallback to live aggregation.
 *
 * Tries the (typically 100ms) materialized-view SELECT. If the mat-view
 * is missing (e.g., not yet refreshed after a schema reset), falls back
 * to the live multi-CTE aggregation. Real postgres errors (timeout,
 * permission, syntax) propagate as 502 unchanged.
 *
 * Audit P3-perf (2026-05-04): mv_sector_grade_matrix turns 13.7s scans
 * into 91ms reads; mv_national_treemap takes 1.15s → 88ms. The fallback
 * keeps the handlers working on a fresh DB before the operator runs the
 * mat-view bootstrap.
 */
export async function runJsonQueryMvFirst<T>(
  config: ApiServerConfig,
  mvSql: string,
  liveSql: string,
): Promise<T> {
  try {
    return await runJson<T>(mvSql, { container: config.dbContainer });
  } catch (err) {
    if (isRelationMissingError(err)) {
      return await runJson<T>(liveSql, { container: config.dbContainer });
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// resolveCurrentRiskAno — runtime resolver for the "latest fully-reported
// year" used as the default `ano` in /analytics/risk-summary. Audit W5
// long-term fix (2026-05-05): replaces the redeploy-coupled
// `RISK_DEFAULT_CURRENT_ANO` constant with a value pulled from the data
// at server start, so the rollover happens automatically when the
// December load of next year lands.
//
// Strategy: query the live SESNSP table for the max year that has all
// 12 months reported. The mat-view drops the `mes` column, so the
// resolver bypasses it — this query runs once per process and is bounded
// (~3ms with the cve_mun+ano btree). On any failure (DB unreachable,
// table missing, malformed output, no fully-reported year exists) the
// resolver falls back to the static constant `RISK_DEFAULT_CURRENT_ANO`,
// so the service still starts and risk-summary still serves.
//
// "Fully reported" = 12 distinct months across all municipios for
// that year. Partial years (e.g. 2026 with only Q1 reported) intentionally
// do NOT win — comparing partial 2026 vs full 2020 baseline produces
// misleading change percentages. Operator can still pass `?ano=2026`
// explicitly when they want partial-year data.
//
// Audit #133: GROUP BY ano + COUNT(DISTINCT mes) walked all 31.6M index
// entries and spilled ~665 MB to temp (10.7 s, gating listen() at boot).
// The recursive CTE below is a loose index scan on
// idx_sesnsp_delitos_municipal_ano_mes: it visits each distinct (ano, mes)
// pair once (~150 index probes, ~2-4 ms), then counts months per year.
// ---------------------------------------------------------------------------

const CURRENT_RISK_ANO_LIVE_SQL = `
WITH RECURSIVE am(ano, mes) AS (
  (SELECT ano, mes FROM sesnsp_delitos_municipal ORDER BY ano, mes LIMIT 1)
  UNION ALL
  SELECT n.ano, n.mes
  FROM am, LATERAL (
    SELECT s.ano, s.mes
    FROM sesnsp_delitos_municipal s
    WHERE (s.ano, s.mes) > (am.ano, am.mes)
    ORDER BY s.ano, s.mes
    LIMIT 1
  ) n
)
SELECT json_build_array(MAX(ano)) FROM (
  SELECT ano
  FROM am
  WHERE ano <= EXTRACT(YEAR FROM NOW())::int
  GROUP BY ano
  HAVING COUNT(*) = 12
) t;
`;

/**
 * Resolve the "latest fully-reported year" for risk-summary defaults.
 * Synchronous (boot-time only) — uses the runner's runJsonSync. Always
 * returns a valid 4-digit year in `RISK_ANO_RE` range; never throws.
 *
 * Returns a discriminated result so the caller can log honestly: when
 * the data and the static constant happen to coincide, the boot log
 * still reflects which path produced the value.
 *
 * Caller (typically `scripts/serve.ts` at startup) stores `.ano` on
 * `ApiServerConfig.currentRiskAno`. Handlers read that field with a
 * fallback to `RISK_DEFAULT_CURRENT_ANO`, so a missed startup resolve
 * (DB unavailable at boot) degrades gracefully to the static value rather
 * than serving 502s on every risk-summary request.
 */
export function resolveCurrentRiskAno(config: ApiServerConfig): {
  ano: number;
  source: "data" | "fallback";
} {
  const fromLive = tryResolveAno(config, CURRENT_RISK_ANO_LIVE_SQL);
  if (fromLive !== null) return { ano: fromLive, source: "data" };
  return { ano: RISK_DEFAULT_CURRENT_ANO, source: "fallback" };
}

function tryResolveAno(config: ApiServerConfig, sql: string): number | null {
  let raw: number[] | null;
  try {
    raw = runJsonSync<number[] | null>(sql, { container: config.dbContainer });
  } catch {
    // Caller decides whether to try the next source or fall through to the
    // hardcoded constant — neither outcome should escalate to a thrown error.
    return null;
  }
  const first = Array.isArray(raw) ? raw[0] : null;
  if (typeof first !== "number") return null;
  // Defense: never accept a year outside the regex bounds even if the data
  // table somehow has a corrupt value. RISK_ANO_RE allows 2010-2039.
  if (!Number.isInteger(first) || first < 2010 || first > 2039) return null;
  return first;
}

// ---------------------------------------------------------------------------
// /analytics/national-treemap
// ---------------------------------------------------------------------------

/** Mat-view read (~88ms). Falls back to NATIONAL_TREEMAP_SQL if absent. */
const NATIONAL_TREEMAP_MV_SQL = `
SELECT json_agg(row_to_json(t) ORDER BY t.entidad) FROM (
  SELECT entidad, establecimientos, modal_irs_grado, pobreza_pct_promedio
  FROM mv_national_treemap
) t;
`;

const NATIONAL_TREEMAP_SQL = `
WITH entidad_counts AS (
  SELECT entidad, COUNT(*)::bigint AS establecimientos
  FROM establecimientos
  WHERE entidad ~ '^(0[1-9]|[12][0-9]|3[0-2])$'
  GROUP BY entidad
),
entidad_irs AS (
  SELECT
    LEFT(cve_mun, 2) AS entidad,
    irs_grado,
    COUNT(*)::int AS muns_with_grade,
    ROW_NUMBER() OVER (
      PARTITION BY LEFT(cve_mun, 2)
      ORDER BY COUNT(*) DESC, SUM(pob_total) DESC, irs_grado
    ) AS rn
  FROM coneval_irs_municipal
  WHERE irs_grado IS NOT NULL
  GROUP BY 1, 2
),
entidad_pobreza AS (
  SELECT
    LEFT(cve_mun, 2) AS entidad,
    ROUND(
      SUM(pobreza_pct * COALESCE(poblacion, 0))::numeric
      / NULLIF(SUM(COALESCE(poblacion, 0)), 0),
      2
    ) AS pobreza_pct_promedio
  FROM coneval_pobreza_municipal
  GROUP BY 1
)
SELECT json_agg(row_to_json(t) ORDER BY t.entidad) FROM (
  SELECT
    ec.entidad,
    ec.establecimientos,
    ei.irs_grado AS modal_irs_grado,
    ep.pobreza_pct_promedio
  FROM entidad_counts ec
  LEFT JOIN entidad_irs ei ON ei.entidad = ec.entidad AND ei.rn = 1
  LEFT JOIN entidad_pobreza ep ON ep.entidad = ec.entidad
) t;
`;

interface RawNationalRow {
  entidad: string;
  establecimientos: number | string;
  modal_irs_grado: string | null;
  pobreza_pct_promedio: number | string | null;
}

export async function nationalTreemapHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const rows = await runJsonQueryMvFirst<RawNationalRow[]>(
    config,
    NATIONAL_TREEMAP_MV_SQL,
    NATIONAL_TREEMAP_SQL,
  );
  const result: NationalTreemapResult = {
    entidades: rows.map((r) => ({
      entidad: r.entidad,
      nombre: ESTADOS[r.entidad as EstadoClave] ?? "(desconocido)",
      establecimientos: Number(r.establecimientos),
      modal_irs_grado: normalizeGrado(r.modal_irs_grado),
      pobreza_pct_promedio:
        r.pobreza_pct_promedio === null ? null : Number(r.pobreza_pct_promedio),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/sector-grade-matrix
// ---------------------------------------------------------------------------

/** Mat-view read (~91ms). Falls back to SECTOR_GRADE_MATRIX_SQL if absent. */
const SECTOR_GRADE_MATRIX_MV_SQL = `
SELECT json_agg(row_to_json(t) ORDER BY t.scian, t.irs_grado) FROM (
  SELECT scian, irs_grado, count FROM mv_sector_grade_matrix
) t;
`;

const SECTOR_GRADE_MATRIX_SQL = `
SELECT json_agg(row_to_json(t) ORDER BY t.scian, t.irs_grado) FROM (
  SELECT
    e.sector_actividad_id AS scian,
    COALESCE(i.irs_grado, 'sin_dato') AS irs_grado,
    COUNT(*)::bigint AS count
  FROM establecimientos e
  LEFT JOIN coneval_irs_municipal i ON i.cve_mun = e.area_geo
  WHERE e.sector_actividad_id IS NOT NULL
  GROUP BY 1, 2
) t;
`;

interface RawMatrixCell {
  scian: string;
  irs_grado: string;
  count: number | string;
}

export async function sectorGradeMatrixHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const rows = await runJsonQueryMvFirst<RawMatrixCell[]>(
    config,
    SECTOR_GRADE_MATRIX_MV_SQL,
    SECTOR_GRADE_MATRIX_SQL,
  );
  const result: SectorGradeMatrixResult = {
    cells: rows.map((r) => ({
      scian: r.scian,
      irs_grado: normalizeGrado(r.irs_grado),
      count: Number(r.count),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/municipios?entidad=XX
// ---------------------------------------------------------------------------

interface RawMunicipioRow {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | string | null;
  establecimientos: number | string;
  farmacias: number | string;
  unidades_clues: number | string;
  pobreza_pct: number | string | null;
  irs_grado: string | null;
  irs_indice: number | string | null;
}

function municipiosSql(entidad: string): string {
  // Caller has already gated entidad through ENTIDAD_RE — we still inline
  // it here as a literal because psql -c cannot bind params from the CLI.
  // The regex restricts to /^(0[1-9]|[12][0-9]|3[0-2])$/ (5-char output
  // when concatenated, never longer; never contains quotes).
  return `
WITH e_counts AS (
  SELECT
    area_geo AS cve_mun,
    COUNT(*)::bigint AS establecimientos,
    COUNT(*) FILTER (WHERE clase_actividad_id IN (${FARMACIA_CLASES_SQL}))::bigint AS farmacias
  FROM establecimientos
  WHERE entidad = '${entidad}' AND area_geo IS NOT NULL
  GROUP BY area_geo
),
clues_counts AS (
  SELECT cve_mun, COUNT(*)::bigint AS unidades_clues
  FROM clues
  WHERE ${entidadCveMunRangeSql("cve_mun", entidad)}
  GROUP BY cve_mun
)
SELECT json_agg(row_to_json(t) ORDER BY t.establecimientos DESC) FROM (
  SELECT
    e.cve_mun,
    cm.nom_mun AS municipio,
    cm.pobtot AS poblacion,
    e.establecimientos,
    e.farmacias,
    COALESCE(cc.unidades_clues, 0) AS unidades_clues,
    p.pobreza_pct,
    i.irs_grado,
    i.irs_indice
  FROM e_counts e
  LEFT JOIN municipios_2025 cm ON cm.cve_mun = e.cve_mun
  LEFT JOIN clues_counts cc ON cc.cve_mun = e.cve_mun
  LEFT JOIN coneval_pobreza_municipal p ON p.cve_mun = e.cve_mun
  LEFT JOIN coneval_irs_municipal i ON i.cve_mun = e.cve_mun
) t;
`;
}

export async function municipiosAnalyticsHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const entidad = c.req.query("entidad");
  if (!entidad || !ENTIDAD_RE.test(entidad)) {
    throw new HttpError(
      `entidad inválida "${entidad ?? ""}"`,
      400,
      "validation.entidad",
    );
  }
  const rows = await runJson<RawMunicipioRow[]>(municipiosSql(entidad), {
    container: config.dbContainer,
  });
  const result: MunicipiosAnalyticsResult = {
    entidad,
    municipios: rows.map((r) => ({
      cve_mun: r.cve_mun,
      municipio: r.municipio,
      poblacion: r.poblacion === null ? null : Number(r.poblacion),
      establecimientos: Number(r.establecimientos),
      farmacias: Number(r.farmacias),
      unidades_clues: Number(r.unidades_clues),
      pobreza_pct: r.pobreza_pct === null ? null : Number(r.pobreza_pct),
      irs_grado: r.irs_grado ? normalizeGrado(r.irs_grado) : null,
      irs_indice: r.irs_indice === null ? null : Number(r.irs_indice),
    })),
  };
  c.header("Cache-Control", "private, max-age=300");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/top-sectors?entidad=XX&limit=10
//
// Bypasses the never-applied mv_sector_summary mat-view by aggregating
// directly via the indexed sector_actividad_id column. Cheap because the
// btree on (entidad, sector_actividad_id) makes this an index-only scan.
// ---------------------------------------------------------------------------

const TOP_SECTORS_DEFAULT = 10;
const TOP_SECTORS_MAX = 25;

function topSectorsSql(entidad: string, limit: number): string {
  return `
SELECT json_agg(row_to_json(t) ORDER BY t.count DESC) FROM (
  SELECT
    sector_actividad_id AS scian,
    COUNT(*)::bigint AS count
  FROM establecimientos
  WHERE entidad = '${entidad}' AND sector_actividad_id IS NOT NULL
  GROUP BY sector_actividad_id
  ORDER BY 2 DESC
  LIMIT ${limit}
) t;
`;
}

interface RawTopSectorRow {
  scian: string;
  count: number | string;
}

export async function topSectorsByEntidadHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const entidad = c.req.query("entidad");
  if (!entidad || !ENTIDAD_RE.test(entidad)) {
    throw new HttpError(
      `entidad inválida "${entidad ?? ""}"`,
      400,
      "validation.entidad",
    );
  }
  const limit = parseLimit(
    c.req.query("limit"),
    TOP_SECTORS_DEFAULT,
    TOP_SECTORS_MAX,
  );

  const rows = await runJson<RawTopSectorRow[]>(topSectorsSql(entidad, limit), {
    container: config.dbContainer,
  });
  const names = loadScianNames();
  const result: TopSectorsResult = {
    entidad,
    sectors: rows.map((r) => ({
      scian: r.scian,
      name: names.sectors[r.scian] ?? `(SCIAN ${r.scian} — sin etiqueta)`,
      count: Number(r.count),
    })),
  };
  c.header("Cache-Control", "private, max-age=300");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/risk-summary?entidad=NN[&ano=YYYY&baseline_ano=YYYY]
//
// Per-municipio risk profile for one state. Reads mv_delitos_municipal_yearly
// (~28k rows total, ~50-500 rows per state) joined to municipios_2025 for
// name + population normalization (the 9 post-2020 municipios get their
// name; population, and so the per-1k rate, stays NULL). Returns one row per municipio with current-year
// totals across high-signal subtipos plus a percent-change vs `baseline_ano`.
//
// Defaults anchor to the latest fully-reported year in the data (2025) to
// avoid the 2026 partial-quarter trap. Operator can override with `?ano=`
// once SESNSP closes another year.
// ---------------------------------------------------------------------------

interface RawRiskSummaryRow {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | string | null;
  total_delitos: number | string;
  robo_negocio: number | string;
  homicidio_doloso: number | string;
  extorsion: number | string;
  patrimoniales: number | string;
  violentos: number | string;
  total_baseline: number | string | null;
  delitos_per_1k_pop: number | string | null;
  delitos_change_pct: number | string | null;
}

function riskSummaryMvSql(
  entidad: string,
  currentAno: number,
  baselineAno: number,
): string {
  // entidad pre-validated by ENTIDAD_RE; ano values pre-validated by RISK_ANO_RE.
  // We inline them as integer literals (no quotes) since psql -c can't bind.
  return `
WITH cur AS (
  SELECT cve_mun, robo_negocio, homicidio_doloso, extorsion,
         patrimoniales, violentos, total_delitos
  FROM mv_delitos_municipal_yearly
  WHERE ${entidadCveMunRangeSql("cve_mun", entidad)} AND ano = ${currentAno}
    -- Audit C1-coherence round-1 closure 2026-05-10: SESNSP publishes
    -- catch-all rows where MUN3 = '998' (federal-grain) or '999'
    -- (state-grain "no especificado"). They have no municipios_2025
    -- match and surface as ghost rows with municipio=null but non-null
    -- delito counts. Filter them out at the CTE.
    AND cve_mun !~ '99[89]$'
),
baseline AS (
  SELECT cve_mun, total_delitos AS total_baseline
  FROM mv_delitos_municipal_yearly
  WHERE ${entidadCveMunRangeSql("cve_mun", entidad)} AND ano = ${baselineAno}
    AND cve_mun !~ '99[89]$'
)
SELECT json_agg(row_to_json(t) ORDER BY t.total_delitos DESC NULLS LAST) FROM (
  SELECT
    cur.cve_mun,
    cm.nom_mun                                         AS municipio,
    cm.pobtot                                          AS poblacion,
    cur.total_delitos,
    cur.robo_negocio,
    cur.homicidio_doloso,
    cur.extorsion,
    cur.patrimoniales,
    cur.violentos,
    b.total_baseline,
    CASE WHEN COALESCE(cm.pobtot, 0) > 0
      THEN ROUND(cur.total_delitos::numeric * 1000.0 / cm.pobtot, 2)
      ELSE NULL
    END                                                AS delitos_per_1k_pop,
    CASE WHEN COALESCE(b.total_baseline, 0) > 0
      THEN ROUND(
        ((cur.total_delitos - b.total_baseline)::numeric / b.total_baseline) * 100.0,
        1
      )
      ELSE NULL
    END                                                AS delitos_change_pct
  FROM cur
  LEFT JOIN baseline b USING (cve_mun)
  LEFT JOIN municipios_2025 cm USING (cve_mun)
) t;
`;
}

/**
 * Live-aggregation fallback for risk-summary. Same shape as the mat-view
 * read but does the FILTER aggregation directly against the 31.6M-row
 * sesnsp_delitos_municipal table. Slower (~2-5s per state) but keeps the
 * endpoint working on a freshly-bootstrapped DB before the operator runs
 * `scripts/perf-matviews.sql`. Audit M1 (2026-05-05).
 */
function riskSummaryLiveSql(
  entidad: string,
  currentAno: number,
  baselineAno: number,
): string {
  return `
WITH cur AS (
  SELECT
    cve_mun,
    COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Robo a negocio'), 0)::bigint AS robo_negocio,
    COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Homicidio doloso'), 0)::bigint AS homicidio_doloso,
    COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Extorsión'), 0)::bigint AS extorsion,
    COALESCE(SUM(count) FILTER (WHERE bien_juridico = 'El patrimonio'), 0)::bigint AS patrimoniales,
    COALESCE(SUM(count) FILTER (WHERE bien_juridico = 'La vida y la Integridad corporal'), 0)::bigint AS violentos,
    SUM(count)::bigint AS total_delitos
  FROM sesnsp_delitos_municipal
  WHERE ${entidadCveMunRangeSql("cve_mun", entidad)} AND ano = ${currentAno}
    -- Audit C1-coherence round-1 closure 2026-05-10: same catch-all
    -- filter as the MV path. See riskSummaryMvSql for details.
    AND cve_mun !~ '99[89]$'
  GROUP BY cve_mun
),
baseline AS (
  SELECT cve_mun, SUM(count)::bigint AS total_baseline
  FROM sesnsp_delitos_municipal
  WHERE ${entidadCveMunRangeSql("cve_mun", entidad)} AND ano = ${baselineAno}
    AND cve_mun !~ '99[89]$'
  GROUP BY cve_mun
)
SELECT json_agg(row_to_json(t) ORDER BY t.total_delitos DESC NULLS LAST) FROM (
  SELECT
    cur.cve_mun,
    cm.nom_mun                                         AS municipio,
    cm.pobtot                                          AS poblacion,
    cur.total_delitos,
    cur.robo_negocio,
    cur.homicidio_doloso,
    cur.extorsion,
    cur.patrimoniales,
    cur.violentos,
    b.total_baseline,
    CASE WHEN COALESCE(cm.pobtot, 0) > 0
      THEN ROUND(cur.total_delitos::numeric * 1000.0 / cm.pobtot, 2)
      ELSE NULL
    END                                                AS delitos_per_1k_pop,
    CASE WHEN COALESCE(b.total_baseline, 0) > 0
      THEN ROUND(
        ((cur.total_delitos - b.total_baseline)::numeric / b.total_baseline) * 100.0,
        1
      )
      ELSE NULL
    END                                                AS delitos_change_pct
  FROM cur
  LEFT JOIN baseline b USING (cve_mun)
  LEFT JOIN municipios_2025 cm USING (cve_mun)
) t;
`;
}

export async function riskSummaryHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const entidad = c.req.query("entidad");
  if (!entidad || !ENTIDAD_RE.test(entidad)) {
    throw new HttpError(
      `entidad inválida "${entidad ?? ""}"`,
      400,
      "validation.entidad",
    );
  }
  const anoRaw = c.req.query("ano");
  const baselineRaw = c.req.query("baseline_ano");
  // Prefer the resolver-set value (latest year present in SESNSP); fall back
  // to the hardcoded constant for tests / cold-boot scenarios where the DB
  // wasn't reachable at server start.
  const defaultCurrentAno = config.currentRiskAno ?? RISK_DEFAULT_CURRENT_ANO;
  const currentAno = parseAnoArg(anoRaw, defaultCurrentAno, "ano");
  const baselineAno = parseAnoArg(
    baselineRaw,
    RISK_DEFAULT_BASELINE_ANO,
    "baseline_ano",
  );
  if (baselineAno >= currentAno) {
    throw new HttpError(
      `baseline_ano (${baselineAno}) debe ser anterior a ano (${currentAno}).`,
      400,
      "validation.baseline_ano",
    );
  }

  // Mat-view first → falls back to live aggregation if the operator hasn't
  // run scripts/perf-matviews.sql yet. Same pattern as nationalTreemapHandler.
  const rows = await runJsonQueryMvFirst<RawRiskSummaryRow[]>(
    config,
    riskSummaryMvSql(entidad, currentAno, baselineAno),
    riskSummaryLiveSql(entidad, currentAno, baselineAno),
  );
  const result: RiskSummaryResult = {
    entidad,
    current_ano: currentAno,
    baseline_ano: baselineAno,
    municipios: rows.map((r) => ({
      cve_mun: r.cve_mun,
      municipio: r.municipio,
      poblacion: r.poblacion === null ? null : Number(r.poblacion),
      total_delitos: Number(r.total_delitos),
      robo_negocio: Number(r.robo_negocio),
      homicidio_doloso: Number(r.homicidio_doloso),
      extorsion: Number(r.extorsion),
      patrimoniales: Number(r.patrimoniales),
      violentos: Number(r.violentos),
      total_baseline:
        r.total_baseline === null ? null : Number(r.total_baseline),
      delitos_per_1k_pop:
        r.delitos_per_1k_pop === null ? null : Number(r.delitos_per_1k_pop),
      delitos_change_pct:
        r.delitos_change_pct === null ? null : Number(r.delitos_change_pct),
    })),
  };
  // Audit M2 (2026-05-05): mat-view refresh is manual + a missed `REFRESH
  // MATERIALIZED VIEW mv_delitos_municipal_yearly` after a SESNSP loader rerun
  // would silently serve stale data with no upper bound on staleness. 5-min
  // cache matches /analytics/municipios for the same "lightly more dynamic"
  // category; downstream caches still amortize but the worst-case staleness
  // window stays bounded.
  c.header("Cache-Control", "private, max-age=300");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

function parseAnoArg(
  raw: string | undefined,
  fallback: number,
  label: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  if (!RISK_ANO_RE.test(raw)) {
    throw new HttpError(
      `${label} inválido "${raw}". Debe ser año 2010-2039 (4 dígitos).`,
      400,
      `validation.${label}`,
    );
  }
  return parseInt(raw, 10);
}

// ---------------------------------------------------------------------------
// /analytics/risk-trend?cve_mun=NNNNN
//
// Monthly time series for one municipio: ~144 rows (12 years × 12 months,
// minus months where no delitos were reported). Reads the live long-form
// table directly because a per-(cve_mun) scan over the (cve_mun) btree is
// already sub-100ms — no need for a per-month mat-view.
// ---------------------------------------------------------------------------

interface RawRiskTrendPoint {
  ano: number | string;
  mes: number | string;
  robo_negocio: number | string;
  homicidio_doloso: number | string;
  extorsion: number | string;
  total: number | string;
}

function riskTrendSql(cveMun: string): string {
  // cveMun pre-validated by CVE_MUN_RE — exactly 5 digits, never a quote.
  return `
SELECT json_agg(row_to_json(t) ORDER BY t.ano, t.mes) FROM (
  SELECT
    ano, mes,
    COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Robo a negocio'), 0)::bigint
      AS robo_negocio,
    COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Homicidio doloso'), 0)::bigint
      AS homicidio_doloso,
    COALESCE(SUM(count) FILTER (WHERE subtipo_delito = 'Extorsión'), 0)::bigint
      AS extorsion,
    SUM(count)::bigint AS total
  FROM sesnsp_delitos_municipal
  WHERE cve_mun = '${cveMun}'
  GROUP BY ano, mes
) t;
`;
}

interface RawMunicipioMeta {
  municipio: string | null;
  poblacion: number | string | null;
}

function municipioMetaSql(cveMun: string): string {
  return `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT nom_mun AS municipio, pobtot AS poblacion
  FROM municipios_2025
  WHERE cve_mun = '${cveMun}'
) t;
`;
}

export async function riskTrendHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded (ENT01-32 + MUN001-999).`,
      400,
      "validation.cve_mun",
    );
  }

  // Audit #103: series + meta in one statement (one round-trip, not two).
  const payload = await runJson<{
    series: RawRiskTrendPoint[] | null;
    meta: RawMunicipioMeta[] | null;
  }>(
    `SELECT json_build_object('series', ${scalarSubquery(riskTrendSql(cveMun))}, 'meta', ${scalarSubquery(municipioMetaSql(cveMun))});`,
    { container: config.dbContainer },
  );
  const series = payload.series ?? [];
  const metaRow = payload.meta?.[0] ?? null;

  const result: RiskTrendResult = {
    cve_mun: cveMun,
    municipio: metaRow?.municipio ?? null,
    poblacion:
      metaRow?.poblacion === null || metaRow?.poblacion === undefined
        ? null
        : Number(metaRow.poblacion),
    series: series.map((p) => ({
      ano: Number(p.ano),
      mes: Number(p.mes),
      robo_negocio: Number(p.robo_negocio),
      homicidio_doloso: Number(p.homicidio_doloso),
      extorsion: Number(p.extorsion),
      total: Number(p.total),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/locust-ageb?cve_mun=NNNNN
//
// All AGEB-grain rows within one municipio: a big-city municipio has a few
// thousand AGEBs, small ones a handful. Joins the census population view
// (censo_ageb) with the CONEVAL rezago-social grade view (coneval_grs_ageb)
// on the 13-char cvegeo key (ENT2+MUN3+LOC4+AGEB4). LEFT JOIN — an AGEB can
// have a census row but no CONEVAL row, so grado_rezago_ageb may be null.
// Reads the views directly: a cvegeo-prefix scan over the btree-indexed raw
// tables is sub-100ms, no mat-view needed (mirrors risk-trend's reasoning).
// ---------------------------------------------------------------------------

interface RawLocustAgebRow {
  cvegeo: string;
  cve_ageb: string;
  pobtot_ageb: number | string | null;
  grado_rezago_ageb: string | null;
}

function locustAgebSql(cveMun: string): string {
  // cveMun pre-validated by CVE_MUN_RE — exactly 5 digits, never a quote.
  // Audit #134: half-open cvegeo range instead of LEFT(cvegeo, 5) so the
  // cvegeo btree is usable (1.98 s -> ~2-6 ms for 09007/09015).
  const next = String(Number(cveMun) + 1).padStart(5, "0");
  return `
SELECT json_agg(row_to_json(t) ORDER BY t.cvegeo) FROM (
  SELECT c.cvegeo,
         c.ageb   AS cve_ageb,
         c.pobtot AS pobtot_ageb,
         r.grado  AS grado_rezago_ageb
  FROM censo_ageb c
  LEFT JOIN coneval_grs_ageb r ON r.cvegeo = c.cvegeo
  WHERE c.cvegeo >= '${cveMun}' AND c.cvegeo < '${next}'
  ORDER BY c.cvegeo
) t;
`;
}

export async function locustAgebHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded (ENT01-32 + MUN001-999).`,
      400,
      "validation.cve_mun",
    );
  }

  // Audit #103: rows + meta in one statement (one round-trip, not two).
  const payload = await runJson<{
    agebs: RawLocustAgebRow[] | null;
    meta: RawMunicipioMeta[] | null;
  }>(
    `SELECT json_build_object('agebs', ${scalarSubquery(locustAgebSql(cveMun))}, 'meta', ${scalarSubquery(municipioMetaSql(cveMun))});`,
    { container: config.dbContainer },
  );
  const rows = payload.agebs ?? [];
  const metaRow = payload.meta?.[0] ?? null;

  const result: LocustAgebResult = {
    cve_mun: cveMun,
    municipio: metaRow?.municipio ?? null,
    agebs: rows.map((r) => ({
      cvegeo: r.cvegeo,
      cve_ageb: r.cve_ageb,
      pobtot_ageb:
        r.pobtot_ageb === null || r.pobtot_ageb === undefined
          ? null
          : Number(r.pobtot_ageb),
      grado_rezago_ageb: r.grado_rezago_ageb ?? null,
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// Mortality (EDR/SINAIS) — v0.2.3-A. Same architectural shape as the risk
// surface: a current-ano resolver at boot + mat-view-first reads with a
// live aggregation fallback against `inegi_edr_defunciones_raw`.
// ---------------------------------------------------------------------------

// Audit #133: the resolver reads the mat-view first (~3 ms) and only
// falls back to this ~1 s parallel scan of the raw table when the MV is
// missing or yields nothing. Same filters as mv_mortalidad_municipal_yearly,
// so both paths agree on which year is "primary".
const CURRENT_MORTALITY_ANO_MV_SQL = `
SELECT json_build_array(MAX(ano)) FROM (
  SELECT ano
  FROM mv_mortalidad_municipal_yearly
  GROUP BY ano
  HAVING SUM(total_defunciones) >= 100000
) t
WHERE ano <= EXTRACT(YEAR FROM NOW())::int;
`;

const CURRENT_MORTALITY_ANO_LIVE_SQL = `
SELECT json_build_array(MAX(ano)) FROM (
  SELECT NULLIF(anio_ocur, '')::int AS ano,
         COUNT(*)                   AS yr_total
  FROM inegi_edr_defunciones_raw
  WHERE anio_ocur ~ '^[0-9]{4}$'
    AND ent_resid IN ('01','02','03','04','05','06','07','08','09','10',
                      '11','12','13','14','15','16','17','18','19','20',
                      '21','22','23','24','25','26','27','28','29','30',
                      '31','32')
    AND mun_resid IS NOT NULL AND mun_resid != '999'
  GROUP BY NULLIF(anio_ocur, '')::int
  HAVING COUNT(*) >= 100000          -- "primary year" floor; lag artifacts <50k
) t
WHERE ano <= EXTRACT(YEAR FROM NOW())::int;
`;

/**
 * Resolve the latest "primary" mortality year for /analytics/mortality-summary
 * defaults. EDR datasets are released annually, but each release contains
 * deaths registered in that year that occurred earlier (lag rows). The
 * resolver picks the year with at least 100k recorded deaths — sufficient
 * to distinguish the bulk-loaded year from the residual lag rows of prior
 * years (which top out at <50k in current data).
 *
 * Same fallback contract as `resolveCurrentRiskAno`: never throws, returns
 * a discriminated result so the boot log can distinguish data-derived from
 * static-fallback values.
 */
export function resolveCurrentMortalityAno(config: ApiServerConfig): {
  ano: number;
  source: "data" | "fallback";
} {
  const fromData =
    tryResolveAno(config, CURRENT_MORTALITY_ANO_MV_SQL) ??
    tryResolveAno(config, CURRENT_MORTALITY_ANO_LIVE_SQL);
  if (fromData !== null) return { ano: fromData, source: "data" };
  return { ano: MORTALITY_DEFAULT_CURRENT_ANO, source: "fallback" };
}

// Audit #60: only one EDR release is loaded, so earlier years hold just its
// late-registration lag rows (2023 ≈ 17k vs 2024 ≈ 790k nationally). Trend
// and summary only serve "primary" years, the same >= 100k national floor
// the resolver above uses. MV and live-fallback variants of the same CTE.
const MORTALITY_PRIMARY_YEARS_MV_CTE = `primary_years AS (
  SELECT ano FROM mv_mortalidad_municipal_yearly
  GROUP BY ano
  HAVING SUM(total_defunciones) >= 100000
)`;

const MORTALITY_PRIMARY_YEARS_LIVE_CTE = `primary_years AS (
  SELECT NULLIF(anio_ocur, '')::int AS ano
  FROM inegi_edr_defunciones_raw
  WHERE anio_ocur ~ '^[0-9]{4}$'
    AND ent_resid ~ '^(0[1-9]|[12][0-9]|3[0-2])$'
    AND mun_resid IS NOT NULL AND mun_resid != '999'
  GROUP BY NULLIF(anio_ocur, '')::int
  HAVING COUNT(*) >= 100000
)`;

// ---------------------------------------------------------------------------
// /analytics/mortality-summary?entidad=NN[&ano=YYYY]
// ---------------------------------------------------------------------------

interface RawMortalitySummaryRow {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | string | null;
  total_defunciones: number | string;
  def_menores_1ano: number | string;
  def_circulatorio: number | string;
  def_neoplasias: number | string;
  def_endocrinas: number | string;
  def_externas: number | string;
  tasa_mortalidad_per_1k: number | string | null;
  tasa_infantil_per_1k: number | string | null;
}

function mortalitySummaryMvSql(entidad: string, ano: number): string {
  // entidad pre-validated by ENTIDAD_RE; ano pre-validated by RISK_ANO_RE
  // (reused for mortality — same year-range constraints).
  return `
WITH ${MORTALITY_PRIMARY_YEARS_MV_CTE}
SELECT json_build_object(
  'ano_is_primary', EXISTS (SELECT 1 FROM primary_years WHERE ano = ${ano}),
  'municipios', (
SELECT json_agg(row_to_json(t) ORDER BY t.total_defunciones DESC NULLS LAST) FROM (
  SELECT
    m.cve_mun,
    cm.nom_mun                                         AS municipio,
    cm.pobtot                                          AS poblacion,
    m.total_defunciones,
    m.def_menores_1ano,
    m.def_circulatorio,
    m.def_neoplasias,
    m.def_endocrinas,
    m.def_externas,
    CASE WHEN COALESCE(cm.pobtot, 0) > 0
      THEN ROUND(m.total_defunciones::numeric * 1000.0 / cm.pobtot, 2)
      ELSE NULL
    END                                                AS tasa_mortalidad_per_1k,
    CASE WHEN COALESCE(cm.pobtot, 0) > 0
      THEN ROUND(m.def_menores_1ano::numeric * 1000.0 / cm.pobtot, 2)
      ELSE NULL
    END                                                AS tasa_infantil_per_1k
  FROM mv_mortalidad_municipal_yearly m
  LEFT JOIN municipios_2025 cm USING (cve_mun)
  WHERE ${entidadCveMunRangeSql("m.cve_mun", entidad)} AND m.ano = ${ano}
) t
  )
);
`;
}

/**
 * Live-aggregation fallback for mortality-summary. Aggregates directly
 * against `inegi_edr_defunciones_raw` — same FILTER pattern as the
 * mat-view, just unrolled. Used when the operator hasn't run
 * `scripts/perf-matviews.sql` yet on a fresh DB. Audit-pattern parity
 * with risk-summary's M1 fix (2026-05-05).
 */
function mortalitySummaryLiveSql(entidad: string, ano: number): string {
  return `
WITH ${MORTALITY_PRIMARY_YEARS_LIVE_CTE},
muni AS (
  SELECT
    (ent_resid || mun_resid)                                   AS cve_mun,
    COUNT(*)::bigint                                           AS total_defunciones,
    COUNT(*) FILTER (WHERE LEFT(edad, 1) IN ('1','2','3'))::bigint AS def_menores_1ano,
    -- capitulo is unpadded TEXT (see mat-view DDL note in perf-matviews.sql).
    COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 9)::bigint  AS def_circulatorio,
    COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 2)::bigint  AS def_neoplasias,
    COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 4)::bigint  AS def_endocrinas,
    COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 20)::bigint AS def_externas
  FROM inegi_edr_defunciones_raw
  WHERE ent_resid = '${entidad}'
    AND mun_resid IS NOT NULL AND mun_resid != '999'
    AND anio_ocur ~ '^[0-9]{4}$' AND NULLIF(anio_ocur, '')::int = ${ano}
  GROUP BY ent_resid || mun_resid
)
SELECT json_build_object(
  'ano_is_primary', EXISTS (SELECT 1 FROM primary_years WHERE ano = ${ano}),
  'municipios', (
SELECT json_agg(row_to_json(t) ORDER BY t.total_defunciones DESC NULLS LAST) FROM (
  SELECT
    m.cve_mun,
    cm.nom_mun                                         AS municipio,
    cm.pobtot                                          AS poblacion,
    m.total_defunciones,
    m.def_menores_1ano,
    m.def_circulatorio,
    m.def_neoplasias,
    m.def_endocrinas,
    m.def_externas,
    CASE WHEN COALESCE(cm.pobtot, 0) > 0
      THEN ROUND(m.total_defunciones::numeric * 1000.0 / cm.pobtot, 2)
      ELSE NULL
    END                                                AS tasa_mortalidad_per_1k,
    CASE WHEN COALESCE(cm.pobtot, 0) > 0
      THEN ROUND(m.def_menores_1ano::numeric * 1000.0 / cm.pobtot, 2)
      ELSE NULL
    END                                                AS tasa_infantil_per_1k
  FROM muni m
  LEFT JOIN municipios_2025 cm USING (cve_mun)
) t
  )
);
`;
}

export async function mortalitySummaryHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const entidad = c.req.query("entidad");
  if (!entidad || !ENTIDAD_RE.test(entidad)) {
    throw new HttpError(
      `entidad inválida "${entidad ?? ""}"`,
      400,
      "validation.entidad",
    );
  }
  const anoRaw = c.req.query("ano");
  const defaultAno =
    config.currentMortalityAno ?? MORTALITY_DEFAULT_CURRENT_ANO;
  const ano = parseAnoArg(anoRaw, defaultAno, "ano");

  const raw = await runJsonQueryMvFirst<{
    ano_is_primary?: boolean;
    municipios?: RawMortalitySummaryRow[] | null;
  }>(
    config,
    mortalitySummaryMvSql(entidad, ano),
    mortalitySummaryLiveSql(entidad, ano),
  );
  if (raw.ano_is_primary !== true) {
    throw new HttpError(
      `ano ${ano} no es un año primario de mortalidad (solo contiene registros tardíos de otra edición EDR)`,
      400,
      "validation.ano_not_primary",
    );
  }
  const rows = raw.municipios ?? [];

  const result: MortalitySummaryResult = {
    entidad,
    current_ano: ano,
    municipios: rows.map((r) => ({
      cve_mun: r.cve_mun,
      municipio: r.municipio,
      poblacion: r.poblacion === null ? null : Number(r.poblacion),
      total_defunciones: Number(r.total_defunciones),
      def_menores_1ano: Number(r.def_menores_1ano),
      def_circulatorio: Number(r.def_circulatorio),
      def_neoplasias: Number(r.def_neoplasias),
      def_endocrinas: Number(r.def_endocrinas),
      def_externas: Number(r.def_externas),
      tasa_mortalidad_per_1k:
        r.tasa_mortalidad_per_1k === null
          ? null
          : Number(r.tasa_mortalidad_per_1k),
      tasa_infantil_per_1k:
        r.tasa_infantil_per_1k === null ? null : Number(r.tasa_infantil_per_1k),
    })),
  };
  // Mortality data is annual + ~12-month lag — much less dynamic than risk
  // (monthly SESNSP). Match national-treemap's 1-hour cache.
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/mortality-trend?cve_mun=NNNNN
// ---------------------------------------------------------------------------

interface RawMortalityTrendPoint {
  ano: number | string;
  total_defunciones: number | string;
  def_menores_1ano: number | string;
  def_circulatorio: number | string;
  def_neoplasias: number | string;
  def_endocrinas: number | string;
  def_externas: number | string;
}

interface RawMortalityTrendMeta {
  municipio: string | null;
  poblacion: number | string | null;
}

function mortalityTrendSql(cveMun: string): string {
  // Mat-view path. cve_mun pre-validated by CVE_MUN_RE. Audit W1: tighten
  // year bounds to 2010..2039 to match RISK_ANO_RE — corrupt rows beyond
  // that range are suppressed by both layers.
  return `
WITH ${MORTALITY_PRIMARY_YEARS_MV_CTE}
SELECT json_agg(row_to_json(t) ORDER BY t.ano) FROM (
  SELECT
    ano,
    total_defunciones,
    def_menores_1ano,
    def_circulatorio,
    def_neoplasias,
    def_endocrinas,
    def_externas
  FROM mv_mortalidad_municipal_yearly
  WHERE cve_mun = '${cveMun}'
    AND ano BETWEEN 2010 AND 2039
    AND ano IN (SELECT ano FROM primary_years)
) t;
`;
}

/**
 * Live-aggregation fallback for mortality-trend. Audit C2 (2026-05-05):
 * sibling parity with mortality-summary's M1 fix. Aggregates directly
 * against `inegi_edr_defunciones_raw` filtered by the input cve_mun's
 * entidad and municipio components — same FILTER pattern as the mat-view,
 * unrolled. Used when the operator hasn't run `scripts/perf-matviews.sql`
 * yet on a fresh DB.
 */
function mortalityTrendLiveSql(cveMun: string): string {
  // cveMun pre-validated by CVE_MUN_RE → ent (2 chars) + mun (3 chars).
  const ent = cveMun.slice(0, 2);
  const mun = cveMun.slice(2, 5);
  return `
WITH ${MORTALITY_PRIMARY_YEARS_LIVE_CTE}
SELECT json_agg(row_to_json(t) ORDER BY t.ano) FROM (
  SELECT
    NULLIF(anio_ocur, '')::int                                     AS ano,
    COUNT(*)::bigint                                               AS total_defunciones,
    COUNT(*) FILTER (WHERE LEFT(edad, 1) IN ('1','2','3'))::bigint AS def_menores_1ano,
    COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 9)::bigint  AS def_circulatorio,
    COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 2)::bigint  AS def_neoplasias,
    COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 4)::bigint  AS def_endocrinas,
    COUNT(*) FILTER (WHERE NULLIF(capitulo, '')::int = 20)::bigint AS def_externas
  FROM inegi_edr_defunciones_raw
  WHERE ent_resid = '${ent}'
    AND mun_resid = '${mun}'
    AND anio_ocur ~ '^[0-9]{4}$'
    AND NULLIF(anio_ocur, '')::int BETWEEN 2010 AND 2039
    AND NULLIF(anio_ocur, '')::int IN (SELECT ano FROM primary_years)
  GROUP BY NULLIF(anio_ocur, '')::int
) t;
`;
}

function mortalityTrendMetaSql(cveMun: string): string {
  // Audit C1 (2026-05-05): use json_agg + index-into-array, mirroring
  // riskTrendHandler. row_to_json on a 0-row inner SELECT emits an empty
  // stdout string that runJson normalizes to `[]` — the handler then
  // dereferences `meta?.municipio` on what's actually an array. Today
  // it works by accident; multi-row censo (or a json shape change)
  // could break it silently.
  return `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT nom_mun AS municipio, pobtot AS poblacion
  FROM municipios_2025
  WHERE cve_mun = '${cveMun}'
) t;
`;
}

export async function mortalityTrendHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos (entidad 01-32 + municipio).`,
      400,
      "validation.cve_mun",
    );
  }

  // Audit C2 (2026-05-05): mat-view-first read with live aggregation
  // fallback so a fresh DB without `scripts/perf-matviews.sql` still
  // serves trend (same M1 pattern as mortality-summary).
  // Audit #103: series + meta fold into one statement per path, so each
  // request is one round-trip (two only when the MV is missing).
  // Audit C1: meta SQL returns json_agg([]) — match riskTrendHandler's shape.
  const withMeta = (seriesSql: string): string =>
    `SELECT json_build_object('series', ${scalarSubquery(seriesSql)}, 'meta', ${scalarSubquery(mortalityTrendMetaSql(cveMun))});`;
  const payload = await runJsonQueryMvFirst<{
    series: RawMortalityTrendPoint[] | null;
    meta: RawMortalityTrendMeta[] | null;
  }>(
    config,
    withMeta(mortalityTrendSql(cveMun)),
    withMeta(mortalityTrendLiveSql(cveMun)),
  );
  const series = payload.series ?? [];
  const meta = payload.meta?.[0] ?? null;

  const result: MortalityTrendResult = {
    cve_mun: cveMun,
    municipio: meta?.municipio ?? null,
    poblacion:
      meta?.poblacion === null || meta?.poblacion === undefined
        ? null
        : Number(meta.poblacion),
    series: series.map((p) => ({
      ano: Number(p.ano),
      total_defunciones: Number(p.total_defunciones),
      def_menores_1ano: Number(p.def_menores_1ano),
      def_circulatorio: Number(p.def_circulatorio),
      def_neoplasias: Number(p.def_neoplasias),
      def_endocrinas: Number(p.def_endocrinas),
      def_externas: Number(p.def_externas),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// State calibrators (v0.2.3-C) — single-row response per entidad backed by
// `calibrators_enigh_state` (ENOE table will land in a follow-up under
// the same endpoint). All `_calibrated` enrichment of municipal endpoints
// is opt-in via LEFT JOIN — this endpoint is the introspection surface.
// ---------------------------------------------------------------------------

interface RawStateCalibratorsRow {
  entidad: string;
  // ENIGH
  enigh_ano: number | string | null;
  hogares_estimados: number | string | null;
  poblacion_estimada: number | string | null;
  ingreso_corriente_promedio: number | string | null;
  ingreso_corriente_mediana: number | string | null;
  decil_1_ingreso: number | string | null;
  decil_9_ingreso: number | string | null;
  gasto_corriente_promedio: number | string | null;
  pct_gasto_alimentos: number | string | null;
  pct_gasto_vivienda: number | string | null;
  pct_gasto_salud: number | string | null;
  pct_gasto_transporte: number | string | null;
  pct_gasto_educacion: number | string | null;
  // ENOE
  enoe_ano: number | string | null;
  enoe_trimestres_cargados: number | string | null;
  poblacion_15_mas: number | string | null;
  pea: number | string | null;
  ocupada: number | string | null;
  desocupada: number | string | null;
  informal: number | string | null;
  tasa_participacion: number | string | null;
  tasa_desocupacion: number | string | null;
  tasa_informalidad: number | string | null;
  ingreso_promedio_mensual_ocupado: number | string | null;
}

function stateCalibratorsSql(entidad: string): string {
  // entidad pre-validated by ENTIDAD_RE. LEFT JOIN both calibrator tables
  // so a partial load (only ENIGH or only ENOE) still returns a populated
  // row — the missing-source columns just come back null. Each side picks
  // its own latest ano_levantamiento independently. json_agg + read [0]
  // avoids the C1-class shape bug where runJson normalizes empty
  // stdout to []. COALESCE(...,0) on entidad-equality lets each side miss
  // its row table entirely (caught by isRelationMissingError separately).
  return `
SELECT json_agg(row_to_json(t)) FROM (
  WITH enigh AS (
    SELECT
      ano_levantamiento AS enigh_ano,
      hogares_estimados,
      poblacion_estimada,
      ingreso_corriente_promedio,
      ingreso_corriente_mediana,
      decil_1_ingreso,
      decil_9_ingreso,
      gasto_corriente_promedio,
      pct_gasto_alimentos,
      pct_gasto_vivienda,
      pct_gasto_salud,
      pct_gasto_transporte,
      pct_gasto_educacion
    FROM calibrators_enigh_state
    WHERE entidad = '${entidad}'
    ORDER BY ano_levantamiento DESC
    LIMIT 1
  ),
  enoe AS (
    SELECT
      ano_levantamiento AS enoe_ano,
      trimestres_cargados AS enoe_trimestres_cargados,
      poblacion_15_mas,
      pea,
      ocupada,
      desocupada,
      informal,
      tasa_participacion,
      tasa_desocupacion,
      tasa_informalidad,
      ingreso_promedio_mensual AS ingreso_promedio_mensual_ocupado
    FROM calibrators_enoe_state
    WHERE entidad = '${entidad}'
    ORDER BY ano_levantamiento DESC
    LIMIT 1
  )
  SELECT
    '${entidad}' AS entidad,
    enigh.*,
    enoe.*
  FROM (SELECT 1) one
  LEFT JOIN enigh ON true
  LEFT JOIN enoe ON true
) t;
`;
}

/** Empty-shaped row used when no calibrator data exists yet for an entidad. */
function emptyCalibratorRow(entidad: string): StateCalibratorsRow {
  return {
    entidad,
    enigh_ano: null,
    hogares_estimados: null,
    poblacion_estimada: null,
    ingreso_corriente_promedio: null,
    ingreso_corriente_mediana: null,
    decil_1_ingreso: null,
    decil_9_ingreso: null,
    gasto_corriente_promedio: null,
    pct_gasto_alimentos: null,
    pct_gasto_vivienda: null,
    pct_gasto_salud: null,
    pct_gasto_transporte: null,
    pct_gasto_educacion: null,
    enoe_ano: null,
    enoe_trimestres_cargados: null,
    poblacion_15_mas: null,
    pea: null,
    ocupada: null,
    desocupada: null,
    informal: null,
    tasa_participacion: null,
    tasa_desocupacion: null,
    tasa_informalidad: null,
    ingreso_promedio_mensual_ocupado: null,
  };
}

export async function stateCalibratorsHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const entidad = c.req.query("entidad");
  if (!entidad || !ENTIDAD_RE.test(entidad)) {
    throw new HttpError(
      `entidad inválida "${entidad ?? ""}"`,
      400,
      "validation.entidad",
    );
  }

  // Graceful fallback: if `calibrators_enigh_state` doesn't exist yet
  // (operator hasn't run load-enigh.ts), return an empty-shaped row instead
  // of 502. The endpoint's contract says the row is always present for any
  // valid entidad — null values mean "not loaded yet."
  let raw: RawStateCalibratorsRow | null;
  try {
    const rows = await runJson<RawStateCalibratorsRow[]>(
      stateCalibratorsSql(entidad),
      { container: config.dbContainer },
    );
    raw = rows[0] ?? null;
  } catch (err) {
    if (isRelationMissingError(err)) {
      raw = null;
    } else {
      throw err;
    }
  }

  const num = (v: number | string | null | undefined): number | null =>
    v === null || v === undefined ? null : Number(v);

  const calibrators: StateCalibratorsRow = raw
    ? {
        entidad,
        // ENIGH
        enigh_ano: num(raw.enigh_ano),
        hogares_estimados: num(raw.hogares_estimados),
        poblacion_estimada: num(raw.poblacion_estimada),
        ingreso_corriente_promedio: num(raw.ingreso_corriente_promedio),
        ingreso_corriente_mediana: num(raw.ingreso_corriente_mediana),
        decil_1_ingreso: num(raw.decil_1_ingreso),
        decil_9_ingreso: num(raw.decil_9_ingreso),
        gasto_corriente_promedio: num(raw.gasto_corriente_promedio),
        pct_gasto_alimentos: num(raw.pct_gasto_alimentos),
        pct_gasto_vivienda: num(raw.pct_gasto_vivienda),
        pct_gasto_salud: num(raw.pct_gasto_salud),
        pct_gasto_transporte: num(raw.pct_gasto_transporte),
        pct_gasto_educacion: num(raw.pct_gasto_educacion),
        // ENOE
        enoe_ano: num(raw.enoe_ano),
        enoe_trimestres_cargados: num(raw.enoe_trimestres_cargados),
        poblacion_15_mas: num(raw.poblacion_15_mas),
        pea: num(raw.pea),
        ocupada: num(raw.ocupada),
        desocupada: num(raw.desocupada),
        informal: num(raw.informal),
        tasa_participacion: num(raw.tasa_participacion),
        tasa_desocupacion: num(raw.tasa_desocupacion),
        tasa_informalidad: num(raw.tasa_informalidad),
        ingreso_promedio_mensual_ocupado: num(
          raw.ingreso_promedio_mensual_ocupado,
        ),
      }
    : emptyCalibratorRow(entidad);

  const result: StateCalibratorsResult = { entidad, calibrators };
  // Calibrators change once per ENIGH wave (~biennial). 1-hour cache fits.
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// AGEB analytics primitive (v0.2.4-A, 2026-05-05)
// Spatial + count endpoints exposing the existing `ageb_polygons` ×
// `establecimientos.ageb` × `clues` infrastructure. No new tables — this
// is purely an exposure layer. Census-AGEB indicators (population density,
// % indigenous, vivienda) are deferred to v0.2.4-B pending operator URL
// drop for INEGI's RESAGEBURB dataset (currently behind a gated portal per
// jarvis-kb/projects/data-intelligence/README.md).
// ---------------------------------------------------------------------------

interface RawAgebsByMunicipioRow {
  cvegeo: string;
  ambito: string | null;
  centroid_lat: number | string | null;
  centroid_lon: number | string | null;
  area_km2: number | string | null;
  establecimientos: number | string | null;
  farmacias: number | string | null;
  clues: number | string | null;
}

const AGEBS_ORDER_BY_SQL: Record<AgebsOrderBy, string> = {
  establecimientos: "establecimientos DESC",
  farmacias: "farmacias DESC",
  clues: "clues DESC",
  area: "area_km2 DESC",
};

function agebsByMunicipioSql(
  cveMun: string,
  orderBy: AgebsOrderBy,
  limit: number,
): string {
  // cveMun pre-validated by CVE_MUN_RE (5 digits). orderBy keyed off enum
  // (AGEBS_ORDER_BY_SQL) — never user-controlled in the SQL string. limit is
  // an integer clamped to AGEBS_MAX_LIMIT before reaching this function.
  return `
SELECT json_agg(row_to_json(t) ORDER BY ${AGEBS_ORDER_BY_SQL[orderBy]} NULLS LAST, t.cvegeo) FROM (
  SELECT
    a.cvegeo,
    NULLIF(TRIM(a.ambito), '') AS ambito,
    ST_Y(ST_Centroid(a.geom))::numeric(10,6) AS centroid_lat,
    ST_X(ST_Centroid(a.geom))::numeric(10,6) AS centroid_lon,
    ROUND((ST_Area(a.geom::geography) / 1000000)::numeric, 4) AS area_km2,
    COALESCE(e.cnt, 0)::bigint AS establecimientos,
    COALESCE(f.cnt, 0)::bigint AS farmacias,
    COALESCE(s.cnt, 0)::bigint AS clues
  FROM ageb_polygons a
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE ${agebOfMunicipioSql(cveMun)} AND ageb IS NOT NULL AND ageb != ''
    GROUP BY ageb
  ) e ON e.ageb = a.cvegeo
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE ${agebOfMunicipioSql(cveMun)} AND ageb IS NOT NULL AND ageb != ''
      AND clase_actividad_id IN (${FARMACIA_CLASES_SQL})
    GROUP BY ageb
  ) f ON f.ageb = a.cvegeo
  LEFT JOIN (
    SELECT a2.cvegeo, COUNT(*) AS cnt
    FROM ageb_polygons a2
    JOIN clues c ON ST_Contains(a2.geom, c.geom)
    WHERE a2.cve_ent = '${cveMun.slice(0, 2)}' AND a2.cve_mun = '${cveMun.slice(2)}'
    GROUP BY a2.cvegeo
  ) s ON s.cvegeo = a.cvegeo
  WHERE a.cve_ent = '${cveMun.slice(0, 2)}' AND a.cve_mun = '${cveMun.slice(2)}'
  ORDER BY ${AGEBS_ORDER_BY_SQL[orderBy]} NULLS LAST, a.cvegeo
  LIMIT ${limit}
) t;
`;
}

/**
 * GET /analytics/agebs-by-municipio?cve_mun=NNNNN[&order_by=...][&limit=N]
 *
 * Lists AGEBs in a municipio with establishment / farmacia / CLUES counts +
 * geometry summary. Direct SQL via docker exec psql; no mat-view since the
 * scope is one cve_mun at a time (Mexico City's largest muni has ~5K AGEBs;
 * even Iztapalapa returns in <2s without a pre-aggregation).
 *
 * Use this to pick top AGEBs inside a high-demand muni for downstream
 * detail / opportunity queries.
 */
export async function agebsByMunicipioHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded.`,
      400,
      "validation.cve_mun",
    );
  }
  const orderByRaw = c.req.query("order_by") ?? "establecimientos";
  if (!AGEBS_ORDER_BY.includes(orderByRaw as AgebsOrderBy)) {
    throw new HttpError(
      `order_by inválido "${orderByRaw}". Debe ser uno de: ${AGEBS_ORDER_BY.join(", ")}.`,
      400,
      "validation.order_by",
    );
  }
  const orderBy = orderByRaw as AgebsOrderBy;
  const limitRaw = c.req.query("limit");
  let limit = AGEBS_DEFAULT_LIMIT;
  if (limitRaw !== undefined && limitRaw !== "") {
    const parsed = Number(limitRaw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > AGEBS_MAX_LIMIT) {
      throw new HttpError(
        `limit inválido "${limitRaw}". Debe ser entero entre 1 y ${AGEBS_MAX_LIMIT}.`,
        400,
        "validation.limit",
      );
    }
    limit = parsed;
  }

  const rows = await runJson<RawAgebsByMunicipioRow[]>(
    agebsByMunicipioSql(cveMun, orderBy, limit),
    { container: config.dbContainer },
  );
  const result: AgebsByMunicipioResult = {
    cve_mun: cveMun,
    order_by: orderBy,
    total_returned: rows.length,
    agebs: rows.map((r) => ({
      cvegeo: r.cvegeo,
      ambito: r.ambito === "Urbana" || r.ambito === "Rural" ? r.ambito : null,
      centroid_lat: r.centroid_lat === null ? null : Number(r.centroid_lat),
      centroid_lon: r.centroid_lon === null ? null : Number(r.centroid_lon),
      area_km2: r.area_km2 === null ? null : Number(r.area_km2),
      establecimientos: Number(r.establecimientos ?? 0),
      farmacias: Number(r.farmacias ?? 0),
      clues: Number(r.clues ?? 0),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/ageb-detail
// ---------------------------------------------------------------------------

interface RawAgebDetailIdentity {
  cvegeo: string;
  cve_ent: string;
  cve_mun: string;
  cve_loc: string;
  cve_ageb: string;
  ambito: string | null;
  area_km2: number | string | null;
  centroid_lat: number | string | null;
  centroid_lon: number | string | null;
  bbox_minlon: number | string | null;
  bbox_minlat: number | string | null;
  bbox_maxlon: number | string | null;
  bbox_maxlat: number | string | null;
}

interface RawAgebDetailLocMeta {
  loc_population: number | string | null;
  loc_name: string | null;
}

interface RawAgebDetailEstabSummary {
  total_establecimientos: number | string | null;
  total_farmacias: number | string | null;
}

interface RawAgebDetailTopSector {
  scian2: string;
  count: number | string;
}

interface RawAgebDetailClues {
  clues: string;
  nombre: string | null;
  tipo: string | null;
  lat: number | string | null;
  lon: number | string | null;
}

function agebIdentitySql(cvegeo: string): string {
  // cvegeo pre-validated by CVEGEO_RE (exactly 13 digits).
  return `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    cvegeo,
    cve_ent, cve_mun, cve_loc, cve_ageb,
    NULLIF(TRIM(ambito), '') AS ambito,
    ROUND((ST_Area(geom::geography) / 1000000)::numeric, 4) AS area_km2,
    ST_Y(ST_Centroid(geom))::numeric(10,6) AS centroid_lat,
    ST_X(ST_Centroid(geom))::numeric(10,6) AS centroid_lon,
    ST_XMin(geom)::numeric(10,6) AS bbox_minlon,
    ST_YMin(geom)::numeric(10,6) AS bbox_minlat,
    ST_XMax(geom)::numeric(10,6) AS bbox_maxlon,
    ST_YMax(geom)::numeric(10,6) AS bbox_maxlat
  FROM ageb_polygons
  WHERE cvegeo = '${cvegeo}'
) t;
`;
}

function agebLocMetaSql(cvegeo: string): string {
  // Containing locality population proxy. censo_iter is keyed by entidad/mun/loc
  // (3-tuple). cvegeo is ENT(2)+MUN(3)+LOC(4)+AGEB(4) — first 9 chars locate the
  // containing locality. Cast to int because censo_iter columns are TEXT.
  const ent = `'${cvegeo.slice(0, 2)}'`;
  const mun = `'${cvegeo.slice(2, 5)}'`;
  const loc = `'${cvegeo.slice(5, 9)}'`;
  return `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    NULLIF(pobtot, '')::int AS loc_population,
    nom_loc AS loc_name
  FROM censo_iter
  WHERE entidad = ${ent} AND mun = ${mun} AND loc = ${loc}
  LIMIT 1
) t;
`;
}

/**
 * AGEB-level census from censo_ageb (Censo 2020 RESAGEBURB urbana).
 * Returns at most one row. Empty result = AGEB is rural (not in dataset)
 * or census not yet ingested. v0.2.4-B (2026-05-05).
 */
function agebCensusSql(cvegeo: string): string {
  return `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    pobtot, pobfem, pobmas,
    p_60ymas, p_15ymas, p_18ymas,
    pea, pocupada, graproes,
    tvivhab, tvivpar, vph_inter, vph_autom,
    pder_ss, pder_imss, pder_imssb, pder_iste, pder_istee, pder_segp,
    pafil_ipriv, psinder
  FROM censo_ageb
  WHERE cvegeo = '${cvegeo}'
  LIMIT 1
) t;
`;
}

interface RawAgebCensusRow {
  pobtot: number | string | null;
  pobfem: number | string | null;
  pobmas: number | string | null;
  p_60ymas: number | string | null;
  p_15ymas: number | string | null;
  p_18ymas: number | string | null;
  pea: number | string | null;
  pocupada: number | string | null;
  graproes: number | string | null;
  tvivhab: number | string | null;
  tvivpar: number | string | null;
  vph_inter: number | string | null;
  vph_autom: number | string | null;
  pder_ss: number | string | null;
  pder_imss: number | string | null;
  pder_imssb: number | string | null;
  pder_iste: number | string | null;
  pder_istee: number | string | null;
  pder_segp: number | string | null;
  pafil_ipriv: number | string | null;
  psinder: number | string | null;
}

/**
 * CONEVAL GRS_AGEB urbana 2020 (v0.2.6) — single AGEB rezago social row.
 *
 * `grado` is the headline ordinal classifier (Muy bajo/Bajo/Medio/Alto/
 * Muy alto). The 17 indicators are percentage breakdowns; some may be
 * NULL per LSNIEG art. 37 (CONEVAL suppresses values for AGEBs with <3
 * viviendas habitadas). The view filter ensures only the 5 valid grados
 * pass through, so a NULL `grado` from this query means the AGEB is not
 * in CONEVAL's dataset (rural / post-2020 subdivision / orphan).
 */
function agebRezagoSql(cvegeo: string): string {
  return `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    grado, pobtot, vivpar_hab,
    ind_analfabeta, ind_no_escuela_6_14, ind_no_escuela_15_24,
    ind_basica_incompleta, ind_sin_salud, ind_hacinamiento,
    ind_sin_agua, ind_sin_excusado, ind_sin_drenaje,
    ind_sin_luz, ind_piso_tierra, ind_sin_lavadora,
    ind_sin_refri, ind_sin_telfijo, ind_sin_celular,
    ind_sin_compu, ind_sin_internet
  FROM coneval_grs_ageb
  WHERE cvegeo = '${cvegeo}'
  LIMIT 1
) t;
`;
}

interface RawAgebRezagoRow {
  grado: string | null;
  pobtot: number | string | null;
  vivpar_hab: number | string | null;
  ind_analfabeta: number | string | null;
  ind_no_escuela_6_14: number | string | null;
  ind_no_escuela_15_24: number | string | null;
  ind_basica_incompleta: number | string | null;
  ind_sin_salud: number | string | null;
  ind_hacinamiento: number | string | null;
  ind_sin_agua: number | string | null;
  ind_sin_excusado: number | string | null;
  ind_sin_drenaje: number | string | null;
  ind_sin_luz: number | string | null;
  ind_piso_tierra: number | string | null;
  ind_sin_lavadora: number | string | null;
  ind_sin_refri: number | string | null;
  ind_sin_telfijo: number | string | null;
  ind_sin_celular: number | string | null;
  ind_sin_compu: number | string | null;
  ind_sin_internet: number | string | null;
}

function agebEstabSummarySql(cvegeo: string): string {
  return `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    COUNT(*)::bigint AS total_establecimientos,
    COUNT(*) FILTER (WHERE clase_actividad_id IN (${FARMACIA_CLASES_SQL}))::bigint
      AS total_farmacias
  FROM establecimientos
  WHERE ageb = '${cvegeo}'
) t;
`;
}

function agebTopSectorsSql(cvegeo: string, limit: number): string {
  return `
SELECT json_agg(row_to_json(t) ORDER BY t.count DESC) FROM (
  SELECT
    sector_actividad_id AS scian2,
    COUNT(*)::bigint AS count
  FROM establecimientos
  WHERE ageb = '${cvegeo}' AND sector_actividad_id IS NOT NULL
    AND sector_actividad_id != ''
  GROUP BY sector_actividad_id
  ORDER BY COUNT(*) DESC
  LIMIT ${limit}
) t;
`;
}

function agebCluesSql(cvegeo: string, cap: number): string {
  // `clues` MV: EN OPERACION units only, prebuilt geom with a GiST index
  // (audit #58/#119). Same source as /analytics/municipios unidades_clues.
  return `
SELECT json_agg(row_to_json(t) ORDER BY t.clues) FROM (
  SELECT
    c.clave_clues AS clues,
    c.unidad_nombre AS nombre,
    c.tipo_establecimiento AS tipo,
    c.lat,
    c.lon
  FROM ageb_polygons a
  JOIN clues c ON ST_Contains(a.geom, c.geom)
  WHERE a.cvegeo = '${cvegeo}'
  LIMIT ${cap}
) t;
`;
}

function agebCluesCountSql(cvegeo: string): string {
  // Separate full count so the response can show "120 CLUES, sample of 30".
  return `
SELECT json_build_array(COUNT(*)) FROM (
  SELECT 1
  FROM ageb_polygons a
  JOIN clues c ON ST_Contains(a.geom, c.geom)
  WHERE a.cvegeo = '${cvegeo}'
) t;
`;
}

interface RawAgebDetailPayload {
  id: RawAgebDetailIdentity[] | null;
  loc_meta: RawAgebDetailLocMeta[] | null;
  summary: RawAgebDetailEstabSummary[] | null;
  top_sectors: RawAgebDetailTopSector[] | null;
  clues_sample: RawAgebDetailClues[] | null;
  clues_count: number[] | null;
  census: RawAgebCensusRow[] | null;
  rezago: RawAgebRezagoRow[] | null;
}

function agebDetailSql(cvegeo: string): string {
  // cvegeo pre-validated by CVEGEO_RE.
  // #59: a 9-char rural cvegeo is ENT+MUN+AGEB — it has no LOC segment, so
  // slice(5, 9) would be the AGEB code colliding with an unrelated locality.
  // A rural AGEB has no single containing locality: loc_meta stays null.
  const locMeta =
    cvegeo.length === 9 ? "NULL" : scalarSubquery(agebLocMetaSql(cvegeo));
  return `
SELECT json_build_object(
  'id', ${scalarSubquery(agebIdentitySql(cvegeo))},
  'loc_meta', ${locMeta},
  'summary', ${scalarSubquery(agebEstabSummarySql(cvegeo))},
  'top_sectors', ${scalarSubquery(agebTopSectorsSql(cvegeo, 10))},
  'clues_sample', ${scalarSubquery(agebCluesSql(cvegeo, AGEB_DETAIL_CLUES_CAP))},
  'clues_count', ${scalarSubquery(agebCluesCountSql(cvegeo))},
  'census', ${scalarSubquery(agebCensusSql(cvegeo))},
  'rezago', ${scalarSubquery(agebRezagoSql(cvegeo))}
);
`;
}

/**
 * GET /analytics/ageb-detail?cvegeo=NNNNNNNNNNNNN
 *
 * Full breakdown for one AGEB: identity + geometry + establishment counts +
 * top 10 SCIAN sectors + CLUES sample. Uses the containing locality's
 * population from censo_iter as the closest proxy until census-AGEB lands.
 * Returns 404 if cvegeo is not in `ageb_polygons`.
 */
export async function agebDetailHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cvegeo = c.req.query("cvegeo");
  if (!cvegeo || !CVEGEO_RE.test(cvegeo)) {
    throw new HttpError(
      `cvegeo inválido "${cvegeo ?? ""}". Debe ser 13 chars (urbano: ENT+MUN+LOC+AGEB) o 9 chars (rural: ENT+MUN+AGEB), último char puede ser 0-9 o A-Z.`,
      400,
      "validation.cvegeo",
    );
  }

  // Audit #103: identity + the 7 detail sub-queries run as ONE statement
  // (one psql spawn, one PG backend) instead of 1 blocking + 7 parallel.
  // Every key is json_agg-shaped, so an empty sub-result arrives as null.
  // A null `id` means the cvegeo is not in ageb_polygons -> 404; the detail
  // sub-queries for a missing AGEB are empty index probes.
  // v0.2.4-B: censo_ageb may miss rural AGEBs not in RESAGEBURB urbana.
  // v0.2.6: CONEVAL Grado de Rezago Social ~95% urban AGEB coverage.
  const payload = await runJson<RawAgebDetailPayload>(agebDetailSql(cvegeo), {
    container: config.dbContainer,
  });
  const id = payload.id?.[0];
  if (!id) {
    throw new HttpError(
      `AGEB no encontrada: cvegeo "${cvegeo}".`,
      404,
      "ageb.not_found",
    );
  }
  const locMeta = payload.loc_meta ?? [];
  const summaryRows = payload.summary ?? [];
  const sectors = payload.top_sectors ?? [];
  const cluesSample = payload.clues_sample ?? [];
  const cluesCountRows = payload.clues_count;
  const censusRows = payload.census ?? [];
  const rezagoRows = payload.rezago ?? [];
  const cluesCount = Array.isArray(cluesCountRows)
    ? Number(cluesCountRows[0] ?? 0)
    : 0;
  const censusRow = censusRows[0];
  const rezagoRow = rezagoRows[0];

  // qa-audit S3 (2026-05-05): summary SQL is shaped to ALWAYS return one
  // row (COUNT(*) over a non-empty filter). If we ever see [] here, the SQL
  // shape changed and we'd be silently substituting 0 for missing data —
  // exactly the C1-class shape bug stateCalibratorsHandler defends against.
  // Surface as 502 so the regression is caught loud.
  if (summaryRows.length !== 1) {
    throw new HttpError(
      `analytics: ageb-detail summary returned ${summaryRows.length} rows, expected 1.`,
      502,
      "postgres.unexpected_shape",
    );
  }
  const summary = summaryRows[0];
  const lm = locMeta[0];

  const scianNames = loadScianNames();

  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);

  const result: AgebDetailResult = {
    cvegeo: id.cvegeo,
    cve_ent: id.cve_ent,
    cve_mun: id.cve_mun,
    cve_loc: id.cve_loc,
    cve_ageb: id.cve_ageb,
    ambito: id.ambito === "Urbana" || id.ambito === "Rural" ? id.ambito : null,
    area_km2: num(id.area_km2),
    centroid_lat: num(id.centroid_lat),
    centroid_lon: num(id.centroid_lon),
    bbox:
      id.bbox_minlon !== null &&
      id.bbox_minlat !== null &&
      id.bbox_maxlon !== null &&
      id.bbox_maxlat !== null
        ? [
            Number(id.bbox_minlon),
            Number(id.bbox_minlat),
            Number(id.bbox_maxlon),
            Number(id.bbox_maxlat),
          ]
        : null,
    loc_population:
      lm?.loc_population == null ? null : Number(lm.loc_population),
    loc_name: lm?.loc_name ?? null,
    population: num(censusRow?.pobtot),
    census: censusRow
      ? {
          pobtot: num(censusRow.pobtot),
          pobfem: num(censusRow.pobfem),
          pobmas: num(censusRow.pobmas),
          p_60ymas: num(censusRow.p_60ymas),
          p_15ymas: num(censusRow.p_15ymas),
          p_18ymas: num(censusRow.p_18ymas),
          pea: num(censusRow.pea),
          pocupada: num(censusRow.pocupada),
          graproes: num(censusRow.graproes),
          tvivhab: num(censusRow.tvivhab),
          tvivpar: num(censusRow.tvivpar),
          vph_inter: num(censusRow.vph_inter),
          vph_autom: num(censusRow.vph_autom),
          pder_ss: num(censusRow.pder_ss),
          pder_imss: num(censusRow.pder_imss),
          pder_imssb: num(censusRow.pder_imssb),
          pder_iste: num(censusRow.pder_iste),
          pder_istee: num(censusRow.pder_istee),
          pder_segp: num(censusRow.pder_segp),
          pafil_ipriv: num(censusRow.pafil_ipriv),
          psinder: num(censusRow.psinder),
        }
      : null,
    rezago_social:
      rezagoRow && isRezagoGrado(rezagoRow.grado)
        ? {
            grado: rezagoRow.grado,
            pobtot: num(rezagoRow.pobtot),
            vivpar_hab: num(rezagoRow.vivpar_hab),
            indicators: {
              ind_analfabeta: num(rezagoRow.ind_analfabeta),
              ind_no_escuela_6_14: num(rezagoRow.ind_no_escuela_6_14),
              ind_no_escuela_15_24: num(rezagoRow.ind_no_escuela_15_24),
              ind_basica_incompleta: num(rezagoRow.ind_basica_incompleta),
              ind_sin_salud: num(rezagoRow.ind_sin_salud),
              ind_hacinamiento: num(rezagoRow.ind_hacinamiento),
              ind_sin_agua: num(rezagoRow.ind_sin_agua),
              ind_sin_excusado: num(rezagoRow.ind_sin_excusado),
              ind_sin_drenaje: num(rezagoRow.ind_sin_drenaje),
              ind_sin_luz: num(rezagoRow.ind_sin_luz),
              ind_piso_tierra: num(rezagoRow.ind_piso_tierra),
              ind_sin_lavadora: num(rezagoRow.ind_sin_lavadora),
              ind_sin_refri: num(rezagoRow.ind_sin_refri),
              ind_sin_telfijo: num(rezagoRow.ind_sin_telfijo),
              ind_sin_celular: num(rezagoRow.ind_sin_celular),
              ind_sin_compu: num(rezagoRow.ind_sin_compu),
              ind_sin_internet: num(rezagoRow.ind_sin_internet),
            },
          }
        : null,
    total_establecimientos: Number(summary.total_establecimientos ?? 0),
    total_farmacias: Number(summary.total_farmacias ?? 0),
    top_sectors: sectors.map((s) => ({
      scian2: s.scian2,
      nombre: scianNames.sectors[s.scian2] ?? s.scian2,
      count: Number(s.count),
    })),
    clues_count: cluesCount,
    clues_sample: cluesSample.slice(0, AGEB_DETAIL_CLUES_CAP).map((cl) => ({
      clues: cl.clues,
      nombre: cl.nombre ?? "",
      tipo: cl.tipo ?? "",
      lat: Number(cl.lat ?? 0),
      lon: Number(cl.lon ?? 0),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/ageb-farmacia-opportunity
// ---------------------------------------------------------------------------

interface RawAgebOpportunityRow {
  cvegeo: string;
  ambito: string | null;
  centroid_lat: number | string | null;
  centroid_lon: number | string | null;
  area_km2: number | string | null;
  num_establecimientos: number | string | null;
  num_farmacias: number | string | null;
  num_clues: number | string | null;
  population: number | string | null;
  score: number | string | null;
  score_per_1k: number | string | null;
}

function agebFarmaciaOpportunitySql(cveMun: string, limit: number): string {
  // qa-audit W1 (2026-05-05): json_agg ORDER BY uses the raw score expression
  // — same as the inner ORDER BY — so rounding ties don't reorder rows
  // between the LIMIT cut and the json_agg pass. Otherwise two AGEBs whose
  // raw scores differ in the 4th decimal but round to the same 3-decimal
  // `score` value can end up in arbitrary order in the response.
  // v0.2.4-B: LEFT JOIN censo_ageb adds AGEB-level population + score_per_1k
  // (raw score normalized to opportunity per 1000 residents). Rural AGEBs
  // not in RESAGEBURB get population=NULL and score_per_1k=NULL.
  return `
SELECT json_agg(row_to_json(t) ORDER BY (
  t.num_clues * 0.5 + t.num_establecimientos * 0.3 - t.num_farmacias * 1.0
) DESC NULLS LAST, t.cvegeo) FROM (
  SELECT
    a.cvegeo,
    NULLIF(TRIM(a.ambito), '') AS ambito,
    ST_Y(ST_Centroid(a.geom))::numeric(10,6) AS centroid_lat,
    ST_X(ST_Centroid(a.geom))::numeric(10,6) AS centroid_lon,
    ROUND((ST_Area(a.geom::geography) / 1000000)::numeric, 4) AS area_km2,
    COALESCE(e.cnt, 0)::bigint AS num_establecimientos,
    COALESCE(f.cnt, 0)::bigint AS num_farmacias,
    COALESCE(s.cnt, 0)::bigint AS num_clues,
    cab.pobtot AS population,
    ROUND(
      (COALESCE(s.cnt, 0) * 0.5
       + COALESCE(e.cnt, 0) * 0.3
       - COALESCE(f.cnt, 0) * 1.0)::numeric,
      3
    ) AS score,
    CASE
      WHEN cab.pobtot IS NULL OR cab.pobtot = 0 THEN NULL
      ELSE ROUND(
        ((COALESCE(s.cnt, 0) * 0.5
          + COALESCE(e.cnt, 0) * 0.3
          - COALESCE(f.cnt, 0) * 1.0) * 1000.0
         / cab.pobtot)::numeric,
        3
      )
    END AS score_per_1k
  FROM ageb_polygons a
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE ${agebOfMunicipioSql(cveMun)} AND ageb IS NOT NULL AND ageb != ''
    GROUP BY ageb
  ) e ON e.ageb = a.cvegeo
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE ${agebOfMunicipioSql(cveMun)} AND ageb IS NOT NULL AND ageb != ''
      AND clase_actividad_id IN (${FARMACIA_CLASES_SQL})
    GROUP BY ageb
  ) f ON f.ageb = a.cvegeo
  LEFT JOIN (
    SELECT a2.cvegeo, COUNT(*) AS cnt
    FROM ageb_polygons a2
    JOIN clues c ON ST_Contains(a2.geom, c.geom)
    WHERE a2.cve_ent = '${cveMun.slice(0, 2)}' AND a2.cve_mun = '${cveMun.slice(2)}'
    GROUP BY a2.cvegeo
  ) s ON s.cvegeo = a.cvegeo
  LEFT JOIN censo_ageb cab ON cab.cvegeo = a.cvegeo
  WHERE a.cve_ent = '${cveMun.slice(0, 2)}' AND a.cve_mun = '${cveMun.slice(2)}'
  ORDER BY (
    COALESCE(s.cnt, 0) * 0.5
    + COALESCE(e.cnt, 0) * 0.3
    - COALESCE(f.cnt, 0) * 1.0
  ) DESC NULLS LAST, a.cvegeo
  LIMIT ${limit}
) t;
`;
}

/**
 * GET /analytics/ageb-farmacia-opportunity?cve_mun=NNNNN[&limit=N]
 *
 * Ranks AGEBs in a municipio by a coarse demand-minus-supply opportunity
 * score: (CLUES × 0.5 + establecimientos × 0.3 − farmacias × 1.0). Score
 * units are arbitrary; use rank, not absolute. v0.2.4-B added population
 * + score_per_1k for the population-normalized variant — null on rural
 * AGEBs not in RESAGEBURB urbana.
 */
export async function agebFarmaciaOpportunityHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded.`,
      400,
      "validation.cve_mun",
    );
  }
  const limitRaw = c.req.query("limit");
  let limit = AGEB_FARMACIA_DEFAULT_LIMIT;
  if (limitRaw !== undefined && limitRaw !== "") {
    const parsed = Number(limitRaw);
    if (
      !Number.isInteger(parsed) ||
      parsed < 1 ||
      parsed > AGEB_FARMACIA_MAX_LIMIT
    ) {
      throw new HttpError(
        `limit inválido "${limitRaw}". Debe ser entero entre 1 y ${AGEB_FARMACIA_MAX_LIMIT}.`,
        400,
        "validation.limit",
      );
    }
    limit = parsed;
  }

  const rows = await runJson<RawAgebOpportunityRow[]>(
    agebFarmaciaOpportunitySql(cveMun, limit),
    { container: config.dbContainer },
  );
  const result: AgebFarmaciaOpportunityResult = {
    cve_mun: cveMun,
    total_returned: rows.length,
    agebs: rows.map((r) => ({
      cvegeo: r.cvegeo,
      ambito: r.ambito === "Urbana" || r.ambito === "Rural" ? r.ambito : null,
      centroid_lat: r.centroid_lat === null ? null : Number(r.centroid_lat),
      centroid_lon: r.centroid_lon === null ? null : Number(r.centroid_lon),
      area_km2: r.area_km2 === null ? null : Number(r.area_km2),
      num_establecimientos: Number(r.num_establecimientos ?? 0),
      num_farmacias: Number(r.num_farmacias ?? 0),
      num_clues: Number(r.num_clues ?? 0),
      score: Number(r.score ?? 0),
      population: r.population == null ? null : Number(r.population),
      score_per_1k: r.score_per_1k == null ? null : Number(r.score_per_1k),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ===========================================================================
// v0.2.5 — Generic opportunity engine (vertical-agnostic)
//
// Generalizes v0.2.4's farmacia-specific opportunity scoring. Operator passes
// `target_scian` (comma-separated SCIAN codes, all same length 2-6) and the
// handler dispatches to the matching `*_actividad_id` column.
//
// Semantic difference vs v0.2.4 ageb-farmacia-opportunity:
//   - target_count / total_estab / pobtot are exposed RAW for the operator
//     to interpret. The default `score` is `pobtot / NULLIF(target_count, 0)`
//     (population per existing competitor — higher = more underserved).
//   - No CLUES weight (v0.2.4-only signal — health-vertical specific). Verticals
//     that want CLUES proximity still use the farmacia endpoint.
//   - `score` is NULL when target_count = 0 (greenfield — sort by pobtot to find).
// ===========================================================================

/**
 * Parse + validate the comma-separated `target_scian` query param.
 *
 * Rules enforced (exhaustive — every other validation site relies on this):
 *   1. List-shape regex: only digits + commas, no whitespace, no empty parts.
 *   2. ≤ TARGET_SCIAN_MAX_CODES (10) elements after the split.
 *   3. Each element is 2-6 digits.
 *   4. ALL elements share the same length within a single call. Mixed
 *      lengths reject because the dispatch column depends on length.
 *
 * Returns the parsed codes plus the SCIAN level (column suffix used in SQL).
 * Throws HttpError(400) on any rule violation.
 *
 * Why same-length: the SCIAN hierarchy is `46 / 461 / 4611 / 46111 / 461110`
 * — each prefix is a different column in `establecimientos`. Mixing levels
 * would require multiple `OR` clauses across columns, which is solvable but
 * doubles the test surface and complicates index selection. v0.2.5 punts.
 */
function parseTargetScian(raw: string | undefined): {
  codes: string[];
  level: ScianLevel;
  column: string;
} {
  if (!raw) {
    throw new HttpError(
      `target_scian es requerido. Pasa una o más claves SCIAN separadas por coma (mismo nivel, p.ej. "464111,464112").`,
      400,
      "validation.target_scian",
    );
  }
  if (!TARGET_SCIAN_LIST_RE.test(raw)) {
    throw new HttpError(
      `target_scian inválido "${raw}". Debe ser dígitos separados por coma, sin espacios.`,
      400,
      "validation.target_scian",
    );
  }
  const codes = raw.split(",");
  if (codes.length > TARGET_SCIAN_MAX_CODES) {
    throw new HttpError(
      `target_scian acepta máximo ${TARGET_SCIAN_MAX_CODES} claves; recibí ${codes.length}.`,
      400,
      "validation.target_scian",
    );
  }
  for (const code of codes) {
    if (!SCIAN_CODE_RE.test(code)) {
      throw new HttpError(
        `target_scian: clave "${code}" inválida. Cada elemento debe ser 2-6 dígitos.`,
        400,
        "validation.target_scian",
      );
    }
  }
  const len = codes[0].length;
  for (const code of codes) {
    if (code.length !== len) {
      throw new HttpError(
        `target_scian: todas las claves deben tener la misma longitud. Mezclaste ${len} y ${code.length} dígitos.`,
        400,
        "validation.target_scian",
      );
    }
  }
  // Length → column dispatch. SCIAN hierarchy in establecimientos.
  let level: ScianLevel;
  let column: string;
  switch (len) {
    case 2:
      level = "sector";
      column = "sector_actividad_id";
      break;
    case 3:
      level = "subsector";
      column = "subsector_actividad_id";
      break;
    case 4:
      level = "rama";
      column = "rama_actividad_id";
      break;
    case 5:
      level = "subrama";
      column = "subrama_actividad_id";
      break;
    case 6:
      level = "clase";
      column = "clase_actividad_id";
      break;
    default:
      // Unreachable given SCIAN_CODE_RE — defensive only.
      throw new HttpError(
        `target_scian: longitud ${len} no soportada (esperaba 2-6).`,
        400,
        "validation.target_scian",
      );
  }
  return { codes, level, column };
}

/**
 * Parse the optional `rezago_grado` query param into a typed list.
 *
 * Format: comma-separated grado names (any of the 5 CONEVAL ordinal levels).
 * Spaces in "Muy bajo" / "Muy alto" must come URL-decoded already (Hono
 * parses query strings, so `?rezago_grado=Muy%20bajo` arrives as "Muy bajo").
 *
 * Empty / undefined / whitespace-only → returns []. The handler treats an
 * empty filter as "no constraint" and skips the WHERE clause entirely. This
 * keeps the legacy v0.2.5 contract intact (no rezago filter = same query).
 *
 * Throws HttpError(400) on:
 *   - Any element not in REZAGO_GRADOS (catches typos / SQL-injection attempts)
 *   - Duplicate elements (probably a copy-paste error worth surfacing)
 *
 * v0.2.6 addition.
 */
function parseRezagoGradoFilter(raw: string | undefined): RezagoGrado[] {
  if (!raw || raw.trim() === "") return [];
  const parts = raw.split(",").map((p) => p.trim());
  const seen = new Set<string>();
  const out: RezagoGrado[] = [];
  for (const part of parts) {
    if (!isRezagoGrado(part)) {
      throw new HttpError(
        `rezago_grado: valor inválido "${part}". Valores válidos: ${REZAGO_GRADOS.join(", ")}.`,
        400,
        "validation.rezago_grado",
      );
    }
    if (seen.has(part)) {
      throw new HttpError(
        `rezago_grado: valor duplicado "${part}".`,
        400,
        "validation.rezago_grado",
      );
    }
    seen.add(part);
    out.push(part);
  }
  return out;
}

/**
 * Validate + parse the limit param against the per-endpoint default/max.
 * Returns the resolved limit. Throws HttpError(400) on bad input.
 */
function parseLimit(
  raw: string | undefined,
  defaultLimit: number,
  maxLimit: number,
): number {
  if (raw === undefined || raw === "") return defaultLimit;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > maxLimit) {
    throw new HttpError(
      `limit inválido "${raw}". Debe ser entero entre 1 y ${maxLimit}.`,
      400,
      "validation.limit",
    );
  }
  return parsed;
}

interface RawOpportunityAgebRow {
  cvegeo: string;
  ambito: string | null;
  centroid_lat: string | number | null;
  centroid_lon: string | number | null;
  area_km2: string | number | null;
  pobtot: string | number | null;
  target_count: string | number | null;
  total_estab: string | number | null;
  score: string | number | null;
  rezago_grado: string | null;
  pct_sin_cobertura_salud: string | number | null;
  casos_dm2_muni: string | number | null;
  casos_hta_muni: string | number | null;
  casos_obesidad_muni: string | number | null;
}

function opportunityByAgebSql(
  cveMun: string,
  scianColumn: string,
  scianCodes: string[],
  orderBy: OpportunityAgebOrderBy,
  limit: number,
  rezagoFilter: RezagoGrado[],
  sinbaRel: SinbaMorbidityRel,
): string {
  // Validation upstream guarantees `scianColumn` is one of 5 known columns,
  // `scianCodes` are all `\d{2,6}`, and `rezagoFilter` entries are all from
  // the REZAGO_GRADOS allowlist. We still defense-in-depth single-quote
  // every literal (SCIAN codes are TEXT in DENUE — '46' lexicographically
  // ≠ 46 the int; rezago grados contain spaces so quoting is mandatory).
  const inList = scianCodes.map((c) => `'${c}'`).join(",");
  // qa-audit W1 (2026-05-05): wrap pobtot in NULLIF(_, 0) so AGEBs with
  // censused-but-empty population (pobtot=0) collapse to NULL in the score
  // ranking, matching the inner CASE that returns NULL for the same input.
  // Without this, pobtot=0 AGEBs sort as score=0 (above rural NULL rows)
  // while their payload `score` is NULL — order disagrees with payload.
  const orderExpr =
    orderBy === "score"
      ? "(NULLIF(cab.pobtot, 0)::numeric / NULLIF(COALESCE(t.cnt, 0), 0)) DESC NULLS LAST"
      : orderBy === "pobtot"
        ? "cab.pobtot DESC NULLS LAST"
        : orderBy === "target_count"
          ? "COALESCE(t.cnt, 0) DESC"
          : /* total_estab */ "COALESCE(e.cnt, 0) DESC";
  // v0.2.6: optional CONEVAL Grado de Rezago Social filter. Always JOIN to
  // surface `rezago_grado` in the row payload (so operator sees the rezago
  // context for free); only WHERE-filter when the request actually narrows.
  const rezagoWhere =
    rezagoFilter.length === 0
      ? ""
      : `AND cga.grado IN (${rezagoFilter.map((g) => `'${g}'`).join(",")})\n  `;
  return `
SELECT json_agg(row_to_json(r) ORDER BY ${orderExpr
    .replace(/cab\.pobtot/g, "r.pobtot")
    .replace(/COALESCE\(t\.cnt, 0\)/g, "r.target_count")
    .replace(/COALESCE\(e\.cnt, 0\)/g, "r.total_estab")}, r.cvegeo) FROM (
  SELECT
    a.cvegeo,
    NULLIF(TRIM(a.ambito), '') AS ambito,
    ST_Y(ST_Centroid(a.geom))::numeric(10,6) AS centroid_lat,
    ST_X(ST_Centroid(a.geom))::numeric(10,6) AS centroid_lon,
    ROUND((ST_Area(a.geom::geography) / 1000000)::numeric, 4) AS area_km2,
    cab.pobtot AS pobtot,
    COALESCE(t.cnt, 0)::bigint AS target_count,
    COALESCE(e.cnt, 0)::bigint AS total_estab,
    CASE
      WHEN cab.pobtot IS NULL OR cab.pobtot = 0 THEN NULL
      WHEN COALESCE(t.cnt, 0) = 0 THEN NULL
      ELSE ROUND((cab.pobtot::numeric / t.cnt)::numeric, 2)
    END AS score,
    cga.grado AS rezago_grado,
    CASE
      WHEN cab.pobtot IS NULL OR cab.pobtot = 0 THEN NULL
      WHEN cab.psinder IS NULL THEN NULL
      ELSE ROUND((cab.psinder::numeric / cab.pobtot * 100)::numeric, 1)
    END AS pct_sin_cobertura_salud,
    smm.casos_dm2_promedio AS casos_dm2_muni,
    smm.casos_hta_promedio AS casos_hta_muni,
    smm.casos_obesidad_promedio AS casos_obesidad_muni
  FROM ageb_polygons a
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE ${agebOfMunicipioSql(cveMun)} AND ageb IS NOT NULL AND ageb != ''
    GROUP BY ageb
  ) e ON e.ageb = a.cvegeo
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE ${agebOfMunicipioSql(cveMun)} AND ageb IS NOT NULL AND ageb != ''
      AND ${scianColumn} IN (${inList})
    GROUP BY ageb
  ) t ON t.ageb = a.cvegeo
  LEFT JOIN censo_ageb cab ON cab.cvegeo = a.cvegeo
  LEFT JOIN coneval_grs_ageb cga ON cga.cvegeo = a.cvegeo
  -- v0.2.7: muni-level SINBA morbidity. Same value broadcasts to every AGEB
  -- in the muni. Most-recent year only so multi-year SINBA loads don't
  -- double-count. 2023 is the latest publicly available SINBA bulk.
  -- Audit #140: DISTINCT ON over the MV, not a MAX() subquery over the view.
  LEFT JOIN (
    SELECT DISTINCT ON (cve_mun)
      cve_mun, casos_dm2_promedio, casos_hta_promedio, casos_obesidad_promedio
    FROM ${sinbaRel}
    WHERE cve_mun = '${cveMun}'
    ORDER BY cve_mun, anio DESC
  ) smm ON true
  WHERE a.cve_ent = '${cveMun.slice(0, 2)}' AND a.cve_mun = '${cveMun.slice(2)}'
  ${rezagoWhere}ORDER BY ${orderExpr}, a.cvegeo
  LIMIT ${limit}
) r;
`;
}

/**
 * GET /analytics/opportunity-by-ageb
 *   ?cve_mun=NNNNN
 *   &target_scian=NNNN[NN][,NNNN[NN]…]   (required)
 *   &order_by=score|pobtot|target_count|total_estab   (default: score)
 *   &limit=20                              (max 100)
 *
 * Vertical-agnostic AGEB-level opportunity ranking. Replaces the farmacia-
 * specific v0.2.4 endpoint for any establishment class. For health-specific
 * (CLUES-aware) scoring use /analytics/ageb-farmacia-opportunity.
 *
 * Score = pobtot / NULLIF(target_count, 0) → "people per existing competitor."
 * Higher = more underserved. NULL when target_count=0 (greenfield — sort by
 * pobtot DESC to surface), pobtot is NULL (rural AGEB not in censo_ageb
 * urbana), or pobtot=0 (urban AGEB the census found empty/abandoned).
 */
export async function opportunityByAgebHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded.`,
      400,
      "validation.cve_mun",
    );
  }
  const { codes, level, column } = parseTargetScian(
    c.req.query("target_scian"),
  );

  const orderByRaw = c.req.query("order_by") ?? "score";
  if (
    !OPPORTUNITY_AGEB_ORDER_BY.includes(orderByRaw as OpportunityAgebOrderBy)
  ) {
    throw new HttpError(
      `order_by inválido "${orderByRaw}". Valores válidos: ${OPPORTUNITY_AGEB_ORDER_BY.join(", ")}.`,
      400,
      "validation.order_by",
    );
  }
  const orderBy = orderByRaw as OpportunityAgebOrderBy;
  const limit = parseLimit(
    c.req.query("limit"),
    OPPORTUNITY_AGEB_DEFAULT_LIMIT,
    OPPORTUNITY_AGEB_MAX_LIMIT,
  );
  const rezagoFilter = parseRezagoGradoFilter(c.req.query("rezago_grado"));

  const rows = await runJsonQueryMvFirst<RawOpportunityAgebRow[]>(
    config,
    opportunityByAgebSql(
      cveMun,
      column,
      codes,
      orderBy,
      limit,
      rezagoFilter,
      SINBA_MORBIDITY_MV,
    ),
    opportunityByAgebSql(
      cveMun,
      column,
      codes,
      orderBy,
      limit,
      rezagoFilter,
      SINBA_MORBIDITY_VIEW,
    ),
  );
  const result: OpportunityByAgebResult = {
    cve_mun: cveMun,
    scian_level: level,
    target_scian: codes,
    order_by: orderBy,
    rezago_grado_filter: rezagoFilter,
    total_returned: rows.length,
    agebs: rows.map((r) => ({
      cvegeo: r.cvegeo,
      ambito: r.ambito === "Urbana" || r.ambito === "Rural" ? r.ambito : null,
      centroid_lat: r.centroid_lat == null ? null : Number(r.centroid_lat),
      centroid_lon: r.centroid_lon == null ? null : Number(r.centroid_lon),
      area_km2: r.area_km2 == null ? null : Number(r.area_km2),
      pobtot: r.pobtot == null ? null : Number(r.pobtot),
      target_count: Number(r.target_count ?? 0),
      total_estab: Number(r.total_estab ?? 0),
      score: r.score == null ? null : Number(r.score),
      rezago_grado: isRezagoGrado(r.rezago_grado) ? r.rezago_grado : null,
      pct_sin_cobertura_salud:
        r.pct_sin_cobertura_salud == null
          ? null
          : Number(r.pct_sin_cobertura_salud),
      casos_dm2_muni:
        r.casos_dm2_muni == null ? null : Number(r.casos_dm2_muni),
      casos_hta_muni:
        r.casos_hta_muni == null ? null : Number(r.casos_hta_muni),
      casos_obesidad_muni:
        r.casos_obesidad_muni == null ? null : Number(r.casos_obesidad_muni),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

interface RawOpportunityColoniaRow {
  colonia: string | null;
  target_count: string | number | null;
  total_estab: string | number | null;
  score: string | number | null;
}

function opportunityByColoniaSql(
  cveMun: string,
  scianColumn: string,
  scianCodes: string[],
  orderBy: OpportunityColoniaOrderBy,
  limit: number,
): string {
  const inList = scianCodes.map((c) => `'${c}'`).join(",");
  // SQL aliases for aggregate expressions don't reliably resolve inside the
  // expressions of an ORDER BY clause at the same SELECT level (Postgres
  // raises "column X does not exist" when the alias is wrapped in another
  // expression like `total_estab::numeric / NULLIF(target_count, 0)`).
  // Workaround: write the underlying SUM/COUNT expressions verbatim in the
  // INNER ORDER BY, and use `r.<alias>` for the OUTER json_agg ORDER BY
  // (table-qualified subquery refs always resolve). 2026-05-05 production
  // smoke caught this — unit tests mock psql so the bug only surfaces live.
  const targetCountExpr = `SUM(CASE WHEN ${scianColumn} IN (${inList}) THEN 1 ELSE 0 END)`;
  const totalEstabExpr = `COUNT(*)`;
  // #70: every numeric order carries a colonia tiebreak so LIMIT keeps a
  // deterministic set of tied rows.
  const innerOrderExpr =
    orderBy === "score"
      ? `(${totalEstabExpr}::numeric / NULLIF(${targetCountExpr}, 0)) DESC NULLS LAST, UPPER(TRIM(colonia)) ASC`
      : orderBy === "target_count"
        ? `${targetCountExpr} DESC, UPPER(TRIM(colonia)) ASC`
        : orderBy === "total_estab"
          ? `${totalEstabExpr} DESC, UPPER(TRIM(colonia)) ASC`
          : /* colonia */ "UPPER(TRIM(colonia)) ASC";
  const outerOrderExpr =
    orderBy === "score"
      ? "(r.total_estab::numeric / NULLIF(r.target_count, 0)) DESC NULLS LAST, r.colonia ASC"
      : orderBy === "target_count"
        ? "r.target_count DESC, r.colonia ASC"
        : orderBy === "total_estab"
          ? "r.total_estab DESC, r.colonia ASC"
          : /* colonia */ "r.colonia ASC";
  return `
SELECT json_agg(row_to_json(r) ORDER BY ${outerOrderExpr}) FROM (
  SELECT
    UPPER(TRIM(colonia)) AS colonia,
    ${targetCountExpr}::bigint AS target_count,
    ${totalEstabExpr}::bigint AS total_estab,
    CASE
      WHEN ${targetCountExpr} = 0 THEN NULL
      ELSE ROUND(
        (${totalEstabExpr}::numeric / ${targetCountExpr})::numeric,
        2
      )
    END AS score
  FROM establecimientos
  WHERE area_geo = '${cveMun}'
    AND colonia IS NOT NULL
    AND TRIM(colonia) != ''
  GROUP BY UPPER(TRIM(colonia))
  ORDER BY ${innerOrderExpr}
  LIMIT ${limit}
) r;
`;
}

/**
 * GET /analytics/opportunity-by-colonia
 *   ?cve_mun=NNNNN
 *   &target_scian=NNNN[NN][,NNNN[NN]…]
 *   &order_by=score|target_count|total_estab|colonia
 *   &limit=50  (max 200)
 *
 * Colonia-level supply-side ranking. Score = total_estab / target_count
 * (activity per existing target competitor — higher = more market activity
 * per competitor). NULL when target_count=0 (greenfield colonia).
 *
 * Less robust than AGEB-level because:
 *   - colonia is free-text (different DENUE rows can write the same colonia
 *     differently — "ROMA NORTE" vs "Roma Norte"). We UPPER+TRIM to fold
 *     casing; spelling drift is unfixable here.
 *   - No population denominator (colonia has no census mapping).
 *
 * Use AGEB-level when you need population-normalized comparisons.
 */
export async function opportunityByColoniaHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded.`,
      400,
      "validation.cve_mun",
    );
  }
  const { codes, level, column } = parseTargetScian(
    c.req.query("target_scian"),
  );

  const orderByRaw = c.req.query("order_by") ?? "score";
  if (
    !OPPORTUNITY_COLONIA_ORDER_BY.includes(
      orderByRaw as OpportunityColoniaOrderBy,
    )
  ) {
    throw new HttpError(
      `order_by inválido "${orderByRaw}". Valores válidos: ${OPPORTUNITY_COLONIA_ORDER_BY.join(", ")}.`,
      400,
      "validation.order_by",
    );
  }
  const orderBy = orderByRaw as OpportunityColoniaOrderBy;
  const limit = parseLimit(
    c.req.query("limit"),
    OPPORTUNITY_COLONIA_DEFAULT_LIMIT,
    OPPORTUNITY_COLONIA_MAX_LIMIT,
  );

  const rows = await runJson<RawOpportunityColoniaRow[]>(
    opportunityByColoniaSql(cveMun, column, codes, orderBy, limit),
    { container: config.dbContainer },
  );
  const colonias = rows
    .filter((r): r is RawOpportunityColoniaRow & { colonia: string } =>
      Boolean(r.colonia),
    )
    .map((r) => ({
      colonia: r.colonia,
      target_count: Number(r.target_count ?? 0),
      total_estab: Number(r.total_estab ?? 0),
      score: r.score == null ? null : Number(r.score),
    }));
  const result: OpportunityByColoniaResult = {
    cve_mun: cveMun,
    scian_level: level,
    target_scian: codes,
    order_by: orderBy,
    total_returned: colonias.length,
    colonias,
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

interface RawColoniaListRow {
  colonia: string | null;
  num_establecimientos: string | number | null;
}

function coloniasByMunicipioSql(
  cveMun: string,
  orderBy: ColoniasOrderBy,
  limit: number,
): string {
  const orderExpr =
    orderBy === "num_establecimientos"
      ? "num_establecimientos DESC, colonia ASC" // #70: tiebreak under LIMIT
      : /* colonia */ "colonia ASC";
  return `
SELECT json_agg(row_to_json(r) ORDER BY ${orderExpr}) FROM (
  SELECT
    UPPER(TRIM(colonia)) AS colonia,
    COUNT(*)::bigint AS num_establecimientos
  FROM establecimientos
  WHERE area_geo = '${cveMun}'
    AND colonia IS NOT NULL
    AND TRIM(colonia) != ''
  GROUP BY UPPER(TRIM(colonia))
  ORDER BY ${orderExpr}
  LIMIT ${limit}
) r;
`;
}

/**
 * GET /analytics/colonias-by-municipio
 *   ?cve_mun=NNNNN
 *   &order_by=num_establecimientos|colonia   (default: num_establecimientos)
 *   &limit=50  (max 200)
 *
 * Primitive listing of colonias in a municipio with total establecimientos
 * count. Pre-step for `/analytics/opportunity-by-colonia` — operator picks
 * a colonia from this list, then drills in with a target_scian query.
 *
 * Sister of `/analytics/agebs-by-municipio` for the colonia level.
 */
export async function coloniasByMunicipioHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded.`,
      400,
      "validation.cve_mun",
    );
  }

  const orderByRaw = c.req.query("order_by") ?? "num_establecimientos";
  if (!COLONIAS_ORDER_BY.includes(orderByRaw as ColoniasOrderBy)) {
    throw new HttpError(
      `order_by inválido "${orderByRaw}". Valores válidos: ${COLONIAS_ORDER_BY.join(", ")}.`,
      400,
      "validation.order_by",
    );
  }
  const orderBy = orderByRaw as ColoniasOrderBy;
  const limit = parseLimit(
    c.req.query("limit"),
    COLONIAS_DEFAULT_LIMIT,
    COLONIAS_MAX_LIMIT,
  );

  const rows = await runJson<RawColoniaListRow[]>(
    coloniasByMunicipioSql(cveMun, orderBy, limit),
    { container: config.dbContainer },
  );
  const colonias = rows
    .filter((r): r is RawColoniaListRow & { colonia: string } =>
      Boolean(r.colonia),
    )
    .map((r) => ({
      colonia: r.colonia,
      num_establecimientos: Number(r.num_establecimientos ?? 0),
    }));
  const result: ColoniasByMunicipioResult = {
    cve_mun: cveMun,
    order_by: orderBy,
    total_returned: colonias.length,
    colonias,
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// COFEPRIS licensed pharmacies (v0.2.8)
// ---------------------------------------------------------------------------

/**
 * GET /analytics/licensed-pharmacies-by-municipio?cve_mun=NNNNN
 *
 * Surface COFEPRIS Padrón counts per municipio. The view
 * `cofepris_farmacias_by_municipio` only counts Vigente licenses (Suspendida
 * / Cancelada are historical noise). Returns zeroes when the muni has no
 * geocoded licensed pharmacies — better than 404 because the operator's
 * follow-up question is "and what classes?" not "does this muni exist?".
 *
 * The 6 controlados-class flags are independent (a single license commonly
 * covers Estupefacientes + Psicotrópicos + Vacunas + Sueros + Hemoderivados
 * — these aren't mutually exclusive). For "active competition for the
 * highest-margin SKU", read `con_estupefacientes`.
 */
export async function licensedPharmaciesByMunicipioHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded.`,
      400,
      "validation.cve_mun",
    );
  }

  const sql = `
SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM (
  SELECT
    cve_mun,
    total_licenciadas,
    con_estupefacientes,
    con_psicotropicos,
    con_vacunas,
    con_toxoides,
    con_sueros_antitoxinas,
    con_hemoderivados,
    hospitalarias,
    boticas,
    droguerias
  FROM cofepris_farmacias_by_municipio
  WHERE cve_mun = '${cveMun}'
) r;
`;
  const rows = await runJson<
    Array<{
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
    }>
  >(sql, { container: config.dbContainer });
  const row = rows[0];
  const result: LicensedPharmaciesByMunicipioResult = row
    ? {
        cve_mun: row.cve_mun,
        total_licenciadas: Number(row.total_licenciadas ?? 0),
        con_estupefacientes: Number(row.con_estupefacientes ?? 0),
        con_psicotropicos: Number(row.con_psicotropicos ?? 0),
        con_vacunas: Number(row.con_vacunas ?? 0),
        con_toxoides: Number(row.con_toxoides ?? 0),
        con_sueros_antitoxinas: Number(row.con_sueros_antitoxinas ?? 0),
        con_hemoderivados: Number(row.con_hemoderivados ?? 0),
        hospitalarias: Number(row.hospitalarias ?? 0),
        boticas: Number(row.boticas ?? 0),
        droguerias: Number(row.droguerias ?? 0),
      }
    : {
        cve_mun: cveMun,
        total_licenciadas: 0,
        con_estupefacientes: 0,
        con_psicotropicos: 0,
        con_vacunas: 0,
        con_toxoides: 0,
        con_sueros_antitoxinas: 0,
        con_hemoderivados: 0,
        hospitalarias: 0,
        boticas: 0,
        droguerias: 0,
      };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

/**
 * GET /analytics/licensed-pharmacies-by-ageb?cvegeo=NNNNNNNNNNNNN
 *
 * AGEB-grain counterpart to `/licensed-pharmacies-by-municipio`. Sub-municipal
 * variant for site-selection: combine with `/opportunity-by-ageb` to find AGEBs
 * with high underserved demand AND zero licensed-controlados competitors.
 *
 * Returns zeroes when the AGEB has no geocoded licensed pharmacy — same
 * convention as the muni endpoint. With 92.3% geocoding coverage, ~7.7% of
 * COFEPRIS rows fall into the unmatched bucket and contribute to no AGEB count;
 * those farmacias surface only at country/state granularity.
 */
export async function licensedPharmaciesByAgebHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cvegeo = c.req.query("cvegeo");
  if (!cvegeo || !CVEGEO_RE.test(cvegeo)) {
    throw new HttpError(
      `cvegeo inválido "${cvegeo ?? ""}". Debe ser 13 chars (urbano) o 9 chars (rural), último char puede ser dígito o letra mayúscula.`,
      400,
      "validation.cvegeo",
    );
  }

  const sql = `
SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM (
  SELECT cvegeo_ageb AS cvegeo, total_licenciadas, con_controlados
  FROM cofepris_farmacias_by_ageb
  WHERE cvegeo_ageb = '${cvegeo}'
) r;
`;
  const rows = await runJson<
    Array<{
      cvegeo: string;
      total_licenciadas: number;
      con_controlados: number;
    }>
  >(sql, { container: config.dbContainer });
  const row = rows[0];
  const result: LicensedPharmaciesByAgebResult = row
    ? {
        cvegeo: row.cvegeo,
        total_licenciadas: Number(row.total_licenciadas ?? 0),
        con_controlados: Number(row.con_controlados ?? 0),
      }
    : {
        cvegeo,
        total_licenciadas: 0,
        con_controlados: 0,
      };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// Sub-AGEB drilldown (v0.2.9) — closes Jarvis's §4.5 "AGEB → operational" gap
// ---------------------------------------------------------------------------

/**
 * GET /analytics/manzanas-by-ageb?cvegeo=NNNNNNNNNNNNN
 *   &order_by=pobtot|tvivpar|vph_inter   (default: pobtot)
 *   &limit=30                            (max 200)
 *
 * After /opportunity-by-ageb surfaces a target AGEB, this drills into the
 * city blocks (manzanas) inside it. INEGI's manzana grain is 1.6M nationally;
 * a typical urban AGEB contains 10-50 manzanas with population 0-200 each.
 *
 * Manzanas with `mza='000'` (the AGEB-aggregate row) and `mza='*'` (suppressed)
 * are excluded by the censo_manzana view. Per-block pobtot/tvivpar/vph_*
 * NULLs come through as INEGI confidentiality suppression (LSNIEG art. 37 —
 * blocks with <3 dwellings get nulled to prevent reidentification).
 *
 * For "pick the densest block to lease space," sort by pobtot. For "pick
 * higher-income blocks," sort by vph_inter (households with internet
 * = strongest non-income proxy in INEGI manzana data).
 */
export async function manzanasByAgebHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cvegeo = c.req.query("cvegeo");
  if (!cvegeo || !CVEGEO_RE.test(cvegeo)) {
    throw new HttpError(
      `cvegeo inválido "${cvegeo ?? ""}". Debe ser 13 chars (urbano) o 9 chars (rural), último char puede ser dígito o letra mayúscula.`,
      400,
      "validation.cvegeo",
    );
  }
  // #73: censo_manzana.cvegeo_ageb is always the 13-char urban key, so a
  // 9-char rural AGEB could only ever return a misleading empty 200.
  if (cvegeo.length === 9) {
    throw new HttpError(
      `cvegeo "${cvegeo}" es un AGEB rural: los datos por manzana solo existen para AGEBs urbanas (13 chars).`,
      400,
      "validation.cvegeo_rural_no_manzanas",
    );
  }

  const orderByRaw = c.req.query("order_by") ?? "pobtot";
  if (!MANZANAS_ORDER_BY.includes(orderByRaw as ManzanasOrderBy)) {
    throw new HttpError(
      `order_by inválido "${orderByRaw}". Valores válidos: ${MANZANAS_ORDER_BY.join(", ")}.`,
      400,
      "validation.order_by",
    );
  }
  const orderBy = orderByRaw as ManzanasOrderBy;
  const limit = parseLimit(
    c.req.query("limit"),
    MANZANAS_DEFAULT_LIMIT,
    MANZANAS_MAX_LIMIT,
  );

  const sql = `
SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM (
  SELECT
    cvegeo_ageb || mza AS cvegeo_mza,
    mza,
    pobtot, pobfem, pobmas,
    tvivpar, vph_inter, vph_autom
  FROM censo_manzana
  WHERE cvegeo_ageb = '${cvegeo}'
  ORDER BY ${orderBy} DESC NULLS LAST, mza ASC
  LIMIT ${limit}
) r;
`;
  const rows = await runJson<
    Array<{
      cvegeo_mza: string;
      mza: string;
      pobtot: number | null;
      pobfem: number | null;
      pobmas: number | null;
      tvivpar: number | null;
      vph_inter: number | null;
      vph_autom: number | null;
    }>
  >(sql, { container: config.dbContainer });

  const manzanas = rows.map((r) => ({
    cvegeo_mza: r.cvegeo_mza,
    mza: r.mza,
    pobtot: r.pobtot === null ? null : Number(r.pobtot),
    pobfem: r.pobfem === null ? null : Number(r.pobfem),
    pobmas: r.pobmas === null ? null : Number(r.pobmas),
    tvivpar: r.tvivpar === null ? null : Number(r.tvivpar),
    vph_inter: r.vph_inter === null ? null : Number(r.vph_inter),
    vph_autom: r.vph_autom === null ? null : Number(r.vph_autom),
  }));

  const result: ManzanasByAgebResult = {
    cvegeo,
    order_by: orderBy,
    total_returned: manzanas.length,
    manzanas,
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

/**
 * GET /analytics/colonias-by-ageb?cvegeo=NNNNNNNNNNNNN&limit=20  (max 100)
 *
 * Surfaces the (free-text, INEGI-DENUE) colonias that intersect a given AGEB.
 * INEGI's official cartography doesn't tessellate at colonia level — colonias
 * are popular-name labels operators recognize, not geometric polygons. The
 * pragmatic source is `establecimientos.colonia` (the registered address-line
 * "colonia" field), grouped per AGEB.
 *
 * A typical urban AGEB contains 1-4 distinct colonia names (boundary cases
 * where one block faces two colonias). Operators recognize these labels and
 * can communicate "we'll open in [colonia X within AGEB Y]" to commercial
 * brokers — which the bare 13-digit AGEB key doesn't enable.
 *
 * The `colonia` text is normalized UPPER+TRIM (matches v0.2.5 colonia handling)
 * to fold spelling drift like "ROMA NORTE" / "Roma Norte" / "ROMA NORTE  ".
 * Empty/null colonia strings are excluded.
 */
export async function coloniasByAgebHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cvegeo = c.req.query("cvegeo");
  if (!cvegeo || !CVEGEO_RE.test(cvegeo)) {
    throw new HttpError(
      `cvegeo inválido "${cvegeo ?? ""}". Debe ser 13 chars (urbano) o 9 chars (rural), último char puede ser dígito o letra mayúscula.`,
      400,
      "validation.cvegeo",
    );
  }

  const limit = parseLimit(
    c.req.query("limit"),
    COLONIAS_BY_AGEB_DEFAULT_LIMIT,
    COLONIAS_BY_AGEB_MAX_LIMIT,
  );

  const sql = `
SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json) FROM (
  SELECT
    UPPER(TRIM(colonia)) AS colonia,
    COUNT(*) AS num_establecimientos
  FROM establecimientos
  WHERE ageb = '${cvegeo}'
    AND colonia IS NOT NULL
    AND TRIM(colonia) != ''
  GROUP BY UPPER(TRIM(colonia))
  ORDER BY COUNT(*) DESC, UPPER(TRIM(colonia)) ASC
  LIMIT ${limit}
) r;
`;
  const rows = await runJson<
    Array<{ colonia: string; num_establecimientos: number | string }>
  >(sql, { container: config.dbContainer });

  const colonias = rows.map((r) => ({
    colonia: r.colonia,
    num_establecimientos: Number(r.num_establecimientos ?? 0),
  }));

  const result: ColoniasByAgebResult = {
    cvegeo,
    total_returned: colonias.length,
    colonias,
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// Airports (SCT/AFAC March-of-year operations 2006-2026)
// ---------------------------------------------------------------------------

/**
 * GET /analytics/airports-by-municipio?cve_mun=NNNNN
 *
 * Surface SCT/AFAC airport-operations data per municipio. Returns the
 * airport(s) in the muni with March flights for the latest loaded year
 * (`latest_ano`, resolved from the data), the 3-yr average ending there,
 * 2019 pre-pandemic baseline, and growth-rate. Munis
 * without an airport return an empty `airports` array (zero-row response,
 * not 404 — consistent with the rest of the analytics surface).
 *
 * Mapping: airport names from the SCT pivot are matched to cve_mun via
 * the manually-curated `aeropuertos_cvemun_lookup` table (city served, not
 * physical-runway muni when they differ — a retailer cares about the
 * destination market, not the airfield). 64 airports mapped.
 */
export async function airportsByMunicipioHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded.`,
      400,
      "validation.cve_mun",
    );
  }

  // One query returns the per-airport breakdown plus the muni-level summary
  // shape via CTEs. The view aeropuertos_movements_yearly is already
  // deduped (same airport across operators is summed), so per-airport
  // rollup is straightforward. #72: the "current" year is MAX(ano) in the
  // data, not a literal, so the next SCT load moves every window with it.
  const sql = `
WITH latest AS (
  SELECT MAX(ano) AS ano FROM aeropuertos_movements_yearly
),
per_airport AS (
  SELECT
    airport_name,
    MAX(mar_flights) FILTER (WHERE ano = (SELECT ano FROM latest)) AS f_latest,
    ROUND(AVG(mar_flights) FILTER (
      WHERE ano BETWEEN (SELECT ano FROM latest) - 2 AND (SELECT ano FROM latest)
    )) AS recent_avg,
    MAX(mar_flights) FILTER (WHERE ano = 2019)             AS f2019
  FROM aeropuertos_movements_yearly
  WHERE cve_mun = '${cveMun}'
  GROUP BY airport_name
)
SELECT json_build_object(
  'latest_ano', (SELECT ano FROM latest),
  'airports', COALESCE((
    SELECT json_agg(row_to_json(r) ORDER BY r.mar_flights_recent_avg DESC NULLS LAST) FROM (
      SELECT
        airport_name,
        COALESCE(f_latest, 0)::INTEGER AS mar_flights_latest,
        COALESCE(recent_avg, 0)::INTEGER AS mar_flights_recent_avg,
        f2019::INTEGER AS mar_flights_2019,
        CASE
          WHEN f2019 IS NOT NULL AND f2019 > 0 AND f_latest IS NOT NULL
          THEN ROUND((f_latest - f2019)::numeric * 100.0 / f2019, 1)
          ELSE NULL
        END AS pct_change_vs_2019
      FROM per_airport
    ) r
  ), '[]'::json)
);
`;

  const payload = await runJson<{
    latest_ano: number | null;
    airports: Array<{
      airport_name: string;
      mar_flights_latest: number;
      mar_flights_recent_avg: number;
      mar_flights_2019: number | null;
      pct_change_vs_2019: number | null;
    }>;
  }>(sql, { container: config.dbContainer });
  const airports = payload.airports ?? [];

  const formatted: AirportInMunicipio[] = airports.map((a) => ({
    airport_name: a.airport_name,
    mar_flights_latest: Number(a.mar_flights_latest ?? 0),
    mar_flights_2026: Number(a.mar_flights_latest ?? 0),
    mar_flights_recent_avg: Number(a.mar_flights_recent_avg ?? 0),
    mar_flights_2019:
      a.mar_flights_2019 == null ? null : Number(a.mar_flights_2019),
    pct_change_vs_2019:
      a.pct_change_vs_2019 == null ? null : Number(a.pct_change_vs_2019),
  }));

  // cve_ent: take from cve_mun (first 2 chars) — every cve_mun is shape-validated.
  const numActive = formatted.filter((a) => a.mar_flights_latest > 0).length;
  const result: AirportsByMunicipioResult = {
    cve_mun: cveMun,
    cve_ent: cveMun.slice(0, 2),
    latest_ano:
      payload.latest_ano == null ? null : Number(payload.latest_ano),
    num_airports_active_latest: numActive,
    num_airports_active_2026: numActive,
    mar_flights_recent_avg: formatted.reduce(
      (s, a) => s + a.mar_flights_recent_avg,
      0,
    ),
    airports: formatted,
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// Locality grain (v0.2.10) — Censo 2020 ITER sub-municipal surface.
// Backed by the `censo_localidades` view (~193k rows, see
// scripts/migrate-censo-views.sql).
// ---------------------------------------------------------------------------

const LOCALITIES_DEFAULT_LIMIT = 50;
const LOCALITIES_MAX_LIMIT = 200;

/**
 * GET /analytics/localities-by-municipio?cve_mun=NNNNN
 *   &order_by=pobtot|tvivpar|vph_inter|nom_loc|tamloc   (default: pobtot)
 *   &limit=N                                            (max 200)
 *
 * Lists localities inside a municipio with their population/dwelling/internet
 * surface plus tamloc size class. A typical urban muni has 1-5 localities
 * (city + outlying); rural munis can have 50-300+ small ranchos.
 *
 * INEGI suppresses small-pop locality fields (LSNIEG art. 37). Where a
 * locality has fewer than ~50 households, derived fields surface as NULL.
 * The endpoint always returns 200 with possibly empty rows[]; consumers
 * can render "sin datos" client-side.
 *
 * Order-by tradeoffs:
 *   pobtot  — densest first (default; right for "where do most people live")
 *   tvivpar — most occupied dwellings (right for "where to lease")
 *   vph_inter — broadband-connected proxy for income (right for SES analysis)
 *   tamloc  — INEGI size-code descending (1-14)
 *   nom_loc — alphabetic for browsing
 */
export async function localitiesByMunicipioHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded (ENT01-32 + MUN001-999).`,
      400,
      "validation.cve_mun",
    );
  }

  const orderByRaw = c.req.query("order_by") ?? "pobtot";
  if (!LOCALITIES_ORDER_BY.includes(orderByRaw as LocalitiesOrderBy)) {
    throw new HttpError(
      `order_by inválido "${orderByRaw}". Valores válidos: ${LOCALITIES_ORDER_BY.join(", ")}.`,
      400,
      "validation.order_by",
    );
  }
  const orderBy = orderByRaw as LocalitiesOrderBy;
  const limit = parseLimit(
    c.req.query("limit"),
    LOCALITIES_DEFAULT_LIMIT,
    LOCALITIES_MAX_LIMIT,
  );

  // ORDER BY direction: ASC for nom_loc (alphabetic browse), DESC for the
  // numeric metrics. NULLS LAST keeps suppressed-data localities below
  // those with concrete values regardless of direction.
  const orderDirection = orderBy === "nom_loc" ? "ASC" : "DESC";

  // W1 (audit, 2026-05-09): explicit ORDER BY on the json_agg aggregate.
  // The inner ORDER BY + LIMIT picks the right rows; the outer aggregate
  // ORDER BY guarantees they emerge in order. Without the outer form,
  // json_agg row order is implementation-dependent — works empirically on
  // PG12+ but the SQL standard doesn't guarantee aggregate input order.
  // Sibling pattern (16 sites in this file) hoists ORDER BY into json_agg.
  const sql = `
SELECT json_build_object(
  'total_localities', (SELECT count(*)::int FROM censo_localidades WHERE cve_mun = '${cveMun}'),
  'localities', COALESCE((
    SELECT json_agg(row_to_json(r) ORDER BY r.${orderBy} ${orderDirection} NULLS LAST, r.cve_loc ASC) FROM (
      SELECT cve_loc, nom_loc, tamloc, altitud_m,
             pobtot, tvivpar, vph_inter
      FROM censo_localidades
      WHERE cve_mun = '${cveMun}'
      ORDER BY ${orderBy} ${orderDirection} NULLS LAST, cve_loc ASC
      LIMIT ${limit}
    ) r
  ), '[]'::json)
);
`;
  const payload = await runJson<{
    total_localities: number;
    localities: Array<{
      cve_loc: string;
      nom_loc: string;
      tamloc: number | null;
      altitud_m: number | null;
      pobtot: number | null;
      tvivpar: number | null;
      vph_inter: number | null;
    }>;
  }>(sql, { container: config.dbContainer });

  // psql -t -A returns json_build_object as a single object (not wrapped in
  // an array). runJson's empty-stdout fallback returns []; gate that.
  const totalLocalities =
    payload && !Array.isArray(payload) && "total_localities" in payload
      ? Number(payload.total_localities ?? 0)
      : 0;
  const rawLocs =
    payload && !Array.isArray(payload) && "localities" in payload
      ? payload.localities
      : [];

  const result: LocalitiesByMunicipioResult = {
    cve_mun: cveMun,
    order_by: orderBy,
    total_localities: totalLocalities,
    localities: rawLocs.map((r) => ({
      cve_loc: r.cve_loc,
      nom_loc: r.nom_loc,
      tamloc: r.tamloc === null ? null : Number(r.tamloc),
      altitud_m: r.altitud_m === null ? null : Number(r.altitud_m),
      pobtot: r.pobtot === null ? null : Number(r.pobtot),
      tvivpar: r.tvivpar === null ? null : Number(r.tvivpar),
      vph_inter: r.vph_inter === null ? null : Number(r.vph_inter),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

/**
 * GET /analytics/locality-detail?cve_loc=NNNNNNNNN
 *
 * Single-locality demographic surface — religion, indigenous/afro,
 * migration, education, health coverage, household assets. Mirrors the
 * structure of /analytics/ageb-detail's `rezago_social` block but at
 * locality grain instead of AGEB.
 *
 * Returns 404 when the cve_loc isn't found in censo_iter (typo or
 * synthetic id). Returns 200 with NULL-heavy fields when the locality
 * exists but INEGI suppressed most attributes (LSNIEG art. 37, ~42% of
 * the 193k localities have at least religion+language suppressed).
 */
export async function localityDetailHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveLoc = c.req.query("cve_loc");
  if (!cveLoc || !CVE_LOC_RE.test(cveLoc)) {
    throw new HttpError(
      `cve_loc inválido "${cveLoc ?? ""}". Debe ser 9 dígitos zero-padded (ENT2 + MUN3 + LOC4).`,
      400,
      "validation.cve_loc",
    );
  }
  // #68: 9998/9999 are INEGI buckets ("Localidades de una/dos viviendas"),
  // aggregates of many tiny places — not a locality.
  const locCode = cveLoc.slice(5);
  if (locCode === "9998" || locCode === "9999") {
    throw new HttpError(
      `localidad no encontrada para cve_loc="${cveLoc}" (9998/9999 agrupan localidades de 1-2 viviendas, no son una localidad).`,
      404,
      "locality.not_found",
    );
  }

  // #118: filter on the raw (cve_mun, loc) columns so the censo_iter
  // (cve_mun, loc) index applies; cve_loc is a concatenation no index matches.
  const sql = `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    cve_loc, cve_mun, entidad,
    nom_loc, nom_mun, nom_ent,
    tamloc, altitud_m,
    pobtot, pobfem, pobmas, p_60ymas, p_15ymas, p_18ymas,
    pea, pocupada, graproes, tvivhab, tvivpar,
    pcatolica, pro_crieva, potras_rel, psin_relig,
    p3ym_hli, p3hlinhe, p3hli_he, phog_ind, pob_afro,
    pnacent, pnacoe, pres2015, presoe15,
    p15ym_an, p15ym_se, p18ym_pb,
    psinder, pder_ss, pder_imss, pder_iste, pder_segp, pder_imssb, pafil_ipriv,
    vph_inter, vph_autom, vph_refri, vph_lavad, vph_pc, vph_cel, vph_tv, vph_snbien
  FROM censo_localidades
  WHERE cve_mun = '${cveLoc.slice(0, 5)}' AND loc = '${locCode}'
) t;
`;
  const rows = await runJson<Array<Record<string, string | number | null>>>(
    sql,
    { container: config.dbContainer },
  );
  if (!rows || rows.length === 0) {
    throw new HttpError(
      `localidad no encontrada para cve_loc="${cveLoc}".`,
      404,
      "locality.not_found",
    );
  }
  const r = rows[0];
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);

  const result: LocalityDetailResult = {
    cve_loc: String(r.cve_loc),
    cve_mun: String(r.cve_mun),
    entidad: String(r.entidad),
    nom_loc: String(r.nom_loc),
    nom_mun: String(r.nom_mun),
    nom_ent: String(r.nom_ent),
    tamloc: num(r.tamloc),
    altitud_m: num(r.altitud_m),
    population: {
      pobtot: num(r.pobtot),
      pobfem: num(r.pobfem),
      pobmas: num(r.pobmas),
      p_60ymas: num(r.p_60ymas),
      p_15ymas: num(r.p_15ymas),
      p_18ymas: num(r.p_18ymas),
      pea: num(r.pea),
      pocupada: num(r.pocupada),
      graproes: num(r.graproes),
      tvivhab: num(r.tvivhab),
      tvivpar: num(r.tvivpar),
    },
    religion: {
      pcatolica: num(r.pcatolica),
      pro_crieva: num(r.pro_crieva),
      potras_rel: num(r.potras_rel),
      psin_relig: num(r.psin_relig),
    },
    indigenous_afro: {
      p3ym_hli: num(r.p3ym_hli),
      p3hlinhe: num(r.p3hlinhe),
      p3hli_he: num(r.p3hli_he),
      phog_ind: num(r.phog_ind),
      pob_afro: num(r.pob_afro),
    },
    migration: {
      pnacent: num(r.pnacent),
      pnacoe: num(r.pnacoe),
      pres2015: num(r.pres2015),
      presoe15: num(r.presoe15),
    },
    education: {
      p15ym_an: num(r.p15ym_an),
      p15ym_se: num(r.p15ym_se),
      p18ym_pb: num(r.p18ym_pb),
    },
    health_coverage: {
      psinder: num(r.psinder),
      pder_ss: num(r.pder_ss),
      pder_imss: num(r.pder_imss),
      pder_iste: num(r.pder_iste),
      pder_segp: num(r.pder_segp),
      pder_imssb: num(r.pder_imssb),
      pafil_ipriv: num(r.pafil_ipriv),
    },
    assets: {
      vph_inter: num(r.vph_inter),
      vph_autom: num(r.vph_autom),
      vph_refri: num(r.vph_refri),
      vph_lavad: num(r.vph_lavad),
      vph_pc: num(r.vph_pc),
      vph_cel: num(r.vph_cel),
      vph_tv: num(r.vph_tv),
      vph_snbien: num(r.vph_snbien),
    },
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// CNBV Panorama 2025 (v0.2.12) — shared SQL fragments + marshallers
// ---------------------------------------------------------------------------

/**
 * SELECT column list for the LEFT JOIN against `cnbv_panorama_municipal`.
 * All 76 view cols aliased with a `cp_` prefix to avoid collisions with the
 * municipios_2025 cols in the same SELECT list.
 *
 * Grouped by family (matches view order). Defined as a string template
 * fragment so it composes into the existing `SELECT ... FROM municipios_2025
 * LEFT JOIN cnbv_panorama_municipal cp ON cp.cve_mun = ...` pattern.
 */
const CNBV_MUNI_COLS = `
    cp.poblacion_total       AS cp_poblacion_total,
    cp.poblacion_adulta      AS cp_poblacion_adulta,
    cp.rezago_social         AS cp_rezago_social,
    cp.sucursales_bm         AS cp_sucursales_bm,
    cp.sucursales_bd         AS cp_sucursales_bd,
    cp.sucursales_socap      AS cp_sucursales_socap,
    cp.sucursales_sofipo     AS cp_sucursales_sofipo,
    cp.sucursales_total      AS cp_sucursales_total,
    cp.corresponsales_max    AS cp_corresponsales_max,
    cp.cajeros_bm            AS cp_cajeros_bm,
    cp.cajeros_bd            AS cp_cajeros_bd,
    cp.cajeros_socap         AS cp_cajeros_socap,
    cp.cajeros_sofipo        AS cp_cajeros_sofipo,
    cp.cajeros_total         AS cp_cajeros_total,
    cp.tpv_bm                AS cp_tpv_bm,
    cp.tpv_bd                AS cp_tpv_bd,
    cp.tpv_socap             AS cp_tpv_socap,
    cp.tpv_sofipo            AS cp_tpv_sofipo,
    cp.tpv_total_eacp        AS cp_tpv_total_eacp,
    cp.tpv_agregadores       AS cp_tpv_agregadores,
    cp.tpv_adq_no_banc       AS cp_tpv_adq_no_banc,
    cp.tpv_total_ag_adq      AS cp_tpv_total_ag_adq,
    cp.tpv_total             AS cp_tpv_total,
    cp.puntos_acceso_sca     AS cp_puntos_acceso_sca,
    cp.cuentas_bm            AS cp_cuentas_bm,
    cp.cuentas_bd            AS cp_cuentas_bd,
    cp.cuentas_socap         AS cp_cuentas_socap,
    cp.cuentas_sofipo        AS cp_cuentas_sofipo,
    cp.cuentas_total         AS cp_cuentas_total,
    cp.creditos_bm           AS cp_creditos_bm,
    cp.creditos_bd           AS cp_creditos_bd,
    cp.creditos_socap        AS cp_creditos_socap,
    cp.creditos_sofipo       AS cp_creditos_sofipo,
    cp.creditos_total        AS cp_creditos_total,
    cp.tx_tpv_bm             AS cp_tx_tpv_bm,
    cp.tx_tpv_bd             AS cp_tx_tpv_bd,
    cp.tx_tpv_socap          AS cp_tx_tpv_socap,
    cp.tx_tpv_sofipo         AS cp_tx_tpv_sofipo,
    cp.tx_tpv_total          AS cp_tx_tpv_total,
    cp.remesas_mdd           AS cp_remesas_mdd,
    cp.remesas_per_capita    AS cp_remesas_per_capita,
    cp.g_cuentas_bm_m        AS cp_g_cuentas_bm_m,
    cp.g_cuentas_bm_h        AS cp_g_cuentas_bm_h,
    cp.g_cuentas_bm_b        AS cp_g_cuentas_bm_b,
    cp.g_cuentas_bd_m        AS cp_g_cuentas_bd_m,
    cp.g_cuentas_bd_h        AS cp_g_cuentas_bd_h,
    cp.g_cuentas_bd_b        AS cp_g_cuentas_bd_b,
    cp.g_cuentas_socap_m     AS cp_g_cuentas_socap_m,
    cp.g_cuentas_socap_h     AS cp_g_cuentas_socap_h,
    cp.g_cuentas_socap_b     AS cp_g_cuentas_socap_b,
    cp.g_cuentas_sofipo_m    AS cp_g_cuentas_sofipo_m,
    cp.g_cuentas_sofipo_h    AS cp_g_cuentas_sofipo_h,
    cp.g_cuentas_sofipo_b    AS cp_g_cuentas_sofipo_b,
    cp.g_cuentas_total_m     AS cp_g_cuentas_total_m,
    cp.g_cuentas_total_h     AS cp_g_cuentas_total_h,
    cp.g_cuentas_total_b     AS cp_g_cuentas_total_b,
    cp.g_creditos_bm_m       AS cp_g_creditos_bm_m,
    cp.g_creditos_bm_h       AS cp_g_creditos_bm_h,
    cp.g_creditos_bm_b       AS cp_g_creditos_bm_b,
    cp.g_creditos_bd_m       AS cp_g_creditos_bd_m,
    cp.g_creditos_bd_h       AS cp_g_creditos_bd_h,
    cp.g_creditos_bd_b       AS cp_g_creditos_bd_b,
    cp.g_creditos_socap_m    AS cp_g_creditos_socap_m,
    cp.g_creditos_socap_h    AS cp_g_creditos_socap_h,
    cp.g_creditos_socap_b    AS cp_g_creditos_socap_b,
    cp.g_creditos_sofipo_m   AS cp_g_creditos_sofipo_m,
    cp.g_creditos_sofipo_h   AS cp_g_creditos_sofipo_h,
    cp.g_creditos_sofipo_b   AS cp_g_creditos_sofipo_b,
    cp.g_creditos_total_m    AS cp_g_creditos_total_m,
    cp.g_creditos_total_h    AS cp_g_creditos_total_h,
    cp.g_creditos_total_b    AS cp_g_creditos_total_b,
    cp.periodo               AS cp_periodo`;

/**
 * SELECT column list for the LEFT JOIN against `cnbv_panorama_estatal`.
 * 72 view cols aliased with `cp_` (parallel to the muni list).
 */
const CNBV_ESTADO_COLS = `
    cp.poblacion_total       AS cp_poblacion_total,
    cp.poblacion_adulta      AS cp_poblacion_adulta,
    cp.sucursales_bm         AS cp_sucursales_bm,
    cp.sucursales_bd         AS cp_sucursales_bd,
    cp.sucursales_socap      AS cp_sucursales_socap,
    cp.sucursales_sofipo     AS cp_sucursales_sofipo,
    cp.sucursales_total      AS cp_sucursales_total,
    cp.corresponsales_max    AS cp_corresponsales_max,
    cp.cajeros_bm            AS cp_cajeros_bm,
    cp.cajeros_bd            AS cp_cajeros_bd,
    cp.cajeros_socap         AS cp_cajeros_socap,
    cp.cajeros_sofipo        AS cp_cajeros_sofipo,
    cp.cajeros_total         AS cp_cajeros_total,
    cp.tpv_bm                AS cp_tpv_bm,
    cp.tpv_bd                AS cp_tpv_bd,
    cp.tpv_socap             AS cp_tpv_socap,
    cp.tpv_sofipo            AS cp_tpv_sofipo,
    cp.tpv_total_eacp        AS cp_tpv_total_eacp,
    cp.tpv_agregadores       AS cp_tpv_agregadores,
    cp.tpv_adq_no_banc       AS cp_tpv_adq_no_banc,
    cp.tpv_total_ag_adq      AS cp_tpv_total_ag_adq,
    cp.tpv_total             AS cp_tpv_total,
    cp.cuentas_bm            AS cp_cuentas_bm,
    cp.cuentas_bd            AS cp_cuentas_bd,
    cp.cuentas_socap         AS cp_cuentas_socap,
    cp.cuentas_sofipo        AS cp_cuentas_sofipo,
    cp.cuentas_total         AS cp_cuentas_total,
    cp.creditos_bm           AS cp_creditos_bm,
    cp.creditos_bd           AS cp_creditos_bd,
    cp.creditos_socap        AS cp_creditos_socap,
    cp.creditos_sofipo       AS cp_creditos_sofipo,
    cp.creditos_total        AS cp_creditos_total,
    cp.sar_asignado          AS cp_sar_asignado,
    cp.sar_registrado        AS cp_sar_registrado,
    cp.sar_total             AS cp_sar_total,
    cp.seg_vida              AS cp_seg_vida,
    cp.seg_pensiones         AS cp_seg_pensiones,
    cp.seg_accidentes        AS cp_seg_accidentes,
    cp.seg_danos_sin_autos   AS cp_seg_danos_sin_autos,
    cp.seg_automoviles       AS cp_seg_automoviles,
    cp.seg_total             AS cp_seg_total,
    cp.tx_tpv_bm             AS cp_tx_tpv_bm,
    cp.tx_tpv_bd             AS cp_tx_tpv_bd,
    cp.tx_tpv_socap          AS cp_tx_tpv_socap,
    cp.tx_tpv_sofipo         AS cp_tx_tpv_sofipo,
    cp.tx_tpv_total          AS cp_tx_tpv_total,
    cp.remesas_mdd           AS cp_remesas_mdd,
    cp.condusef_ubicacion    AS cp_condusef_ubicacion,
    cp.condusef_reclamaciones AS cp_condusef_reclamaciones,
    cp.ac_inf_sucursales     AS cp_ac_inf_sucursales,
    cp.ac_inf_corresponsales AS cp_ac_inf_corresponsales,
    cp.ac_inf_cajeros        AS cp_ac_inf_cajeros,
    cp.ac_inf_tpv            AS cp_ac_inf_tpv,
    cp.ac_inf_total_ag_adq   AS cp_ac_inf_total_ag_adq,
    cp.ac_pf_captacion       AS cp_ac_pf_captacion,
    cp.ac_pf_credito         AS cp_ac_pf_credito,
    cp.ac_pf_afore           AS cp_ac_pf_afore,
    cp.ac_pf_vida            AS cp_ac_pf_vida,
    cp.ac_pf_pensiones       AS cp_ac_pf_pensiones,
    cp.ac_pf_accidentes      AS cp_ac_pf_accidentes,
    cp.ac_pf_danos_sin_autos AS cp_ac_pf_danos_sin_autos,
    cp.ac_pf_automoviles     AS cp_ac_pf_automoviles,
    cp.ac_mp_tx_tpv          AS cp_ac_mp_tx_tpv,
    cp.ac_mp_remesas         AS cp_ac_mp_remesas,
    cp.ac_mp_ubicacion       AS cp_ac_mp_ubicacion,
    cp.ac_mp_reclamaciones   AS cp_ac_mp_reclamaciones,
    cp.periodo               AS cp_periodo`;

/**
 * SELECT column list for the LEFT JOIN against `sict_traffic_by_estado`
 * (v0.2.15). All cols `sv_`-prefixed (sv = sict viales) so the existing
 * `datosVialesFromRow` marshaller — keyed on these names — works unchanged
 * across muni and estado grains. The two prefixes never collide because
 * they appear in different handler SELECT statements (municipio-detail vs
 * entidad-detail).
 */
const SICT_ESTADO_COLS = `
    se.station_count    AS sv_station_count,
    se.tdpa_total       AS sv_tdpa_total,
    se.tdpa_max         AS sv_tdpa_max,
    se.tdpa_mean        AS sv_tdpa_mean,
    se.pct_motos        AS sv_pct_motos,
    se.pct_autos        AS sv_pct_autos,
    se.pct_buses        AS sv_pct_buses,
    se.pct_camiones     AS sv_pct_camiones,
    se.pct_otros        AS sv_pct_otros,
    se.route_count      AS sv_route_count,
    se.routes_top       AS sv_routes_top
`.trim();

/**
 * SELECT column list for the LEFT JOIN against `sedatu_financing_by_estado`
 * (v0.2.16). All cols `sf_`-prefixed (sf = sedatu financing) so the existing
 * `viviendaFinanciamientosFromRow` marshaller works unchanged across muni
 * and estado grains. Mirror posture of v0.2.15 SICT_ESTADO_COLS — the two
 * prefixes never collide because they appear in different handler SELECT
 * statements (municipio-detail vs entidad-detail).
 */
const SEDATU_ESTADO_COLS = `
    sfe.acciones_total           AS sf_acciones_total,
    sfe.monto_total              AS sf_monto_total,
    sfe.monto_per_accion_avg     AS sf_monto_per_accion_avg,
    sfe.top_organismo_code       AS sf_top_organismo_code,
    sfe.top_organismo_nombre     AS sf_top_organismo_nombre,
    sfe.top_organismo_share      AS sf_top_organismo_share,
    sfe.pct_vivienda_nueva       AS sf_pct_vivienda_nueva,
    sfe.pct_mejoramientos        AS sf_pct_mejoramientos,
    sfe.pct_vivienda_usada       AS sf_pct_vivienda_usada,
    sfe.pct_otros                AS sf_pct_otros,
    sfe.pct_femenino             AS sf_pct_femenino,
    sfe.pct_credito_individual   AS sf_pct_credito_individual,
    sfe.pct_economica            AS sf_pct_economica,
    sfe.pct_popular              AS sf_pct_popular,
    sfe.pct_tradicional          AS sf_pct_tradicional,
    sfe.pct_media                AS sf_pct_media,
    sfe.pct_residencial          AS sf_pct_residencial,
    sfe.pct_residencial_plus     AS sf_pct_residencial_plus,
    sfe.periodo                  AS sf_periodo
`.trim();

/**
 * SELECT column list for the LEFT JOIN against `cnbv_credito_by_estado`
 * (v0.2.17). All cols `cc_`-prefixed (cc = cnbv credito) so the
 * `creditoComercialFromRow` marshaller works unchanged across muni and
 * estado grains. Mirror posture of SICT/SEDATU estado-grain wiring — the
 * two prefixes never collide because they appear in different handler
 * SELECT statements (municipio-detail vs entidad-detail).
 */
const CNBV_CREDITO_ESTADO_COLS = `
    cce.acciones_total           AS cc_acciones_total,
    cce.monto_total              AS cc_monto_total,
    cce.monto_per_accion_avg     AS cc_monto_per_accion_avg,
    cce.top_intermediario_code   AS cc_top_intermediario_code,
    cce.top_intermediario_nombre AS cc_top_intermediario_nombre,
    cce.top_intermediario_share  AS cc_top_intermediario_share,
    cce.top_linea_credito_code   AS cc_top_linea_credito_code,
    cce.top_esquema_code         AS cc_top_esquema_code,
    cce.pct_vivienda_nueva       AS cc_pct_vivienda_nueva,
    cce.pct_mejoramientos        AS cc_pct_mejoramientos,
    cce.pct_vivienda_usada       AS cc_pct_vivienda_usada,
    cce.pct_otros                AS cc_pct_otros,
    cce.pct_femenino             AS cc_pct_femenino,
    cce.pct_indigena             AS cc_pct_indigena,
    cce.pct_economica            AS cc_pct_economica,
    cce.pct_popular              AS cc_pct_popular,
    cce.pct_tradicional          AS cc_pct_tradicional,
    cce.pct_media                AS cc_pct_media,
    cce.pct_residencial          AS cc_pct_residencial,
    cce.pct_residencial_plus     AS cc_pct_residencial_plus,
    cce.periodo                  AS cc_periodo
`.trim();

/**
 * Marshal a row from a cnbv_panorama LEFT JOIN into the
 * `inclusion_financiera` nested category. Fields populated per grain are
 * documented at the InclusionFinancieraResult type definition.
 *
 * `r` is the wide flat row with cp_-prefixed columns.
 * `grain` selects which subtree is populated vs returned as null:
 *   - 'muni'   → genero populated, sar/seguros/condusef/acomodo = null
 *   - 'estado' → sar/seguros/condusef/acomodo populated, genero = null
 *
 * Defensive: when the LEFT JOIN misses (no row in panorama), every cp_ field
 * is null; this returns the type-shape with all leaves null. The `periodo`
 * field falls back to 'panorama-2025' so consumers always have a label.
 */
function inclusionFinancieraFromRow(
  r: Record<string, unknown>,
  grain: "muni" | "estado",
): InclusionFinancieraResult {
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v);
  const breakdown = (
    m: unknown,
    h: unknown,
    b: unknown,
  ): { m: number | null; h: number | null; brecha: number | null } => ({
    m: num(m),
    h: num(h),
    brecha: num(b),
  });

  return {
    poblacion_total: num(r.cp_poblacion_total),
    poblacion_adulta: num(r.cp_poblacion_adulta),
    rezago_social: grain === "muni" ? str(r.cp_rezago_social) : null,
    infraestructura: {
      sucursales: {
        bm: num(r.cp_sucursales_bm),
        bd: num(r.cp_sucursales_bd),
        socap: num(r.cp_sucursales_socap),
        sofipo: num(r.cp_sucursales_sofipo),
        total: num(r.cp_sucursales_total),
      },
      corresponsales_max: num(r.cp_corresponsales_max),
      cajeros: {
        bm: num(r.cp_cajeros_bm),
        bd: num(r.cp_cajeros_bd),
        socap: num(r.cp_cajeros_socap),
        sofipo: num(r.cp_cajeros_sofipo),
        total: num(r.cp_cajeros_total),
      },
      tpv: {
        bm: num(r.cp_tpv_bm),
        bd: num(r.cp_tpv_bd),
        socap: num(r.cp_tpv_socap),
        sofipo: num(r.cp_tpv_sofipo),
        total_eacp: num(r.cp_tpv_total_eacp),
        agregadores: num(r.cp_tpv_agregadores),
        adq_no_banc: num(r.cp_tpv_adq_no_banc),
        total_ag_adq: num(r.cp_tpv_total_ag_adq),
        total: num(r.cp_tpv_total),
      },
      puntos_acceso_sca: grain === "muni" ? num(r.cp_puntos_acceso_sca) : null,
    },
    productos: {
      cuentas: {
        bm: num(r.cp_cuentas_bm),
        bd: num(r.cp_cuentas_bd),
        socap: num(r.cp_cuentas_socap),
        sofipo: num(r.cp_cuentas_sofipo),
        total: num(r.cp_cuentas_total),
      },
      creditos: {
        bm: num(r.cp_creditos_bm),
        bd: num(r.cp_creditos_bd),
        socap: num(r.cp_creditos_socap),
        sofipo: num(r.cp_creditos_sofipo),
        total: num(r.cp_creditos_total),
      },
      tx_tpv: {
        bm: num(r.cp_tx_tpv_bm),
        bd: num(r.cp_tx_tpv_bd),
        socap: num(r.cp_tx_tpv_socap),
        sofipo: num(r.cp_tx_tpv_sofipo),
        total: num(r.cp_tx_tpv_total),
      },
      sar:
        grain === "estado"
          ? {
              asignado: num(r.cp_sar_asignado),
              registrado: num(r.cp_sar_registrado),
              total: num(r.cp_sar_total),
            }
          : null,
      seguros:
        grain === "estado"
          ? {
              vida: num(r.cp_seg_vida),
              pensiones: num(r.cp_seg_pensiones),
              accidentes: num(r.cp_seg_accidentes),
              danos_sin_autos: num(r.cp_seg_danos_sin_autos),
              automoviles: num(r.cp_seg_automoviles),
              total: num(r.cp_seg_total),
            }
          : null,
    },
    remesas: {
      mdd: num(r.cp_remesas_mdd),
      per_capita: grain === "muni" ? num(r.cp_remesas_per_capita) : null,
    },
    genero:
      grain === "muni"
        ? {
            cuentas: {
              bm: breakdown(
                r.cp_g_cuentas_bm_m,
                r.cp_g_cuentas_bm_h,
                r.cp_g_cuentas_bm_b,
              ),
              bd: breakdown(
                r.cp_g_cuentas_bd_m,
                r.cp_g_cuentas_bd_h,
                r.cp_g_cuentas_bd_b,
              ),
              socap: breakdown(
                r.cp_g_cuentas_socap_m,
                r.cp_g_cuentas_socap_h,
                r.cp_g_cuentas_socap_b,
              ),
              sofipo: breakdown(
                r.cp_g_cuentas_sofipo_m,
                r.cp_g_cuentas_sofipo_h,
                r.cp_g_cuentas_sofipo_b,
              ),
              total: breakdown(
                r.cp_g_cuentas_total_m,
                r.cp_g_cuentas_total_h,
                r.cp_g_cuentas_total_b,
              ),
            },
            creditos: {
              bm: breakdown(
                r.cp_g_creditos_bm_m,
                r.cp_g_creditos_bm_h,
                r.cp_g_creditos_bm_b,
              ),
              bd: breakdown(
                r.cp_g_creditos_bd_m,
                r.cp_g_creditos_bd_h,
                r.cp_g_creditos_bd_b,
              ),
              socap: breakdown(
                r.cp_g_creditos_socap_m,
                r.cp_g_creditos_socap_h,
                r.cp_g_creditos_socap_b,
              ),
              sofipo: breakdown(
                r.cp_g_creditos_sofipo_m,
                r.cp_g_creditos_sofipo_h,
                r.cp_g_creditos_sofipo_b,
              ),
              total: breakdown(
                r.cp_g_creditos_total_m,
                r.cp_g_creditos_total_h,
                r.cp_g_creditos_total_b,
              ),
            },
          }
        : null,
    condusef:
      grain === "estado"
        ? {
            ubicacion: num(r.cp_condusef_ubicacion),
            reclamaciones: num(r.cp_condusef_reclamaciones),
          }
        : null,
    acomodo:
      grain === "estado"
        ? {
            infraestructura: {
              sucursales: num(r.cp_ac_inf_sucursales),
              corresponsales: num(r.cp_ac_inf_corresponsales),
              cajeros: num(r.cp_ac_inf_cajeros),
              tpv: num(r.cp_ac_inf_tpv),
              total_ag_adq: num(r.cp_ac_inf_total_ag_adq),
            },
            productos: {
              captacion: num(r.cp_ac_pf_captacion),
              credito: num(r.cp_ac_pf_credito),
              afore: num(r.cp_ac_pf_afore),
              vida: num(r.cp_ac_pf_vida),
              pensiones: num(r.cp_ac_pf_pensiones),
              accidentes: num(r.cp_ac_pf_accidentes),
              danos_sin_autos: num(r.cp_ac_pf_danos_sin_autos),
              automoviles: num(r.cp_ac_pf_automoviles),
            },
            medios_pago: {
              tx_tpv: num(r.cp_ac_mp_tx_tpv),
              remesas: num(r.cp_ac_mp_remesas),
              ubicacion: num(r.cp_ac_mp_ubicacion),
              reclamaciones: num(r.cp_ac_mp_reclamaciones),
            },
          }
        : null,
    periodo: str(r.cp_periodo) ?? "panorama-2025",
  };
}

/**
 * SELECT column list for the LEFT JOIN against `sict_traffic_by_municipio`.
 * All cols aliased with a `sv_` prefix (sv = sict_viales) to avoid collision
 * with cm.* and cp.* in the same SELECT list. The materialized view itself
 * is keyed on `cve_mun`; we reference the join-side attributes only.
 */
const SICT_MUNI_COLS = `
    sv.station_count    AS sv_station_count,
    sv.tdpa_total       AS sv_tdpa_total,
    sv.tdpa_max         AS sv_tdpa_max,
    sv.tdpa_mean        AS sv_tdpa_mean,
    sv.pct_motos        AS sv_pct_motos,
    sv.pct_autos        AS sv_pct_autos,
    sv.pct_buses        AS sv_pct_buses,
    sv.pct_camiones     AS sv_pct_camiones,
    sv.pct_otros        AS sv_pct_otros,
    sv.route_count      AS sv_route_count,
    sv.routes_top       AS sv_routes_top
`.trim();

/**
 * Marshal SICT muni-grain row into the `datos_viales` subtree, OR return
 * `null` if the LEFT JOIN missed (no federal-highway TDPA station inside
 * this muni's polygon — ~1,316 of 2,469 munis nationally).
 *
 * The miss signal we use is `sv_station_count IS NULL` — an integer NOT NULL
 * column in the materialized view, so `null` here means "no row joined".
 *
 * `routes_top` arrives from PostgreSQL as a string-array literal (e.g.
 * `'{MEX-095D,MEX-095,MEX-162}'` if pg-native, or already a parsed array
 * via the JSON path). We accept both and normalize to string[].
 */
function datosVialesFromRow(
  r: Record<string, unknown>,
): DatosVialesResult | null {
  if (r.sv_station_count === null || r.sv_station_count === undefined) {
    return null;
  }
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const numReq = (v: unknown): number => Number(v);

  let routesTop: string[] = [];
  const raw = r.sv_routes_top;
  if (Array.isArray(raw)) {
    routesTop = raw.filter((x): x is string => typeof x === "string");
  } else if (typeof raw === "string") {
    // PG array literal `{a,b,c}` — strip braces, split on comma.
    const trimmed = raw.replace(/^\{/, "").replace(/\}$/, "");
    routesTop =
      trimmed.length === 0
        ? []
        : trimmed.split(",").map((s) => s.replace(/^"|"$/g, ""));
  }

  return {
    station_count: numReq(r.sv_station_count),
    tdpa_total: numReq(r.sv_tdpa_total),
    tdpa_max: numReq(r.sv_tdpa_max),
    tdpa_mean: numReq(r.sv_tdpa_mean),
    composition: {
      pct_motos: num(r.sv_pct_motos),
      pct_autos: num(r.sv_pct_autos),
      pct_buses: num(r.sv_pct_buses),
      pct_camiones: num(r.sv_pct_camiones),
      pct_otros: num(r.sv_pct_otros),
    },
    route_count: numReq(r.sv_route_count),
    routes_top: routesTop,
  };
}

/**
 * SELECT column list for the LEFT JOIN against `sedatu_financing_by_municipio`.
 * All cols `sf_`-prefixed (sf = sedatu financing). The MV pre-resolves the
 * `top_organismo_nombre` label via JOIN to `sedatu_organismos` — we surface
 * the resolved string directly, avoiding a 4th JOIN at the handler layer.
 */
const SEDATU_MUNI_COLS = `
    sf.acciones_total           AS sf_acciones_total,
    sf.monto_total              AS sf_monto_total,
    sf.monto_per_accion_avg     AS sf_monto_per_accion_avg,
    sf.top_organismo_code       AS sf_top_organismo_code,
    sf.top_organismo_nombre     AS sf_top_organismo_nombre,
    sf.top_organismo_share      AS sf_top_organismo_share,
    sf.pct_vivienda_nueva       AS sf_pct_vivienda_nueva,
    sf.pct_mejoramientos        AS sf_pct_mejoramientos,
    sf.pct_vivienda_usada       AS sf_pct_vivienda_usada,
    sf.pct_otros                AS sf_pct_otros,
    sf.pct_femenino             AS sf_pct_femenino,
    sf.pct_credito_individual   AS sf_pct_credito_individual,
    sf.pct_economica            AS sf_pct_economica,
    sf.pct_popular              AS sf_pct_popular,
    sf.pct_tradicional          AS sf_pct_tradicional,
    sf.pct_media                AS sf_pct_media,
    sf.pct_residencial          AS sf_pct_residencial,
    sf.pct_residencial_plus     AS sf_pct_residencial_plus,
    sf.periodo                  AS sf_periodo
`.trim();

/**
 * SELECT column list for the LEFT JOIN against `cnbv_credito_by_municipio`
 * (v0.2.17). All cols `cc_`-prefixed (cc = cnbv credito). The MV
 * pre-resolves `top_intermediario_nombre` via JOIN to `cnbv_intermediarios`
 * — handler surfaces the resolved string directly. `top_linea_credito_code`
 * and `top_esquema_code` are exposed numeric-only (CNBV codebook gap).
 */
const CNBV_CREDITO_MUNI_COLS = `
    cc.acciones_total           AS cc_acciones_total,
    cc.monto_total              AS cc_monto_total,
    cc.monto_per_accion_avg     AS cc_monto_per_accion_avg,
    cc.top_intermediario_code   AS cc_top_intermediario_code,
    cc.top_intermediario_nombre AS cc_top_intermediario_nombre,
    cc.top_intermediario_share  AS cc_top_intermediario_share,
    cc.top_linea_credito_code   AS cc_top_linea_credito_code,
    cc.top_esquema_code         AS cc_top_esquema_code,
    cc.pct_vivienda_nueva       AS cc_pct_vivienda_nueva,
    cc.pct_mejoramientos        AS cc_pct_mejoramientos,
    cc.pct_vivienda_usada       AS cc_pct_vivienda_usada,
    cc.pct_otros                AS cc_pct_otros,
    cc.pct_femenino             AS cc_pct_femenino,
    cc.pct_indigena             AS cc_pct_indigena,
    cc.pct_economica            AS cc_pct_economica,
    cc.pct_popular              AS cc_pct_popular,
    cc.pct_tradicional          AS cc_pct_tradicional,
    cc.pct_media                AS cc_pct_media,
    cc.pct_residencial          AS cc_pct_residencial,
    cc.pct_residencial_plus     AS cc_pct_residencial_plus,
    cc.periodo                  AS cc_periodo
`.trim();

/**
 * Marshal CNBV credito row (muni or estado grain) into the
 * `vivienda_credito_comercial` subtree, OR return `null` if the LEFT JOIN
 * missed (muni/estado has no commercial-bank credit activity in 2025).
 *
 * Miss signal: `cc_acciones_total IS NULL` ONLY when the LEFT JOIN to
 * cnbv_credito_by_municipio/by_estado doesn't match — the MV's GROUP BY
 * guarantees every present row has a non-null sum. The `vivienda_tier`
 * subtree returns null when ALL six tier %s are null (= 100% of rows
 * had unknown vivienda_valor).
 *
 * Grain-agnostic: works for both cnbv_credito_by_municipio (cve_mun key)
 * and cnbv_credito_by_estado (cve_ent key) since both MVs project the
 * same shape and both are aliased via the cc_ prefix.
 */
function creditoComercialFromRow(
  r: Record<string, unknown>,
): ViviendaCreditoComercialResult | null {
  if (r.cc_acciones_total === null || r.cc_acciones_total === undefined) {
    return null;
  }
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const numReq = (v: unknown): number => Number(v);

  const tier = {
    pct_economica: num(r.cc_pct_economica),
    pct_popular: num(r.cc_pct_popular),
    pct_tradicional: num(r.cc_pct_tradicional),
    pct_media: num(r.cc_pct_media),
    pct_residencial: num(r.cc_pct_residencial),
    pct_residencial_plus: num(r.cc_pct_residencial_plus),
  };
  const tierAllNull =
    tier.pct_economica === null &&
    tier.pct_popular === null &&
    tier.pct_tradicional === null &&
    tier.pct_media === null &&
    tier.pct_residencial === null &&
    tier.pct_residencial_plus === null;

  return {
    acciones_total: numReq(r.cc_acciones_total),
    monto_total: numReq(r.cc_monto_total),
    monto_per_accion_avg: numReq(r.cc_monto_per_accion_avg),
    top_intermediario: {
      // Code is TEXT (6-digit CNBV institutional code with leading zero).
      // String() on number would lose the zero — defend by checking type
      // first; in practice the MV ships TEXT and pg-native preserves it.
      code:
        typeof r.cc_top_intermediario_code === "string"
          ? r.cc_top_intermediario_code
          : String(r.cc_top_intermediario_code ?? ""),
      nombre:
        typeof r.cc_top_intermediario_nombre === "string"
          ? r.cc_top_intermediario_nombre
          : String(r.cc_top_intermediario_nombre ?? ""),
      share: numReq(r.cc_top_intermediario_share),
    },
    top_linea_credito_code: num(r.cc_top_linea_credito_code),
    top_esquema_code: num(r.cc_top_esquema_code),
    modalidad: {
      pct_vivienda_nueva: numReq(r.cc_pct_vivienda_nueva),
      pct_mejoramientos: numReq(r.cc_pct_mejoramientos),
      pct_vivienda_usada: numReq(r.cc_pct_vivienda_usada),
      pct_otros: numReq(r.cc_pct_otros),
    },
    demografico: {
      pct_femenino: num(r.cc_pct_femenino),
      pct_indigena: num(r.cc_pct_indigena),
    },
    vivienda_tier: tierAllNull
      ? null
      : {
          pct_economica: tier.pct_economica ?? 0,
          pct_popular: tier.pct_popular ?? 0,
          pct_tradicional: tier.pct_tradicional ?? 0,
          pct_media: tier.pct_media ?? 0,
          pct_residencial: tier.pct_residencial ?? 0,
          pct_residencial_plus: tier.pct_residencial_plus ?? 0,
        },
    periodo:
      typeof r.cc_periodo === "string"
        ? r.cc_periodo
        : String(r.cc_periodo ?? "2025"),
  };
}

/**
 * Marshal SEDATU muni-grain row into the `vivienda_financiamientos` subtree,
 * OR return `null` if the LEFT JOIN missed (no housing-financing activity
 * inside this muni — ~621 of 2,469 munis nationally for 2025).
 *
 * Miss signal: `sf_acciones_total IS NULL` happens ONLY when the LEFT JOIN
 * to `sedatu_financing_by_municipio` doesn't match — the MV's GROUP BY
 * guarantees every present row has a non-null sum (audit W3 round-2
 * follow-up). The `vivienda_tier` subtree returns null when ALL six
 * tier %s are null (= 100% of muni rows had unknown `vivienda_valor`);
 * per-leaf nulls within an otherwise-populated subtree preserve mixed-
 * coverage signals.
 */
function viviendaFinanciamientosFromRow(
  r: Record<string, unknown>,
): ViviendaFinanciamientosResult | null {
  if (r.sf_acciones_total === null || r.sf_acciones_total === undefined) {
    return null;
  }
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const numReq = (v: unknown): number => Number(v);

  const tier = {
    pct_economica: num(r.sf_pct_economica),
    pct_popular: num(r.sf_pct_popular),
    pct_tradicional: num(r.sf_pct_tradicional),
    pct_media: num(r.sf_pct_media),
    pct_residencial: num(r.sf_pct_residencial),
    pct_residencial_plus: num(r.sf_pct_residencial_plus),
  };
  const tierAllNull =
    tier.pct_economica === null &&
    tier.pct_popular === null &&
    tier.pct_tradicional === null &&
    tier.pct_media === null &&
    tier.pct_residencial === null &&
    tier.pct_residencial_plus === null;

  return {
    acciones_total: numReq(r.sf_acciones_total),
    monto_total: numReq(r.sf_monto_total),
    monto_per_accion_avg: numReq(r.sf_monto_per_accion_avg),
    top_organismo: {
      code: numReq(r.sf_top_organismo_code),
      nombre:
        typeof r.sf_top_organismo_nombre === "string"
          ? r.sf_top_organismo_nombre
          : String(r.sf_top_organismo_nombre ?? ""),
      share: numReq(r.sf_top_organismo_share),
    },
    modalidad: {
      pct_vivienda_nueva: numReq(r.sf_pct_vivienda_nueva),
      pct_mejoramientos: numReq(r.sf_pct_mejoramientos),
      pct_vivienda_usada: numReq(r.sf_pct_vivienda_usada),
      pct_otros: numReq(r.sf_pct_otros),
    },
    demografico: {
      pct_femenino: num(r.sf_pct_femenino),
      pct_credito_individual: num(r.sf_pct_credito_individual),
    },
    vivienda_tier: tierAllNull
      ? null
      : {
          pct_economica: tier.pct_economica ?? 0,
          pct_popular: tier.pct_popular ?? 0,
          pct_tradicional: tier.pct_tradicional ?? 0,
          pct_media: tier.pct_media ?? 0,
          pct_residencial: tier.pct_residencial ?? 0,
          pct_residencial_plus: tier.pct_residencial_plus ?? 0,
        },
    // Periodo sourced from the MV column (audit W4 round-2): the MV
    // exposes MIN(ano) from the data itself, so future yearly ingests
    // (2026/2027/etc) don't need a marshaller code change.
    periodo:
      typeof r.sf_periodo === "string"
        ? r.sf_periodo
        : String(r.sf_periodo ?? "2025"),
  };
}

/**
 * GET /analytics/municipio-detail?cve_mun=NNNNN
 *
 * Single-municipio demographic surface — same nested-category shape as
 * /analytics/locality-detail but at muni grain. Driven by `municipios_2025`
 * (the v0.2.10 `censo_municipios` view, ~50 cast cols from the 287-col ITER
 * raw, plus the 9 municipios created 2019–2024).
 *
 * Returns 404 when the cve_mun isn't one of the 2,478 2025 keys (typo or a
 * dissolved muni). The 9 post-2020 municipios (e.g. 24059) return 200 with
 * every census field NULL until EIC 2025 lands. Returns 200 with the
 * full nested structure otherwise — muni-grain almost never hits INEGI's
 * 'N/D' suppression sentinel (only locality rows do), so most fields
 * come back populated.
 *
 * Adds vs locality-detail: education detail breaks primaria/secundaria
 * incompleta vs completa (`p15pri_in`/`p15pri_co`/`p15sec_in`/`p15sec_co`),
 * civil status (`p12ym_*`), disability summary (`pcon_disc`/`pcon_limi`/
 * `psind_lim`), and full asset list including microondas/moto/bici/radio/
 * teléfono fijo/TV de paga/streaming/consola. Drops lat/lon/altitud/tamloc
 * (locality-only attributes).
 */
export async function municipioDetailHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveMun = c.req.query("cve_mun");
  if (!cveMun || !CVE_MUN_RE.test(cveMun)) {
    throw new HttpError(
      `cve_mun inválido "${cveMun ?? ""}". Debe ser 5 dígitos zero-padded (ENT01-32 + MUN001-999).`,
      400,
      "validation.cve_mun",
    );
  }

  const sql = `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    cm.cve_mun, cm.entidad, cm.mun, cm.nom_mun, cm.nom_ent,
    cm.pobtot, cm.pobfem, cm.pobmas, cm.p_60ymas, cm.p_15ymas, cm.p_18ymas,
    cm.pea, cm.pocupada, cm.graproes, cm.tvivhab, cm.tvivpar,
    cm.pcatolica, cm.pro_crieva, cm.potras_rel, cm.psin_relig,
    cm.p3ym_hli, cm.p3hlinhe, cm.p3hli_he, cm.phog_ind, cm.pob_afro,
    cm.pnacent, cm.pnacoe, cm.pres2015, cm.presoe15,
    cm.p15ym_an, cm.p15ym_se, cm.p15pri_in, cm.p15pri_co, cm.p15sec_in, cm.p15sec_co, cm.p18ym_pb,
    cm.p12ym_solt, cm.p12ym_casa, cm.p12ym_sepa,
    cm.pcon_disc, cm.pcon_limi, cm.psind_lim,
    cm.psinder, cm.pder_ss, cm.pder_imss, cm.pder_iste, cm.pder_segp, cm.pder_imssb, cm.pafil_ipriv,
    cm.vph_inter, cm.vph_autom, cm.vph_refri, cm.vph_lavad, cm.vph_hmicro,
    cm.vph_moto, cm.vph_bici, cm.vph_radio, cm.vph_tv, cm.vph_pc, cm.vph_telef, cm.vph_cel,
    cm.vph_stvp, cm.vph_spmvpi, cm.vph_cvj, cm.vph_snbien,
    ${CNBV_MUNI_COLS},
    ${SICT_MUNI_COLS},
    ${SEDATU_MUNI_COLS},
    ${CNBV_CREDITO_MUNI_COLS}
  FROM municipios_2025 cm
  LEFT JOIN cnbv_panorama_municipal cp ON cp.cve_mun = cm.cve_mun
  LEFT JOIN sict_traffic_by_municipio sv ON sv.cve_mun = cm.cve_mun
  LEFT JOIN sedatu_financing_by_municipio sf ON sf.cve_mun = cm.cve_mun
  LEFT JOIN cnbv_credito_by_municipio cc ON cc.cve_mun = cm.cve_mun
  WHERE cm.cve_mun = '${cveMun}'
) t;
`;
  const rows = await runJson<Array<Record<string, string | number | null>>>(
    sql,
    { container: config.dbContainer },
  );
  if (!rows || rows.length === 0) {
    throw new HttpError(
      `municipio no encontrado para cve_mun="${cveMun}".`,
      404,
      "municipio.not_found",
    );
  }
  const r = rows[0];
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);

  const result: MunicipioDetailResult = {
    cve_mun: String(r.cve_mun),
    entidad: String(r.entidad),
    mun: String(r.mun),
    nom_mun: String(r.nom_mun),
    nom_ent: String(r.nom_ent),
    population: {
      pobtot: num(r.pobtot),
      pobfem: num(r.pobfem),
      pobmas: num(r.pobmas),
      p_60ymas: num(r.p_60ymas),
      p_15ymas: num(r.p_15ymas),
      p_18ymas: num(r.p_18ymas),
      pea: num(r.pea),
      pocupada: num(r.pocupada),
      graproes: num(r.graproes),
      tvivhab: num(r.tvivhab),
      tvivpar: num(r.tvivpar),
    },
    religion: {
      pcatolica: num(r.pcatolica),
      pro_crieva: num(r.pro_crieva),
      potras_rel: num(r.potras_rel),
      psin_relig: num(r.psin_relig),
    },
    indigenous_afro: {
      p3ym_hli: num(r.p3ym_hli),
      p3hlinhe: num(r.p3hlinhe),
      p3hli_he: num(r.p3hli_he),
      phog_ind: num(r.phog_ind),
      pob_afro: num(r.pob_afro),
    },
    migration: {
      pnacent: num(r.pnacent),
      pnacoe: num(r.pnacoe),
      pres2015: num(r.pres2015),
      presoe15: num(r.presoe15),
    },
    education: {
      p15ym_an: num(r.p15ym_an),
      p15ym_se: num(r.p15ym_se),
      p15pri_in: num(r.p15pri_in),
      p15pri_co: num(r.p15pri_co),
      p15sec_in: num(r.p15sec_in),
      p15sec_co: num(r.p15sec_co),
      p18ym_pb: num(r.p18ym_pb),
    },
    civil_status: {
      p12ym_solt: num(r.p12ym_solt),
      p12ym_casa: num(r.p12ym_casa),
      p12ym_sepa: num(r.p12ym_sepa),
    },
    disability: {
      pcon_disc: num(r.pcon_disc),
      pcon_limi: num(r.pcon_limi),
      psind_lim: num(r.psind_lim),
    },
    health_coverage: {
      psinder: num(r.psinder),
      pder_ss: num(r.pder_ss),
      pder_imss: num(r.pder_imss),
      pder_iste: num(r.pder_iste),
      pder_segp: num(r.pder_segp),
      pder_imssb: num(r.pder_imssb),
      pafil_ipriv: num(r.pafil_ipriv),
    },
    assets: {
      vph_inter: num(r.vph_inter),
      vph_autom: num(r.vph_autom),
      vph_refri: num(r.vph_refri),
      vph_lavad: num(r.vph_lavad),
      vph_hmicro: num(r.vph_hmicro),
      vph_moto: num(r.vph_moto),
      vph_bici: num(r.vph_bici),
      vph_radio: num(r.vph_radio),
      vph_tv: num(r.vph_tv),
      vph_pc: num(r.vph_pc),
      vph_telef: num(r.vph_telef),
      vph_cel: num(r.vph_cel),
      vph_stvp: num(r.vph_stvp),
      vph_spmvpi: num(r.vph_spmvpi),
      vph_cvj: num(r.vph_cvj),
      vph_snbien: num(r.vph_snbien),
    },
    inclusion_financiera: inclusionFinancieraFromRow(r, "muni"),
    datos_viales: datosVialesFromRow(r),
    vivienda_financiamientos: viviendaFinanciamientosFromRow(r),
    vivienda_credito_comercial: creditoComercialFromRow(r),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

/**
 * GET /analytics/entidad-detail?cve_ent=NN
 *
 * Single-entidad demographic surface — same nested-category shape as
 * /analytics/municipio-detail but at state grain. Backed by the v0.2.10
 * `censo_entidades` view (32 rows, ENTIDAD_RE-validated 01-32).
 *
 * Returns 404 only if the cve_ent isn't found, which in practice means
 * the migration hasn't been applied (every valid entidad code in
 * ENTIDAD_RE has a row). 400 for malformed cve_ent (letters, '00'
 * national-rolled which is intentionally excluded from the view, '33+').
 *
 * Categories mirror muni-detail exactly: population, religion,
 * indigenous_afro, migration, education detail (primaria/secundaria
 * sub-completion), civil_status, disability summary, health_coverage,
 * full asset list.
 */
export async function entidadDetailHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const cveEnt = c.req.query("cve_ent");
  if (!cveEnt || !ENTIDAD_RE.test(cveEnt)) {
    throw new HttpError(
      `cve_ent inválido "${cveEnt ?? ""}". Debe ser 2 dígitos zero-padded (01-32).`,
      400,
      "validation.cve_ent",
    );
  }

  const sql = `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT
    ce.cve_ent, ce.entidad, ce.nom_ent,
    ce.pobtot, ce.pobfem, ce.pobmas, ce.p_60ymas, ce.p_15ymas, ce.p_18ymas,
    ce.pea, ce.pocupada, ce.graproes, ce.tvivhab, ce.tvivpar,
    ce.pcatolica, ce.pro_crieva, ce.potras_rel, ce.psin_relig,
    ce.p3ym_hli, ce.p3hlinhe, ce.p3hli_he, ce.phog_ind, ce.pob_afro,
    ce.pnacent, ce.pnacoe, ce.pres2015, ce.presoe15,
    ce.p15ym_an, ce.p15ym_se, ce.p15pri_in, ce.p15pri_co,
    ce.p15sec_in, ce.p15sec_co, ce.p18ym_pb,
    ce.p12ym_solt, ce.p12ym_casa, ce.p12ym_sepa,
    ce.pcon_disc, ce.pcon_limi, ce.psind_lim,
    ce.psinder, ce.pder_ss, ce.pder_imss, ce.pder_iste,
    ce.pder_segp, ce.pder_imssb, ce.pafil_ipriv,
    ce.vph_inter, ce.vph_autom, ce.vph_refri, ce.vph_lavad, ce.vph_hmicro,
    ce.vph_moto, ce.vph_bici, ce.vph_radio, ce.vph_tv,
    ce.vph_pc, ce.vph_telef, ce.vph_cel,
    ce.vph_stvp, ce.vph_spmvpi, ce.vph_cvj, ce.vph_snbien,
    bl.periodo_cve     AS bl_periodo_cve,
    bl.anio            AS bl_anio,
    bl.trimestre       AS bl_trimestre,
    bl.fecha           AS bl_fecha,
    bl.beneficiarios   AS bl_beneficiarios,
    bl.intervenciones  AS bl_intervenciones,
    bl.dependencias    AS bl_dependencias,
    bl.padrones        AS bl_padrones,
    bl.programas       AS bl_programas,
    ${CNBV_ESTADO_COLS},
    ${SICT_ESTADO_COLS},
    ${SEDATU_ESTADO_COLS},
    ${CNBV_CREDITO_ESTADO_COLS}
  FROM censo_entidades ce
  LEFT JOIN bienestar_estatal_latest bl ON bl.cve_ent = ce.cve_ent
  LEFT JOIN cnbv_panorama_estatal cp ON cp.cve_ent = ce.cve_ent
  LEFT JOIN sict_traffic_by_estado se ON se.cve_ent = ce.cve_ent
  LEFT JOIN sedatu_financing_by_estado sfe ON sfe.cve_ent = ce.cve_ent
  LEFT JOIN cnbv_credito_by_estado cce ON cce.cve_ent = ce.cve_ent
  WHERE ce.cve_ent = '${cveEnt}'
) t;
`;
  const rows = await runJson<Array<Record<string, string | number | null>>>(
    sql,
    { container: config.dbContainer },
  );
  if (!rows || rows.length === 0) {
    throw new HttpError(
      `entidad no encontrada para cve_ent="${cveEnt}".`,
      404,
      "entidad.not_found",
    );
  }
  const r = rows[0];
  const num = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  const str = (v: unknown): string | null =>
    v === null || v === undefined ? null : String(v);

  const result: EntidadDetailResult = {
    cve_ent: String(r.cve_ent),
    entidad: String(r.entidad),
    nom_ent: String(r.nom_ent),
    population: {
      pobtot: num(r.pobtot),
      pobfem: num(r.pobfem),
      pobmas: num(r.pobmas),
      p_60ymas: num(r.p_60ymas),
      p_15ymas: num(r.p_15ymas),
      p_18ymas: num(r.p_18ymas),
      pea: num(r.pea),
      pocupada: num(r.pocupada),
      graproes: num(r.graproes),
      tvivhab: num(r.tvivhab),
      tvivpar: num(r.tvivpar),
    },
    religion: {
      pcatolica: num(r.pcatolica),
      pro_crieva: num(r.pro_crieva),
      potras_rel: num(r.potras_rel),
      psin_relig: num(r.psin_relig),
    },
    indigenous_afro: {
      p3ym_hli: num(r.p3ym_hli),
      p3hlinhe: num(r.p3hlinhe),
      p3hli_he: num(r.p3hli_he),
      phog_ind: num(r.phog_ind),
      pob_afro: num(r.pob_afro),
    },
    migration: {
      pnacent: num(r.pnacent),
      pnacoe: num(r.pnacoe),
      pres2015: num(r.pres2015),
      presoe15: num(r.presoe15),
    },
    education: {
      p15ym_an: num(r.p15ym_an),
      p15ym_se: num(r.p15ym_se),
      p15pri_in: num(r.p15pri_in),
      p15pri_co: num(r.p15pri_co),
      p15sec_in: num(r.p15sec_in),
      p15sec_co: num(r.p15sec_co),
      p18ym_pb: num(r.p18ym_pb),
    },
    civil_status: {
      p12ym_solt: num(r.p12ym_solt),
      p12ym_casa: num(r.p12ym_casa),
      p12ym_sepa: num(r.p12ym_sepa),
    },
    disability: {
      pcon_disc: num(r.pcon_disc),
      pcon_limi: num(r.pcon_limi),
      psind_lim: num(r.psind_lim),
    },
    health_coverage: {
      psinder: num(r.psinder),
      pder_ss: num(r.pder_ss),
      pder_imss: num(r.pder_imss),
      pder_iste: num(r.pder_iste),
      pder_segp: num(r.pder_segp),
      pder_imssb: num(r.pder_imssb),
      pafil_ipriv: num(r.pafil_ipriv),
    },
    assets: {
      vph_inter: num(r.vph_inter),
      vph_autom: num(r.vph_autom),
      vph_refri: num(r.vph_refri),
      vph_lavad: num(r.vph_lavad),
      vph_hmicro: num(r.vph_hmicro),
      vph_moto: num(r.vph_moto),
      vph_bici: num(r.vph_bici),
      vph_radio: num(r.vph_radio),
      vph_tv: num(r.vph_tv),
      vph_pc: num(r.vph_pc),
      vph_telef: num(r.vph_telef),
      vph_cel: num(r.vph_cel),
      vph_stvp: num(r.vph_stvp),
      vph_spmvpi: num(r.vph_spmvpi),
      vph_cvj: num(r.vph_cvj),
      vph_snbien: num(r.vph_snbien),
    },
    bienestar_latest: {
      periodo_cve: str(r.bl_periodo_cve),
      anio: num(r.bl_anio),
      trimestre: str(r.bl_trimestre),
      fecha: str(r.bl_fecha),
      beneficiarios: num(r.bl_beneficiarios),
      intervenciones: num(r.bl_intervenciones),
      dependencias: num(r.bl_dependencias),
      padrones: num(r.bl_padrones),
      programas: num(r.bl_programas),
    },
    inclusion_financiera: inclusionFinancieraFromRow(r, "estado"),
    datos_viales: datosVialesFromRow(r),
    vivienda_financiamientos: viviendaFinanciamientosFromRow(r),
    vivienda_credito_comercial: creditoComercialFromRow(r),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/locust-muni?entidad=XX
//
// Wide muni-grain row aggregator. One LEFT-JOIN-anchored row per muni,
// pulling pre-aggregated columns from every source view/matview we have
// at muni grain. The anchor is municipios_2025 (2,478 keys), so the 9
// municipios created after Censo 2020 (24059 Villa de Pozos, ...) keep
// their DENUE / CLUES / CE rows with NULL census fields instead of
// dropping out (docs/EIC-2025-RECON-2026-09-28.md §3). Powers Locust mode: declaring a field via
// `endpoints["locust-muni"]: <col>` makes it joinable with every other
// field on this payload.
//
// Performance: each LEFT JOIN is on indexed cve_mun. Measured ~350-450ms
// warm for muni-heavy states (Oaxaca 570 munis); ~200ms for CDMX (16
// munis). Cache-Control sets max-age=300, so per-entidad responses warm
// quickly across users. The DISTINCT ON on `sinba_latest` is load-bearing
// (mv_sinba_morbidity_municipal keys on (cve_mun, anio)); the DISTINCT ON on
// cnbv_latest / sedatu_latest is defensive forward-compat (today both
// source matviews have UNIQUE(cve_mun); the projection is a no-op until
// they ingest multi-year history).
// ---------------------------------------------------------------------------

interface RawLocustMuniRow {
  cve_mun: string;
  municipio: string | null;
  poblacion: number | string | null;
  pea: number | string | null;
  graproes: number | string | null;
  pct_pea: number | string | null;
  pct_sin_cobertura_salud: number | string | null;
  denue_establecimientos: number | string;
  denue_farmacias: number | string;
  unidades_clues: number | string;
  pobreza_pct: number | string | null;
  pobreza_extrema_pct: number | string | null;
  carencia_acceso_salud_pct: number | string | null;
  irs_indice: number | string | null;
  irs_grado: string | null;
  ce2024_ue: number | string | null;
  ce2024_personal_ocupado: number | string | null;
  ce2024_valor_agregado: number | string | null;
  sinba_dm2_promedio: number | string | null;
  sinba_hta_promedio: number | string | null;
  sinba_obesidad_promedio: number | string | null;
  cofepris_total_licenciadas: number | string | null;
  cofepris_con_estupefacientes: number | string | null;
  sict_tdpa_total: number | string | null;
  cnbv_monto_total: number | string | null;
  cnbv_pct_femenino: number | string | null;
  sedatu_monto_total: number | string | null;
  sedatu_acciones_total: number | string | null;
}

function locustMuniSql(entidad: string, sinbaRel: SinbaMorbidityRel): string {
  return `
WITH denue_agg AS (
  SELECT
    area_geo AS cve_mun,
    COUNT(*)::bigint AS denue_establecimientos,
    COUNT(*) FILTER (WHERE clase_actividad_id IN (${FARMACIA_CLASES_SQL}))::bigint AS denue_farmacias
  FROM establecimientos
  WHERE entidad = '${entidad}' AND area_geo IS NOT NULL
  GROUP BY area_geo
),
clues_agg AS (
  SELECT cve_mun, COUNT(*)::bigint AS unidades_clues
  FROM clues
  WHERE ${entidadCveMunRangeSql("cve_mun", entidad)}
  GROUP BY cve_mun
),
ce2024_totals AS (
  -- The "TOTAL DE SECTOR" all-strata rollup row uses sector IS NULL +
  -- id_estrato IS NULL (NOT sector = '00' — the loader at scripts/
  -- load-ce2024.ts:204 applies NULLIF(sector, '') and the source CSV
  -- represents rollups with an empty SECTOR field). One row per cve_mun.
  -- C1 audit fix 2026-05-12: prior 'WHERE sector = ''00''' returned 0 rows,
  -- silently NULLing all CE 2024 fields in /locust-muni responses.
  SELECT cve_mun, ue, personal_ocupado_total, valor_agregado_censal_bruto
  FROM ce2024_municipal
  WHERE sector IS NULL AND id_estrato IS NULL AND cve_ent = '${entidad}'
),
sinba_latest AS (
  SELECT DISTINCT ON (cve_mun)
    cve_mun, casos_dm2_promedio, casos_hta_promedio, casos_obesidad_promedio
  FROM ${sinbaRel}
  WHERE ${entidadCveMunRangeSql("cve_mun", entidad)}
  ORDER BY cve_mun, anio DESC
),
cnbv_latest AS (
  SELECT DISTINCT ON (cve_mun) cve_mun, monto_total, pct_femenino
  FROM cnbv_credito_by_municipio
  WHERE cve_ent = '${entidad}'
  ORDER BY cve_mun, periodo DESC
),
sedatu_latest AS (
  SELECT DISTINCT ON (cve_mun) cve_mun, monto_total, acciones_total
  FROM sedatu_financing_by_municipio
  WHERE cve_ent = '${entidad}'
  ORDER BY cve_mun, periodo DESC
)
SELECT json_agg(row_to_json(t) ORDER BY t.denue_establecimientos DESC NULLS LAST) FROM (
  SELECT
    cm.cve_mun,
    cm.nom_mun AS municipio,
    cm.pobtot AS poblacion,
    cm.pea,
    cm.graproes,
    -- #67: Censo PEA covers ages 12+, so the participation-rate basis is
    -- p_12ymas (p_15ymas mixed age universes and overstated every muni).
    ROUND(cm.pea::numeric / NULLIF(cm.p_12ymas, 0) * 100, 2) AS pct_pea,
    CASE
      WHEN cm.pobtot IS NOT NULL AND cm.pobtot > 0
      THEN ROUND((cm.psinder::numeric / cm.pobtot) * 100, 2)
      ELSE NULL
    END AS pct_sin_cobertura_salud,
    COALESCE(d.denue_establecimientos, 0) AS denue_establecimientos,
    COALESCE(d.denue_farmacias, 0) AS denue_farmacias,
    COALESCE(c.unidades_clues, 0) AS unidades_clues,
    p.pobreza_pct,
    p.pobreza_extrema_pct,
    p.carencia_acceso_salud_pct,
    i.irs_indice,
    i.irs_grado,
    ce.ue AS ce2024_ue,
    ce.personal_ocupado_total AS ce2024_personal_ocupado,
    ce.valor_agregado_censal_bruto AS ce2024_valor_agregado,
    s.casos_dm2_promedio AS sinba_dm2_promedio,
    s.casos_hta_promedio AS sinba_hta_promedio,
    s.casos_obesidad_promedio AS sinba_obesidad_promedio,
    cof.total_licenciadas AS cofepris_total_licenciadas,
    cof.con_estupefacientes AS cofepris_con_estupefacientes,
    sict.tdpa_total AS sict_tdpa_total,
    cn.monto_total AS cnbv_monto_total,
    cn.pct_femenino AS cnbv_pct_femenino,
    sed.monto_total AS sedatu_monto_total,
    sed.acciones_total AS sedatu_acciones_total
  FROM municipios_2025 cm
  LEFT JOIN denue_agg d ON d.cve_mun = cm.cve_mun
  LEFT JOIN clues_agg c ON c.cve_mun = cm.cve_mun
  LEFT JOIN coneval_pobreza_municipal p ON p.cve_mun = cm.cve_mun
  LEFT JOIN coneval_irs_municipal i ON i.cve_mun = cm.cve_mun
  LEFT JOIN ce2024_totals ce ON ce.cve_mun = cm.cve_mun
  LEFT JOIN sinba_latest s ON s.cve_mun = cm.cve_mun
  LEFT JOIN cofepris_farmacias_by_municipio cof ON cof.cve_mun = cm.cve_mun
  LEFT JOIN sict_traffic_by_municipio sict ON sict.cve_mun = cm.cve_mun
  LEFT JOIN cnbv_latest cn ON cn.cve_mun = cm.cve_mun
  LEFT JOIN sedatu_latest sed ON sed.cve_mun = cm.cve_mun
  WHERE cm.entidad = '${entidad}'
) t;
`;
}

export async function locustMuniHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const entidad = c.req.query("entidad");
  if (!entidad || !ENTIDAD_RE.test(entidad)) {
    throw new HttpError(
      `entidad inválida "${entidad ?? ""}"`,
      400,
      "validation.entidad",
    );
  }
  const rows = await runJsonQueryMvFirst<RawLocustMuniRow[]>(
    config,
    locustMuniSql(entidad, SINBA_MORBIDITY_MV),
    locustMuniSql(entidad, SINBA_MORBIDITY_VIEW),
  );
  const num = (v: number | string | null | undefined): number | null =>
    v === null || v === undefined ? null : Number(v);
  const result: LocustMuniResult = {
    entidad,
    municipios: rows.map((r) => ({
      cve_mun: r.cve_mun,
      municipio: r.municipio,
      poblacion: num(r.poblacion),
      pea: num(r.pea),
      graproes: num(r.graproes),
      pct_pea: num(r.pct_pea),
      pct_sin_cobertura_salud: num(r.pct_sin_cobertura_salud),
      denue_establecimientos: Number(r.denue_establecimientos),
      denue_farmacias: Number(r.denue_farmacias),
      unidades_clues: Number(r.unidades_clues),
      pobreza_pct: num(r.pobreza_pct),
      pobreza_extrema_pct: num(r.pobreza_extrema_pct),
      carencia_acceso_salud_pct: num(r.carencia_acceso_salud_pct),
      irs_indice: num(r.irs_indice),
      irs_grado: r.irs_grado ? normalizeGrado(r.irs_grado) : null,
      ce2024_ue: num(r.ce2024_ue),
      ce2024_personal_ocupado: num(r.ce2024_personal_ocupado),
      ce2024_valor_agregado: num(r.ce2024_valor_agregado),
      sinba_dm2_promedio: num(r.sinba_dm2_promedio),
      sinba_hta_promedio: num(r.sinba_hta_promedio),
      sinba_obesidad_promedio: num(r.sinba_obesidad_promedio),
      cofepris_total_licenciadas: num(r.cofepris_total_licenciadas),
      cofepris_con_estupefacientes: num(r.cofepris_con_estupefacientes),
      sict_tdpa_total: num(r.sict_tdpa_total),
      cnbv_monto_total: num(r.cnbv_monto_total),
      cnbv_pct_femenino: num(r.cnbv_pct_femenino),
      sedatu_monto_total: num(r.sedatu_monto_total),
      sedatu_acciones_total: num(r.sedatu_acciones_total),
    })),
  };
  c.header("Cache-Control", "private, max-age=300");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/locust-estado
//
// 32-row estado-grain composite. Latest-year ENOE + ENIGH per entidad
// via LATERAL subqueries. Powers Locust's estado-grain reachability for
// fields that don't fit /analytics/national-treemap.
// ---------------------------------------------------------------------------

interface RawLocustEstadoRow {
  cve_ent: string;
  nom_ent: string;
  enoe_tasa_informalidad: number | string | null;
  enoe_tasa_desocupacion: number | string | null;
  enigh_ingreso_p50: number | string | null;
  enigh_pct_gasto_alimentos: number | string | null;
}

const LOCUST_ESTADO_SQL = `
SELECT json_agg(row_to_json(t) ORDER BY t.cve_ent) FROM (
  SELECT
    en.entidad AS cve_ent,
    en.nom_ent,
    enoe.tasa_informalidad AS enoe_tasa_informalidad,
    enoe.tasa_desocupacion AS enoe_tasa_desocupacion,
    enigh.ingreso_corriente_mediana AS enigh_ingreso_p50,
    enigh.pct_gasto_alimentos AS enigh_pct_gasto_alimentos
  FROM censo_entidades en
  LEFT JOIN LATERAL (
    SELECT tasa_informalidad, tasa_desocupacion
    FROM calibrators_enoe_state
    WHERE entidad = en.entidad
    ORDER BY ano_levantamiento DESC
    LIMIT 1
  ) enoe ON true
  LEFT JOIN LATERAL (
    SELECT ingreso_corriente_mediana, pct_gasto_alimentos
    FROM calibrators_enigh_state
    WHERE entidad = en.entidad
    ORDER BY ano_levantamiento DESC
    LIMIT 1
  ) enigh ON true
) t;
`;

export async function locustEstadoHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const rows = await runJson<RawLocustEstadoRow[]>(LOCUST_ESTADO_SQL, {
    container: config.dbContainer,
  });
  const num = (v: number | string | null | undefined): number | null =>
    v === null || v === undefined ? null : Number(v);
  const result: LocustEstadoResult = {
    entidades: rows.map((r) => ({
      cve_ent: r.cve_ent,
      nom_ent: r.nom_ent,
      enoe_tasa_informalidad: num(r.enoe_tasa_informalidad),
      enoe_tasa_desocupacion: num(r.enoe_tasa_desocupacion),
      enigh_ingreso_p50: num(r.enigh_ingreso_p50),
      enigh_pct_gasto_alimentos: num(r.enigh_pct_gasto_alimentos),
    })),
  };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// GET /resolve/ageb?lat=&lon= — point → AGEB resolution.
//
// Uncharted Lite Phase-2 dependency: colonia is a free-text label with no
// geometry, so address validation must land on an AGEB polygon. ST_Intersects
// against ageb_polygons (81k MultiPolygons, GIST-indexed) resolves a
// geocoded point to the 13-char (urban) / 9-char (rural) cvegeo plus the
// 5-digit cve_mun the analytics endpoints key on.
// ---------------------------------------------------------------------------

// Digits/dot/minus only — the regex is what makes inlining into SQL safe,
// same stance as ENTIDAD_RE/CVE_MUN_RE literals elsewhere in this file.
const COORD_LAT_RE = /^-?[0-9]{1,2}(\.[0-9]{1,10})?$/;
const COORD_LON_RE = /^-?[0-9]{1,3}(\.[0-9]{1,10})?$/;
// Mexico bounding box (generous, islands included). Out-of-country points
// get an honest 400 instead of a wasted spatial scan + confusing 404.
const MX_LAT_MIN = 14.3;
const MX_LAT_MAX = 33.0;
const MX_LON_MIN = -118.6;
const MX_LON_MAX = -86.5;

// #71: ST_Intersects includes the boundary, so a point on a shared AGEB edge
// resolves (the Contains predicate excluded it -> 404); ORDER BY cvegeo makes
// the pick between the touching AGEBs deterministic.
function resolveAgebSql(lat: string, lon: string): string {
  return `
SELECT json_agg(row_to_json(r)) FROM (
  SELECT
    cvegeo,
    NULLIF(TRIM(ambito), '') AS ambito,
    (cve_ent || cve_mun) AS cve_mun
  FROM ageb_polygons
  WHERE ST_Intersects(geom, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326))
  ORDER BY cvegeo
  LIMIT 1
) r;
`;
}

interface RawResolveAgebRow {
  cvegeo: string;
  ambito: string | null;
  cve_mun: string;
}

export async function resolveAgebHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const lat = c.req.query("lat") ?? "";
  const lon = c.req.query("lon") ?? "";
  if (!COORD_LAT_RE.test(lat)) {
    throw new HttpError(
      `lat inválida "${lat}". Debe ser un decimal (p.ej. 19.4326).`,
      400,
      "validation.lat",
    );
  }
  if (!COORD_LON_RE.test(lon)) {
    throw new HttpError(
      `lon inválida "${lon}". Debe ser un decimal (p.ej. -99.1332).`,
      400,
      "validation.lon",
    );
  }
  const latN = Number(lat);
  const lonN = Number(lon);
  if (
    latN < MX_LAT_MIN ||
    latN > MX_LAT_MAX ||
    lonN < MX_LON_MIN ||
    lonN > MX_LON_MAX
  ) {
    throw new HttpError(
      `(${lat}, ${lon}) cae fuera de México.`,
      400,
      "validation.out_of_bounds",
    );
  }

  const rows = await runJson<RawResolveAgebRow[]>(resolveAgebSql(lat, lon), {
    container: config.dbContainer,
  });
  if (rows.length === 0) {
    throw new HttpError(
      `Ningún AGEB del Marco Geoestadístico contiene el punto (${lat}, ${lon}).`,
      404,
      "resolve.no_ageb",
    );
  }
  const row = rows[0]!;
  const result: ResolveAgebResult = {
    lat: latN,
    lon: lonN,
    cvegeo: row.cvegeo,
    ambito:
      row.ambito === "Urbana" || row.ambito === "Rural" ? row.ambito : null,
    cve_mun: row.cve_mun,
  };
  // Polygons are static between Marco Geoestadístico releases — long cache.
  // private (#26): the URL carries the caller's geocode, which must never be
  // stored by a shared cache.
  c.header("Cache-Control", "private, max-age=86400");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(result);
}
