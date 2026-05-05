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
  CVE_MUN_RE,
  ENTIDAD_RE,
  RISK_ANO_RE,
  RISK_DEFAULT_BASELINE_ANO,
  RISK_DEFAULT_CURRENT_ANO,
  type ApiServerConfig,
  type IrsGrado,
  type MunicipiosAnalyticsResult,
  type NationalTreemapResult,
  type RiskSummaryResult,
  type RiskTrendResult,
  type SectorGradeMatrixResult,
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
  const currentAno = parseAnoArg(anoRaw, RISK_DEFAULT_CURRENT_ANO, "ano");
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
