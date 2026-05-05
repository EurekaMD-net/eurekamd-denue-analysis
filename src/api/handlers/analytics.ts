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
 *     Monthly SESNSP time series (~135 points 2015-01..2026-03) for one
 *     municipio. Reads sesnsp_delitos_municipal directly via cve_mun btree.
 *
 * Caching: national queries are extremely static (max-age=3600 = 1 hour).
 * Per-entidad query is lightly more dynamic (max-age=300 = 5 min) since
 * a re-run of the DENUE pipeline could shift counts. risk-summary uses
 * max-age=300 to bound staleness when the operator forgets to refresh
 * mv_delitos_municipal_yearly after a SESNSP loader rerun (audit M2).
 *
 * SQL is built with bound parameters via psql -v + a CHECK regex on the
 * caller's `entidad` arg — same defense as the other handlers (ENTIDAD_RE
 * gate before the SQL ever sees the value). risk-* endpoints add
 * RISK_ANO_RE + CVE_MUN_RE for their respective inputs.
 */

import { execFileSync } from "node:child_process";
import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
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
  type SectorGradeMatrixResult,
  type StateCalibratorsResult,
  type StateCalibratorsRow,
  type TopSectorsResult,
} from "../types.js";
import { ESTADOS, type EstadoClave } from "../../extractor/types.js";
import { loadScianNames } from "./sectors.js";

// Defense in depth: a final allowlist for any value we expand into psql -c.
const SAFE_CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;
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

/**
 * Detect whether a postgres error is the "relation does not exist"
 * fingerprint (psql code 42P01). Used by analytics handlers to fall
 * back from a missing mat-view to the live aggregation. We test the
 * combined message+stderr so it works regardless of which path the
 * error text arrived through (formatPsqlError appends both).
 *
 * Audit hardening note: this is a substring check, not a code match —
 * but `runJsonQuery` already wraps the throw in HttpError("postgres.error")
 * so this helper only sees postgres-origin errors. Safe.
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
 * Format a thrown error into a 502-message-friendly string, surfacing
 * the spawned process's stderr when present. execFileSync attaches
 * stderr to the thrown Error as a Buffer; some non-Node runtimes ship
 * it as a string. When stderr is absent (e.g., timeout, EAGAIN, OOM)
 * we fall back to err.message.
 *
 * Audit Locust-R1 (2026-05-04). Exported so tests can cover all 3
 * branches without needing to actually throw inside execFileSync (which
 * trips a vitest 4 unhandled-exception quirk in this codebase).
 */
export function formatPsqlError(err: unknown): string {
  const baseMsg = err instanceof Error ? err.message : String(err);
  const stderr = (err as { stderr?: unknown }).stderr;
  let stderrText = "";
  if (stderr instanceof Buffer) {
    stderrText = stderr.toString("utf-8").trim();
  } else if (typeof stderr === "string") {
    stderrText = stderr.trim();
  }
  return stderrText
    ? `${baseMsg} | psql stderr: ${stderrText.slice(0, 500)}`
    : baseMsg;
}

function runJsonQuery<T>(config: ApiServerConfig, sql: string): T {
  if (!SAFE_CONTAINER_RE.test(config.dbContainer)) {
    throw new HttpError(
      `analytics: dbContainer inválido "${config.dbContainer}"`,
      500,
      "config.bad_container",
    );
  }
  let stdout: string;
  try {
    stdout = execFileSync(
      "docker",
      [
        "exec",
        config.dbContainer,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-t",
        "-A",
        "-c",
        sql,
      ],
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch (err) {
    throw new HttpError(
      `analytics query failed: ${formatPsqlError(err)}`,
      502,
      "postgres.error",
    );
  }
  if (!stdout || stdout === "null") return [] as unknown as T;
  try {
    return JSON.parse(stdout) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      `analytics: malformed JSON from psql: ${msg}`,
      502,
      "postgres.parse_error",
    );
  }
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
export function runJsonQueryMvFirst<T>(
  config: ApiServerConfig,
  mvSql: string,
  liveSql: string,
): T {
  try {
    return runJsonQuery<T>(config, mvSql);
  } catch (err) {
    if (isRelationMissingError(err)) {
      return runJsonQuery<T>(config, liveSql);
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
// "Fully reported" = COUNT(DISTINCT mes) = 12 across all municipios for
// that year. Partial years (e.g. 2026 with only Q1 reported) intentionally
// do NOT win — comparing partial 2026 vs full 2020 baseline produces
// misleading change percentages. Operator can still pass `?ano=2026`
// explicitly when they want partial-year data.
// ---------------------------------------------------------------------------

const CURRENT_RISK_ANO_LIVE_SQL = `
SELECT json_build_array(MAX(ano)) FROM (
  SELECT ano
  FROM sesnsp_delitos_municipal
  WHERE ano <= EXTRACT(YEAR FROM NOW())::int
  GROUP BY ano
  HAVING COUNT(DISTINCT mes) = 12
) t;
`;

/**
 * Resolve the "latest fully-reported year" for risk-summary defaults.
 * Synchronous — uses the same execFileSync path as the handlers. Always
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
    raw = runJsonQuery<number[] | null>(config, sql);
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
  WHERE entidad IS NOT NULL
  GROUP BY entidad
),
entidad_irs AS (
  SELECT
    LEFT(cve_mun, 2) AS entidad,
    irs_grado,
    COUNT(*)::int AS muns_with_grade,
    ROW_NUMBER() OVER (PARTITION BY LEFT(cve_mun, 2) ORDER BY COUNT(*) DESC) AS rn
  FROM coneval_irs_municipal
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
  const rows = runJsonQueryMvFirst<RawNationalRow[]>(
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
  const rows = runJsonQueryMvFirst<RawMatrixCell[]>(
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
    COUNT(*) FILTER (WHERE clase_actividad_id LIKE '4659%')::bigint AS farmacias
  FROM establecimientos
  WHERE entidad = '${entidad}' AND area_geo IS NOT NULL
  GROUP BY area_geo
),
clues_counts AS (
  SELECT cve_mun, COUNT(*)::bigint AS unidades_clues
  FROM clues
  WHERE LEFT(cve_mun, 2) = '${entidad}'
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
  LEFT JOIN censo_municipios cm ON cm.cve_mun = e.cve_mun
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
  const rows = runJsonQuery<RawMunicipioRow[]>(config, municipiosSql(entidad));
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
  c.header("Cache-Control", "public, max-age=300");
  c.header("Vary", "X-Api-Key");
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
  const rawLimit = c.req.query("limit");
  let limit = TOP_SECTORS_DEFAULT;
  if (rawLimit !== undefined) {
    const n = parseInt(rawLimit, 10);
    if (!Number.isFinite(n) || n < 1 || n > TOP_SECTORS_MAX) {
      throw new HttpError(
        `limit inválido "${rawLimit}". Rango: 1..${TOP_SECTORS_MAX}`,
        400,
        "validation.limit",
      );
    }
    limit = n;
  }

  const rows = runJsonQuery<RawTopSectorRow[]>(
    config,
    topSectorsSql(entidad, limit),
  );
  const names = loadScianNames();
  const result: TopSectorsResult = {
    entidad,
    sectors: rows.map((r) => ({
      scian: r.scian,
      name: names.sectors[r.scian] ?? `(SCIAN ${r.scian} — sin etiqueta)`,
      count: Number(r.count),
    })),
  };
  c.header("Cache-Control", "public, max-age=300");
  c.header("Vary", "X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// /analytics/risk-summary?entidad=NN[&ano=YYYY&baseline_ano=YYYY]
//
// Per-municipio risk profile for one state. Reads mv_delitos_municipal_yearly
// (~28k rows total, ~50-500 rows per state) joined to censo_municipios for
// population normalization. Returns one row per municipio with current-year
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
  WHERE LEFT(cve_mun, 2) = '${entidad}' AND ano = ${currentAno}
),
baseline AS (
  SELECT cve_mun, total_delitos AS total_baseline
  FROM mv_delitos_municipal_yearly
  WHERE LEFT(cve_mun, 2) = '${entidad}' AND ano = ${baselineAno}
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
  LEFT JOIN censo_municipios cm USING (cve_mun)
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
  WHERE LEFT(cve_mun, 2) = '${entidad}' AND ano = ${currentAno}
  GROUP BY cve_mun
),
baseline AS (
  SELECT cve_mun, SUM(count)::bigint AS total_baseline
  FROM sesnsp_delitos_municipal
  WHERE LEFT(cve_mun, 2) = '${entidad}' AND ano = ${baselineAno}
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
  LEFT JOIN censo_municipios cm USING (cve_mun)
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

  // Mat-view first → falls back to live aggregation if the operator hasn't
  // run scripts/perf-matviews.sql yet. Same pattern as nationalTreemapHandler.
  const rows = runJsonQueryMvFirst<RawRiskSummaryRow[]>(
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
  c.header("Cache-Control", "public, max-age=300");
  c.header("Vary", "X-Api-Key");
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
  FROM censo_municipios
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

  const series = runJsonQuery<RawRiskTrendPoint[]>(
    config,
    riskTrendSql(cveMun),
  );
  const meta = runJsonQuery<RawMunicipioMeta[]>(
    config,
    municipioMetaSql(cveMun),
  );
  const metaRow = meta[0] ?? null;

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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// Mortality (EDR/SINAIS) — v0.2.3-A. Same architectural shape as the risk
// surface: a current-ano resolver at boot + mat-view-first reads with a
// live aggregation fallback against `inegi_edr_defunciones_raw`.
// ---------------------------------------------------------------------------

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
  const fromLive = tryResolveAno(config, CURRENT_MORTALITY_ANO_LIVE_SQL);
  if (fromLive !== null) return { ano: fromLive, source: "data" };
  return { ano: MORTALITY_DEFAULT_CURRENT_ANO, source: "fallback" };
}

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
  LEFT JOIN censo_municipios cm USING (cve_mun)
  WHERE LEFT(m.cve_mun, 2) = '${entidad}' AND m.ano = ${ano}
) t;
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
WITH muni AS (
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
  LEFT JOIN censo_municipios cm USING (cve_mun)
) t;
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

  const rows = runJsonQueryMvFirst<RawMortalitySummaryRow[]>(
    config,
    mortalitySummaryMvSql(entidad, ano),
    mortalitySummaryLiveSql(entidad, ano),
  );

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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
  GROUP BY NULLIF(anio_ocur, '')::int
) t;
`;
}

function mortalityTrendMetaSql(cveMun: string): string {
  // Audit C1 (2026-05-05): use json_agg + index-into-array, mirroring
  // riskTrendHandler. row_to_json on a 0-row inner SELECT emits an empty
  // stdout string that runJsonQuery normalizes to `[]` — the handler then
  // dereferences `meta?.municipio` on what's actually an array. Today
  // it works by accident; multi-row censo (or a json shape change)
  // could break it silently.
  return `
SELECT json_agg(row_to_json(t)) FROM (
  SELECT nom_mun AS municipio, pobtot AS poblacion
  FROM censo_municipios
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
  const series = runJsonQueryMvFirst<RawMortalityTrendPoint[]>(
    config,
    mortalityTrendSql(cveMun),
    mortalityTrendLiveSql(cveMun),
  );
  // Audit C1: meta SQL now returns json_agg([]) — match riskTrendHandler's shape.
  const metaRows = runJsonQuery<RawMortalityTrendMeta[]>(
    config,
    mortalityTrendMetaSql(cveMun),
  );
  const meta = metaRows[0] ?? null;

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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
  // avoids the C1-class shape bug where runJsonQuery normalizes empty
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
    const rows = runJsonQuery<RawStateCalibratorsRow[]>(
      config,
      stateCalibratorsSql(entidad),
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
  return c.json(result);
}

// ---------------------------------------------------------------------------
// AGEB analytics primitive (v0.2.4-A, 2026-05-05)
// Spatial + count endpoints exposing the existing `ageb_polygons` ×
// `establecimientos.ageb` × `clues_raw` infrastructure. No new tables — this
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
SELECT json_agg(row_to_json(t) ORDER BY ${AGEBS_ORDER_BY_SQL[orderBy]} NULLS LAST) FROM (
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
    WHERE area_geo = '${cveMun}' AND ageb IS NOT NULL AND ageb != ''
    GROUP BY ageb
  ) e ON e.ageb = a.cvegeo
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE area_geo = '${cveMun}' AND ageb IS NOT NULL AND ageb != ''
      AND clase_actividad_id IN ('464111','464112')
    GROUP BY ageb
  ) f ON f.ageb = a.cvegeo
  LEFT JOIN (
    SELECT a2.cvegeo, COUNT(*) AS cnt
    FROM ageb_polygons a2
    JOIN clues_raw c ON ST_Contains(
      a2.geom,
      ST_SetSRID(ST_MakePoint(
        NULLIF(c.longitud, '')::numeric,
        NULLIF(c.latitud, '')::numeric
      ), 4326)
    )
    WHERE a2.cve_ent || a2.cve_mun = '${cveMun}'
      AND c.longitud ~ '^-?[0-9]+\\.?[0-9]*$'
      AND c.latitud ~ '^-?[0-9]+\\.?[0-9]*$'
    GROUP BY a2.cvegeo
  ) s ON s.cvegeo = a.cvegeo
  WHERE a.cve_ent || a.cve_mun = '${cveMun}'
  ORDER BY ${AGEBS_ORDER_BY_SQL[orderBy]} NULLS LAST
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
  if (limitRaw !== undefined) {
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

  const rows = runJsonQuery<RawAgebsByMunicipioRow[]>(
    config,
    agebsByMunicipioSql(cveMun, orderBy, limit),
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
    COUNT(*) FILTER (WHERE clase_actividad_id IN ('464111','464112'))::bigint
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
  // ST_Contains uses gist index on ageb_polygons.geom and is fast for a
  // single AGEB lookup. Filter clues_raw to numeric-safe lat/lon first.
  return `
SELECT json_agg(row_to_json(t) ORDER BY t.clues) FROM (
  SELECT
    c.clues,
    c.nombre_de_la_unidad AS nombre,
    c.nombre_tipo_establecimiento AS tipo,
    NULLIF(c.latitud, '')::numeric AS lat,
    NULLIF(c.longitud, '')::numeric AS lon
  FROM ageb_polygons a
  JOIN clues_raw c ON ST_Contains(
    a.geom,
    ST_SetSRID(ST_MakePoint(
      NULLIF(c.longitud, '')::numeric,
      NULLIF(c.latitud, '')::numeric
    ), 4326)
  )
  WHERE a.cvegeo = '${cvegeo}'
    AND c.longitud ~ '^-?[0-9]+\\.?[0-9]*$'
    AND c.latitud ~ '^-?[0-9]+\\.?[0-9]*$'
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
  JOIN clues_raw c ON ST_Contains(
    a.geom,
    ST_SetSRID(ST_MakePoint(
      NULLIF(c.longitud, '')::numeric,
      NULLIF(c.latitud, '')::numeric
    ), 4326)
  )
  WHERE a.cvegeo = '${cvegeo}'
    AND c.longitud ~ '^-?[0-9]+\\.?[0-9]*$'
    AND c.latitud ~ '^-?[0-9]+\\.?[0-9]*$'
) t;
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
      `cvegeo inválido "${cvegeo ?? ""}". Debe ser exactamente 13 dígitos.`,
      400,
      "validation.cvegeo",
    );
  }

  const idRows = runJsonQuery<RawAgebDetailIdentity[]>(
    config,
    agebIdentitySql(cvegeo),
  );
  const id = idRows[0];
  if (!id) {
    throw new HttpError(
      `AGEB no encontrada: cvegeo "${cvegeo}".`,
      404,
      "ageb.not_found",
    );
  }

  const locMeta = runJsonQuery<RawAgebDetailLocMeta[]>(
    config,
    agebLocMetaSql(cvegeo),
  );
  const summaryRows = runJsonQuery<RawAgebDetailEstabSummary[]>(
    config,
    agebEstabSummarySql(cvegeo),
  );
  const sectors = runJsonQuery<RawAgebDetailTopSector[]>(
    config,
    agebTopSectorsSql(cvegeo, 10),
  );
  const cluesSample = runJsonQuery<RawAgebDetailClues[]>(
    config,
    agebCluesSql(cvegeo, AGEB_DETAIL_CLUES_CAP),
  );
  const cluesCountRows = runJsonQuery<number[] | null>(
    config,
    agebCluesCountSql(cvegeo),
  );
  const cluesCount = Array.isArray(cluesCountRows)
    ? Number(cluesCountRows[0] ?? 0)
    : 0;
  // v0.2.4-B: AGEB-level census from censo_ageb. May be missing for rural
  // AGEBs not in RESAGEBURB urbana — falls back to null/loc_population.
  const censusRows = runJsonQuery<RawAgebCensusRow[]>(
    config,
    agebCensusSql(cvegeo),
  );
  const censusRow = censusRows[0];
  // v0.2.6: CONEVAL Grado de Rezago Social at AGEB granularity. ~95% coverage
  // of urban AGEBs; null for rural / post-2020 subdivisions. Resolves the
  // muni-IRS-applied-to-AGEB statistical-noise trap (Iztapalapa AGEBs span
  // Muy bajo to Muy alto rezago — muni-level IRS hides this entirely).
  const rezagoRows = runJsonQuery<RawAgebRezagoRow[]>(
    config,
    agebRezagoSql(cvegeo),
  );
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
) DESC NULLS LAST) FROM (
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
    WHERE area_geo = '${cveMun}' AND ageb IS NOT NULL AND ageb != ''
    GROUP BY ageb
  ) e ON e.ageb = a.cvegeo
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE area_geo = '${cveMun}' AND ageb IS NOT NULL AND ageb != ''
      AND clase_actividad_id IN ('464111','464112')
    GROUP BY ageb
  ) f ON f.ageb = a.cvegeo
  LEFT JOIN (
    SELECT a2.cvegeo, COUNT(*) AS cnt
    FROM ageb_polygons a2
    JOIN clues_raw c ON ST_Contains(
      a2.geom,
      ST_SetSRID(ST_MakePoint(
        NULLIF(c.longitud, '')::numeric,
        NULLIF(c.latitud, '')::numeric
      ), 4326)
    )
    WHERE a2.cve_ent || a2.cve_mun = '${cveMun}'
      AND c.longitud ~ '^-?[0-9]+\\.?[0-9]*$'
      AND c.latitud ~ '^-?[0-9]+\\.?[0-9]*$'
    GROUP BY a2.cvegeo
  ) s ON s.cvegeo = a.cvegeo
  LEFT JOIN censo_ageb cab ON cab.cvegeo = a.cvegeo
  WHERE a.cve_ent || a.cve_mun = '${cveMun}'
  ORDER BY (
    COALESCE(s.cnt, 0) * 0.5
    + COALESCE(e.cnt, 0) * 0.3
    - COALESCE(f.cnt, 0) * 1.0
  ) DESC NULLS LAST
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
  if (limitRaw !== undefined) {
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

  const rows = runJsonQuery<RawAgebOpportunityRow[]>(
    config,
    agebFarmaciaOpportunitySql(cveMun, limit),
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
  if (raw === undefined) return defaultLimit;
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
    .replace(/COALESCE\(e\.cnt, 0\)/g, "r.total_estab")}) FROM (
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
    WHERE area_geo = '${cveMun}' AND ageb IS NOT NULL AND ageb != ''
    GROUP BY ageb
  ) e ON e.ageb = a.cvegeo
  LEFT JOIN (
    SELECT ageb, COUNT(*) AS cnt FROM establecimientos
    WHERE area_geo = '${cveMun}' AND ageb IS NOT NULL AND ageb != ''
      AND ${scianColumn} IN (${inList})
    GROUP BY ageb
  ) t ON t.ageb = a.cvegeo
  LEFT JOIN censo_ageb cab ON cab.cvegeo = a.cvegeo
  LEFT JOIN coneval_grs_ageb cga ON cga.cvegeo = a.cvegeo
  -- v0.2.7: muni-level SINBA morbidity. Same value broadcasts to every AGEB
  -- in the muni. Subquery cap at most-recent year so multi-year SINBA loads
  -- don't double-count. 2023 is the latest publicly available SINBA bulk.
  LEFT JOIN (
    SELECT cve_mun, casos_dm2_promedio, casos_hta_promedio, casos_obesidad_promedio
    FROM sinba_morbidity_municipal
    WHERE anio = (SELECT MAX(anio) FROM sinba_morbidity_municipal WHERE cve_mun = '${cveMun}')
      AND cve_mun = '${cveMun}'
  ) smm ON true
  WHERE a.cve_ent || a.cve_mun = '${cveMun}'
  ${rezagoWhere}ORDER BY ${orderExpr}
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

  const rows = runJsonQuery<RawOpportunityAgebRow[]>(
    config,
    opportunityByAgebSql(cveMun, column, codes, orderBy, limit, rezagoFilter),
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
  const innerOrderExpr =
    orderBy === "score"
      ? `(${totalEstabExpr}::numeric / NULLIF(${targetCountExpr}, 0)) DESC NULLS LAST`
      : orderBy === "target_count"
        ? `${targetCountExpr} DESC`
        : orderBy === "total_estab"
          ? `${totalEstabExpr} DESC`
          : /* colonia */ "UPPER(TRIM(colonia)) ASC";
  const outerOrderExpr =
    orderBy === "score"
      ? "(r.total_estab::numeric / NULLIF(r.target_count, 0)) DESC NULLS LAST"
      : orderBy === "target_count"
        ? "r.target_count DESC"
        : orderBy === "total_estab"
          ? "r.total_estab DESC"
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

  const rows = runJsonQuery<RawOpportunityColoniaRow[]>(
    config,
    opportunityByColoniaSql(cveMun, column, codes, orderBy, limit),
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
      ? "num_establecimientos DESC"
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

  const rows = runJsonQuery<RawColoniaListRow[]>(
    config,
    coloniasByMunicipioSql(cveMun, orderBy, limit),
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
  const rows = runJsonQuery<
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
  >(config, sql);
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
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
      `cvegeo inválido "${cvegeo ?? ""}". Debe ser 13 chars: 12 dígitos + dígito/letra.`,
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
  const rows = runJsonQuery<
    Array<{
      cvegeo: string;
      total_licenciadas: number;
      con_controlados: number;
    }>
  >(config, sql);
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
  c.header("Cache-Control", "public, max-age=3600");
  c.header("Vary", "X-Api-Key");
  return c.json(result);
}
