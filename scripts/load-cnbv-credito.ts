#!/usr/bin/env npx tsx --env-file=.env
/**
 * Loader: CNBV Crédito Comercial a la Vivienda 2025 (banca múltiple,
 * regulator microdata).
 *
 * Source URL ships filename `cnbv_2025.csv`; this loader expects it saved
 * locally as `raw/cnbv/credito_2025.csv` (renamed for grep-discoverability —
 * CNBV publishes multiple `cnbv_*.csv` files; the credito-specific
 * filename keeps loader↔file correspondence clear).
 *
 * Source: https://sistemas.sedatu.gob.mx/repositorio/proxy/alfresco-noauth/api/internal/shared/node/s0iq4D3cSWKq-V3uus6trQ/content/cnbv_2025.csv?a=true
 *
 * SIBLING (NOT duplicate) of v0.2.16 SEDATU `financiamientos_2025`:
 *   SEDATU lens = subsidized federal housing programs (organismo = INFONAVIT,
 *     FOVISSSTE, CONAVI, ONAVI, state institutos…). 325k rows / 2025.
 *   CNBV lens   = commercial bank-originated housing credit, regulated by
 *     CNBV (intermediario_financiero = 6-digit institutional codes for
 *     BANAMEX/BBVA/SANTANDER/HSBC/etc — 18 banks). 95k rows / 2025.
 * The two together capture both subsidy and commercial sides of household
 * housing finance. Composition `monto_subsidiado / (subsidiado + commercial)`
 * surfaces "% subsidy reliance" at muni and estado grain.
 *
 * Pipeline (mirrors load-sedatu-financiamientos.ts):
 *   1. Pre-pass: iconv ISO-8859-1 → UTF-8 (raw is Latin-1; `año` ships as 0xf1).
 *   2. \copy raw CSV into `cnbv_credito_raw_<year>` (all TEXT).
 *   3. Atomic BEGIN/COMMIT block builds:
 *      - 3 lookup tables (intermediarios, modalidades, vivienda_tiers).
 *        intermediarios is the only CNBV-specific seed; modalidades +
 *        vivienda_tiers mirror SEDATU dictionary 1:1 but are independent
 *        tables so the two loaders don't cross-couple.
 *      - View `cnbv_credito_<year>` (typed cast + LPAD cve_mun + INEGI
 *        5-char `cve_mun_full` join key, mirrors SEDATU).
 *      - View `cnbv_credito_estado_grain_<year>` (sibling-not-rollup pattern
 *        per feedback_estado_grain_sibling_pattern; cve_ent-only filter so
 *        any future state-level catch-all rows are re-included for estado
 *        aggregates. CNBV 2025 has 0 catch-all rows empirically — sibling
 *        view structure preserved as defense for future ingests where
 *        regulator may publish state-level rolls).
 *      - MATERIALIZED VIEW `cnbv_credito_by_municipio` (per-muni aggregates:
 *        acciones_total, monto_total, mean loan size, top intermediario +
 *        share, modality % breakdown, demographic %s, indígena %, housing-
 *        tier composition).
 *      - MATERIALIZED VIEW `cnbv_credito_by_estado` (same shape, estado
 *        grain, sourced from sibling base view).
 *
 * Codebook gaps (operator-supplied CNBV diccionario pending):
 *   - `linea_credito` (codes 1-13 with gaps {1,2,3,4,5,6,7,8,11,13}) — labels
 *     unknown. Loader passes through code-only; MV computes
 *     `top_linea_credito_code` without name resolution.
 *   - `esquema` (codes 1-15 with gaps {1,2,3,5,6,7,11,15}) — same posture.
 *   - `zona` (1-4) — same posture.
 *   - `poblacion_indigena` (1/2/3 enum) — empirically 1=No, 2=Sí, 3=No
 *     especificado per CNBV reporting convention but not codified in the
 *     SEDATU/CNBV shared dictionary; treated as a value-domain enum in the
 *     MV via FILTER aggregates with NULLIF on unknown denominators.
 *
 * Operator: when the CNBV codebook lands, drop labels into the lookup-table
 * seeds + add `top_linea_credito_nombre` etc. surface in the MV. The schema
 * is forward-compatible.
 *
 * Years (2026-09-28, docs/SNIIV-2026-H1.md; same convention as
 * load-sedatu-financiamientos.ts):
 *   --year=<YYYY> (default 2025) names the raw table, the typed view and the
 *   estado-grain view (`cnbv_credito_raw_<YYYY>`, `cnbv_credito_<YYYY>`,
 *   `cnbv_credito_estado_grain_<YYYY>`) and the default CSV
 *   (`raw/cnbv/credito_<YYYY>.csv`; SNIIV ships it as `CNBV_<YYYY>.csv`).
 *   --mv-source-year=<YYYY> (default 2025) is the latest COMPLETE year. The two
 *   MVs are rebuilt from that year's views only, and only when --year equals
 *   it: the API joins them on cve_mun / cve_ent alone and exposes
 *   periodo = MIN(ano), so a partial year (2026 = enero–junio) must never be
 *   mixed into them. Any other --year loads its own raw table + views and
 *   leaves the MVs AND the lookup tables untouched (the lookups are shared by
 *   every year and the MVs depend on them, so dropping them without the MVs
 *   would fail). Promote a year once SNIIV publishes it complete:
 *   --year=2026 --mv-source-year=2026 --force.
 *   Input checks run before anything touches the DB: the CSV header must equal
 *   RAW_HEADER_COLS (\copy maps by position) and every row's `ano` must equal
 *   --year (scripts/_sniiv-csv.ts). Every relation the run (re)creates gets
 *   postLoadGrants (strip anon / authenticated / trustr_app, re-grant the
 *   denue_sage SELECT that sage-role.sql allowlists). An MV rebuild still drops
 *   the denue_api SELECT: re-run scripts/api-role.sql after one.
 *   Source URL for a year: https://sniiv.sedatu.gob.mx/api/ReporteAPI/GetDocumentoAnio/7/<YYYY>/1
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/load-cnbv-credito.ts \
 *     [--year=2025] [--mv-source-year=2025] \
 *     [--csv=raw/cnbv/credito_<year>.csv] [--force]
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argv } from "node:process";
import {
  assertIdent,
  copyFromStdinScript,
  postLoadGrants,
  runPsqlScript,
} from "./_psql-tx.js";
import { assertYear, checkSniivCsv } from "./_sniiv-csv.js";

interface Args {
  csv: string;
  force: boolean;
  container: string;
  /** Data year; names the raw table + views. Default DEFAULT_YEAR. */
  year?: string;
  /**
   * Latest COMPLETE year: the only one whose views feed the MVs. Default
   * DEFAULT_YEAR; left undefined unless passed, so the pre-flight can tell an
   * explicit choice from the default.
   */
  mvSourceYear?: string;
}

export const DEFAULT_YEAR = "2025";

const SAFE_CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

function assertSafePath(p: string): void {
  const r = resolve(p);
  if (!SAFE_PATH_RE.test(r)) {
    throw new Error(`unsafe path: ${p}`);
  }
}

export function defaultCsvPath(year: string): string {
  return `raw/cnbv/credito_${assertYear(year, "--year")}.csv`;
}

export function parseArgs(
  args: readonly string[] = argv.slice(2),
): Args & { year: string } {
  let csv: string | undefined;
  let force = false;
  let year = DEFAULT_YEAR;
  let mvSourceYear: string | undefined;
  for (const a of args) {
    // `--year 2026` (space form) or a bare `--year` would otherwise be
    // skipped silently and load the default year.
    if (/^--(year|mv-source-year)(?!=)/.test(a)) {
      throw new Error(`${a} needs the = form: --year=<YYYY> / --mv-source-year=<YYYY>`);
    }
    if (a.startsWith("--csv=")) csv = a.slice(6);
    else if (a === "--force") force = true;
    else if (a.startsWith("--year=")) year = assertYear(a.slice(7), "--year");
    else if (a.startsWith("--mv-source-year=")) {
      mvSourceYear = assertYear(a.slice(17), "--mv-source-year");
    } else {
      // e.g. `--mv_source_year=2026` would otherwise run as a views-only load.
      throw new Error(
        `unknown argument "${a}"; expected --csv=<path>, --year=<YYYY>, --mv-source-year=<YYYY>, --force`,
      );
    }
  }
  return {
    csv: csv ?? defaultCsvPath(year),
    force,
    container: process.env.SUPABASE_DB_CONTAINER ?? "supabase-db",
    year,
    mvSourceYear,
  };
}

/** Per-year relations. The year is validated and every name re-checked by _psql-tx's assertIdent. */
export function yearRelations(year: string): {
  raw: string;
  view: string;
  estadoView: string;
} {
  assertYear(year, "--year");
  const rels = {
    raw: `cnbv_credito_raw_${year}`,
    view: `cnbv_credito_${year}`,
    estadoView: `cnbv_credito_estado_grain_${year}`,
  };
  for (const r of Object.values(rels)) assertIdent(r);
  return rels;
}

// Views the two MVs read today (pg_depend via their rewrite rules); empty
// when the MVs do not exist yet. Read-only, runs before any write.
export const MV_SOURCE_VIEWS_SQL = `SELECT DISTINCT v.relname FROM pg_depend d JOIN pg_rewrite rw ON rw.oid = d.objid JOIN pg_class v ON v.oid = d.refobjid WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass AND v.relkind = 'v' AND rw.ev_class IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('cnbv_credito_by_municipio', 'cnbv_credito_by_estado')) ORDER BY 1;`;

/**
 * Pre-flight on the --year / --mv-source-year pairing, from the
 * MV_SOURCE_VIEWS_SQL output. Returns the year the MVs read (null on a fresh
 * DB, where anything goes). Refuses, before the raw TRUNCATE + COPY commits:
 *  - a views-only load of the year the MVs read (its DROP VIEW would fail on
 *    the MVs' dependency after the raw data already changed);
 *  - a views-only load whose --mv-source-year is not what the MVs read (the
 *    run would not change them, so the flag would be a false statement);
 *  - an MV rebuild from a year other than the current one when
 *    --mv-source-year was not passed explicitly (e.g. a default --force reload
 *    after 2026 was promoted would silently put the MVs back on 2025).
 */
export function checkMvSourcePairing(
  depOut: string,
  year: string,
  mvSourceYear: string,
  mvSourceExplicit: boolean,
): string | null {
  const years = new Set<string>();
  for (const line of depOut.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const m = /^cnbv_credito_(?:estado_grain_)?(20[0-9]{2})$/.exec(line);
    if (!m) throw new Error(`unexpected MV source view "${line}"`);
    years.add(m[1] as string);
  }
  if (years.size === 0) return null;
  if (years.size > 1) {
    throw new Error(
      `the MVs read different years (${[...years].join(", ")}); rebuild them from one: --year=<YYYY> --mv-source-year=<YYYY> --force`,
    );
  }
  const current = [...years][0] as string;
  if (year !== mvSourceYear) {
    if (year === current) {
      throw new Error(
        `the MVs read the ${current} views, so --year=${year} with --mv-source-year=${mvSourceYear} would drop views they depend on. Pass --mv-source-year=${current} to reload ${current} and rebuild the MVs with it.`,
      );
    }
    if (mvSourceYear !== current) {
      throw new Error(
        `the MVs read ${current}, not --mv-source-year=${mvSourceYear}, and this --year=${year} run does not rebuild them. Pass --mv-source-year=${current}.`,
      );
    }
    return current;
  }
  if (mvSourceYear !== current && !mvSourceExplicit) {
    throw new Error(
      `the MVs read ${current}; this run would rebuild them from the default --mv-source-year=${mvSourceYear}. Pass --mv-source-year=${current} to keep ${current}, or --mv-source-year=${mvSourceYear} explicitly to switch.`,
    );
  }
  return current;
}

// Shared across years (lookups) and built from --mv-source-year only (MVs).
const LOOKUP_TABLES = [
  "cnbv_intermediarios",
  "cnbv_modalidades",
  "cnbv_vivienda_tiers",
] as const;
const MV_RELATIONS = [
  "cnbv_credito_by_municipio",
  "cnbv_credito_by_estado",
] as const;

// Index names are schema-wide: a second year reusing the 2025 names would make
// CREATE INDEX IF NOT EXISTS skip silently and leave its raw table unindexed.
// 2025 keeps its original names so re-runs stay no-ops.
function rawIndexName(base: string, year: string): string {
  const name = year === "2025" ? base : `${base}_${year}`;
  assertIdent(name);
  return name;
}

// --- Schema ---

// Header order MUST mirror the CSV exactly (\copy is positional).
// CNBV 2025 ships `monto` BEFORE `acciones` (SEDATU is the reverse). Pin
// the order in tests to detect any future column-rename like the 2025
// ENOE Q3+Q4 mid-year column rename (see feedback_session_2026_05_05_wrap).
export const RAW_HEADER_COLS = [
  "ano",
  "mes",
  "cve_ent",
  "entidad",
  "cve_mun",
  "municipio",
  "modalidad",
  "linea_credito",
  "esquema",
  "intermediario_financiero",
  "sexo",
  "edad_rango",
  "ingresos_rango",
  "vivienda_valor",
  "poblacion_indigena",
  "zona",
  "monto",
  "acciones",
] as const;

// Numeric cast columns. `intermediario_financiero` stays TEXT (6-digit
// CNBV institutional code with leading zero, e.g. "040021" — int cast
// would lose the leading zero and break the FK to cnbv_intermediarios).
export const NUMERIC_RAW_COLS = [
  "ano",
  "mes",
  "modalidad",
  "linea_credito",
  "esquema",
  "sexo",
  "edad_rango",
  "ingresos_rango",
  "vivienda_valor",
  "poblacion_indigena",
  "zona",
  "monto",
  "acciones",
] as const;

// One transaction with the grants: postgres' default ACL gives trustr_app
// arwdDxt on every new table, so a new year's raw table must never be
// committed without the REVOKE (and stays clean if the later COPY fails).
export function rawDdl(year: string): string {
  const { raw } = yearRelations(year);
  return `
BEGIN;

CREATE TABLE IF NOT EXISTS ${raw} (
  ano TEXT,
  mes TEXT,
  cve_ent TEXT,
  entidad TEXT,
  cve_mun TEXT,
  municipio TEXT,
  modalidad TEXT,
  linea_credito TEXT,
  esquema TEXT,
  intermediario_financiero TEXT,
  sexo TEXT,
  edad_rango TEXT,
  ingresos_rango TEXT,
  vivienda_valor TEXT,
  poblacion_indigena TEXT,
  zona TEXT,
  monto TEXT,
  acciones TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ${rawIndexName("idx_cnbv_credito_raw_cve_ent", year)}
  ON ${raw}(cve_ent);
CREATE INDEX IF NOT EXISTS ${rawIndexName("idx_cnbv_credito_raw_intermediario", year)}
  ON ${raw}(intermediario_financiero);

${postLoadGrants([raw])}

COMMIT;
`.trim();
}

export const RAW_DDL = rawDdl(DEFAULT_YEAR);

// CNBV 6-digit institutional codes (Sociedad Nacional de Crédito / Banco).
// Sourced from public CNBV/ABM regulator catalog. 18 banks active in the
// 2025 housing-credit dataset (empirically verified — full census of
// distinct intermediario_financiero values).
//
// Code is TEXT (NOT integer) — leading zeros are part of the canonical
// CNBV catalog identifier and must be preserved.
export const INTERMEDIARIOS_SEED = [
  ["040002", "BANAMEX"],
  ["040012", "BBVA México"],
  ["040014", "SANTANDER"],
  ["040021", "HSBC México"],
  ["040030", "BANBAJÍO"],
  ["040036", "INBURSA"],
  ["040042", "MIFEL"],
  ["040044", "SCOTIABANK"],
  ["040058", "BANREGIO"],
  ["040059", "INVEX"],
  ["040062", "AFIRME"],
  ["040072", "BANORTE"],
  ["040113", "VE POR MÁS"],
  ["040127", "AZTECA"],
  ["040128", "AUTOFIN"],
  ["040132", "MULTIVA"],
  ["040137", "BANCOPPEL"],
  ["040143", "CONSUBANCO"],
] as const;

// Mirrors SEDATU dictionary 1:1 — diccionario_financiamiento.xlsx field 12
// covers `modalidad` for both organismos and CNBV. Independent table so
// the CNBV loader doesn't depend on SEDATU loader having run first.
export const MODALIDADES_SEED = [
  [1, "Vivienda nueva"],
  [2, "Mejoramientos"],
  [3, "Vivienda usada"],
  [4, "Otros programas"],
] as const;

// Mirrors SEDATU dictionary 1:1 — diccionario_financiamiento.xlsx field 10
// covers `vivienda_valor` housing-tier classification (CONAVI/CONORE
// standard). Independent table for loader-decoupling.
export const VIVIENDA_TIERS_SEED = [
  [1, "Económica"],
  [2, "Popular"],
  [3, "Tradicional"],
  [4, "Media"],
  [5, "Residencial"],
  [6, "Residencial plus"],
] as const;

function buildTextSeedSql(
  table: string,
  rows: ReadonlyArray<readonly [string, string]>,
): string {
  const values = rows
    .map(([code, label]) => `('${code}', '${label.replace(/'/g, "''")}')`)
    .join(",\n  ");
  return `
DROP TABLE IF EXISTS ${table};
CREATE TABLE ${table} (
  code TEXT PRIMARY KEY,
  nombre TEXT NOT NULL
);
INSERT INTO ${table} (code, nombre) VALUES
  ${values};
`.trim();
}

function buildIntSeedSql(
  table: string,
  rows: ReadonlyArray<readonly [number, string]>,
): string {
  const values = rows
    .map(([code, label]) => `(${code}, '${label.replace(/'/g, "''")}')`)
    .join(",\n  ");
  return `
DROP TABLE IF EXISTS ${table};
CREATE TABLE ${table} (
  code INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL
);
INSERT INTO ${table} (code, nombre) VALUES
  ${values};
`.trim();
}

export const LOOKUPS_DDL = [
  buildTextSeedSql("cnbv_intermediarios", INTERMEDIARIOS_SEED),
  buildIntSeedSql("cnbv_modalidades", MODALIDADES_SEED),
  buildIntSeedSql("cnbv_vivienda_tiers", VIVIENDA_TIERS_SEED),
].join("\n\n");

const numericCast = (col: string): string =>
  // Empty string OR whitespace → NULL, then cast to numeric. Mirror SEDATU
  // posture against future rows with `' '`/`'  '` from inconsistent output.
  `NULLIF(TRIM(${col}), '')::numeric AS ${col}`;

// View 1: typed cast + INEGI 5-char cve_mun composed via LPAD.
// Filters by cve_ent ∈ '01..32' AND non-empty cve_mun (defensive against
// future state-level catch-all rows; CNBV 2025 has 0 such rows but the
// posture mirrors SEDATU for shape symmetry).
//
// `intermediario_financiero` stays TEXT (6-digit CNBV code with leading
// zero — int cast would corrupt it).
export function creditoViewDdl(year: string): string {
  const { raw, view } = yearRelations(year);
  return `
CREATE VIEW ${view} AS
SELECT
  ${NUMERIC_RAW_COLS.map(numericCast).join(",\n  ")},
  cve_ent,
  entidad,
  intermediario_financiero,
  cve_ent || LPAD(cve_mun, 3, '0') AS cve_mun
FROM ${raw}
WHERE NULLIF(TRIM(cve_ent), '') IS NOT NULL
  AND NULLIF(TRIM(cve_mun), '') IS NOT NULL
  AND TRIM(cve_ent) ~ '^(0[1-9]|[12][0-9]|3[0-2])$'
  AND TRIM(cve_mun) ~ '^[0-9]{1,3}$';
`.trim();
}

export const CREDITO_VIEW_DDL = creditoViewDdl(DEFAULT_YEAR);

// View 1b: estado-grain sibling per feedback_estado_grain_sibling_pattern.
// CNBV 2025 has 0 catch-all rows empirically (every row has cve_mun); the
// sibling view structure exists for shape symmetry with SEDATU and as
// forward-defense for future ingests where CNBV may publish state-level
// rolls without per-muni breakdown.
//
// At ingest time: estado.acciones_total = SUM(muni.acciones_total) and
// estado.monto_total = SUM(muni.monto_total) (no catch-all delta). If a
// future load shows divergence, that will be a data-shape change to flag,
// NOT a bug.
export function creditoEstadoViewDdl(year: string): string {
  const { raw, estadoView } = yearRelations(year);
  return `
CREATE VIEW ${estadoView} AS
SELECT
  ${NUMERIC_RAW_COLS.map(numericCast).join(",\n  ")},
  cve_ent,
  entidad,
  intermediario_financiero
FROM ${raw}
WHERE NULLIF(TRIM(cve_ent), '') IS NOT NULL
  AND TRIM(cve_ent) ~ '^(0[1-9]|[12][0-9]|3[0-2])$';
  -- NO cve_mun filter (deliberate — sibling-not-rollup posture).
`.trim();
}

export const CREDITO_ESTADO_VIEW_DDL = creditoEstadoViewDdl(DEFAULT_YEAR);

// View 2: per-muni aggregates with code-label resolution.
// Composition pcts are exclude-suppressed: e.g. pct_femenino divides by
// `acciones WHERE sexo IS NOT NULL`. Mirrors SEDATU MV posture.
//
// `top_linea_credito_code` and `top_esquema_code` are exposed without
// name resolution because the CNBV codebook is not yet operator-supplied
// (see header docstring). When the dictionary lands, add LEFT JOINs
// against `cnbv_lineas_credito` / `cnbv_esquemas` lookup tables to
// surface `top_linea_credito_nombre` etc.
export function creditoByMuniDdl(sourceYear: string): string {
  const { view } = yearRelations(sourceYear);
  return `
CREATE MATERIALIZED VIEW cnbv_credito_by_municipio AS
WITH per_muni AS (
  SELECT
    cve_mun,
    cve_ent,
    -- Period from data, mirrors SEDATU pattern for forward-compat with
    -- multi-year ingests.
    MIN(ano)::INTEGER::TEXT AS periodo,
    SUM(acciones)::INTEGER AS acciones_total,
    SUM(monto)::NUMERIC(20, 2) AS monto_total,
    -- Modality % over ALL acciones (modality is always known empirically;
    -- if a future row ships NULL modality, COALESCE+NULLIF degrades safely).
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 1), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_vivienda_nueva,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 2), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_mejoramientos,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 3), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_vivienda_usada,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 4), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_otros,
    -- Demographic % over rows where the dim is known.
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE sexo = 2), 0) * 100.0
       / NULLIF(SUM(acciones) FILTER (WHERE sexo IS NOT NULL), 0))::numeric, 2
    ) AS pct_femenino,
    -- Población indígena: 1 = Sí, 2 = No, 3 = No especificado.
    -- Verified empirically against the 2025 dataset:
    --   National row mix:  PI=1 = 0.6%, PI=2 = 71%, PI=3 = 28% (raw shares
    --   over total acciones — pre-denominator-narrowing).
    --   Post-formula pct_indigena (numerator PI=1 / denominator IN (1,2)):
    --   Chiapas 10.06% (matches state-level indigenous concentration in
    --   commercial-bank borrowers); CDMX 0.00%; Jalisco 0.01%.
    -- Denominator excludes 3 (No especificado) + NULL/empty rows so the
    -- rate is computed over rows with a definitive yes/no answer (~28% of
    -- national rows ship code 3 and would otherwise dilute the rate).
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE poblacion_indigena = 1), 0) * 100.0
       / NULLIF(SUM(acciones) FILTER (WHERE poblacion_indigena IN (1, 2)), 0))::numeric, 2
    ) AS pct_indigena,
    -- Housing-tier counters (NULL preserved for tier subtree-NULL guard).
    SUM(acciones) FILTER (WHERE vivienda_valor IS NOT NULL) AS acciones_with_tier,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 1), 0) AS acciones_economica,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 2), 0) AS acciones_popular,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 3), 0) AS acciones_tradicional,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 4), 0) AS acciones_media,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 5), 0) AS acciones_residencial,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 6), 0) AS acciones_residencial_plus
  FROM ${view}
  GROUP BY cve_mun, cve_ent
),
top_int AS (
  SELECT
    cve_mun,
    intermediario_financiero AS top_intermediario_code,
    SUM(acciones)::INTEGER AS top_intermediario_acciones,
    -- Tie-break on intermediario code ASC for determinism (mirrors
    -- SEDATU's organismo ASC tie-breaker).
    ROW_NUMBER() OVER (
      PARTITION BY cve_mun
      ORDER BY SUM(acciones) DESC, intermediario_financiero ASC
    ) AS rk
  FROM ${view}
  GROUP BY cve_mun, intermediario_financiero
),
top_lc AS (
  SELECT
    cve_mun,
    linea_credito AS top_linea_credito_code,
    ROW_NUMBER() OVER (
      PARTITION BY cve_mun
      ORDER BY SUM(acciones) DESC, linea_credito ASC
    ) AS rk
  FROM ${view}
  WHERE linea_credito IS NOT NULL
  GROUP BY cve_mun, linea_credito
),
top_esq AS (
  SELECT
    cve_mun,
    esquema AS top_esquema_code,
    ROW_NUMBER() OVER (
      PARTITION BY cve_mun
      ORDER BY SUM(acciones) DESC, esquema ASC
    ) AS rk
  FROM ${view}
  WHERE esquema IS NOT NULL
  GROUP BY cve_mun, esquema
)
SELECT
  pm.cve_mun,
  pm.cve_ent,
  pm.periodo,
  pm.acciones_total,
  pm.monto_total,
  ROUND(pm.monto_total / NULLIF(pm.acciones_total, 0), 2) AS monto_per_accion_avg,
  ti.top_intermediario_code,
  i.nombre AS top_intermediario_nombre,
  ROUND(ti.top_intermediario_acciones * 100.0 / NULLIF(pm.acciones_total, 0), 2) AS top_intermediario_share,
  tl.top_linea_credito_code::INTEGER AS top_linea_credito_code,
  te.top_esquema_code::INTEGER AS top_esquema_code,
  pm.pct_vivienda_nueva,
  pm.pct_mejoramientos,
  pm.pct_vivienda_usada,
  pm.pct_otros,
  pm.pct_femenino,
  pm.pct_indigena,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_economica * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_economica,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_popular * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_popular,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_tradicional * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_tradicional,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_media * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_media,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_residencial * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_residencial,
  CASE WHEN pm.acciones_with_tier > 0
    THEN ROUND(pm.acciones_residencial_plus * 100.0 / pm.acciones_with_tier, 2)
  END AS pct_residencial_plus
FROM per_muni pm
LEFT JOIN top_int ti ON ti.cve_mun = pm.cve_mun AND ti.rk = 1
LEFT JOIN cnbv_intermediarios i ON i.code = ti.top_intermediario_code
LEFT JOIN top_lc tl ON tl.cve_mun = pm.cve_mun AND tl.rk = 1
LEFT JOIN top_esq te ON te.cve_mun = pm.cve_mun AND te.rk = 1;

CREATE UNIQUE INDEX idx_cnbv_credito_cve_mun
  ON cnbv_credito_by_municipio(cve_mun);
CREATE INDEX idx_cnbv_credito_cve_ent
  ON cnbv_credito_by_municipio(cve_ent);
CREATE INDEX idx_cnbv_credito_monto_total
  ON cnbv_credito_by_municipio(monto_total DESC);
`.trim();
}

export const CREDITO_BY_MUNI_DDL = creditoByMuniDdl(DEFAULT_YEAR);

// MV 2: estado-grain aggregates. Same composition formulas as muni MV
// (modality % over ALL acciones, demographic % with known-rows
// denominators, vivienda-tier subtree-NULL guard) grouped by cve_ent and
// sourced from the sibling base view.
//
// CNBV 2025 has 0 catch-all rows so:
//   estado.acciones_total = SUM(muni.acciones_total)
//   estado.monto_total    = SUM(muni.monto_total)
// (Pinned in tests; if a future load breaks this, that's a data-shape
// flag not a bug.)
export function creditoByEstadoDdl(sourceYear: string): string {
  const { estadoView } = yearRelations(sourceYear);
  return `
CREATE MATERIALIZED VIEW cnbv_credito_by_estado AS
WITH per_estado AS (
  SELECT
    cve_ent,
    MIN(ano)::INTEGER::TEXT AS periodo,
    SUM(acciones)::INTEGER AS acciones_total,
    SUM(monto)::NUMERIC(20, 2) AS monto_total,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 1), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_vivienda_nueva,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 2), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_mejoramientos,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 3), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_vivienda_usada,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE modalidad = 4), 0) * 100.0
       / NULLIF(SUM(acciones), 0))::numeric, 2
    ) AS pct_otros,
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE sexo = 2), 0) * 100.0
       / NULLIF(SUM(acciones) FILTER (WHERE sexo IS NOT NULL), 0))::numeric, 2
    ) AS pct_femenino,
    -- Población indígena: 1 = Sí, 2 = No, 3 = No especificado.
    -- Same semantic as muni MV — see docstring there for empirical
    -- verification (Chiapas PI=1 = 9.48%, CDMX PI=1 = 0%).
    ROUND(
      (COALESCE(SUM(acciones) FILTER (WHERE poblacion_indigena = 1), 0) * 100.0
       / NULLIF(SUM(acciones) FILTER (WHERE poblacion_indigena IN (1, 2)), 0))::numeric, 2
    ) AS pct_indigena,
    SUM(acciones) FILTER (WHERE vivienda_valor IS NOT NULL) AS acciones_with_tier,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 1), 0) AS acciones_economica,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 2), 0) AS acciones_popular,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 3), 0) AS acciones_tradicional,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 4), 0) AS acciones_media,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 5), 0) AS acciones_residencial,
    COALESCE(SUM(acciones) FILTER (WHERE vivienda_valor = 6), 0) AS acciones_residencial_plus
  FROM ${estadoView}
  GROUP BY cve_ent
),
top_int_estado AS (
  SELECT
    cve_ent,
    intermediario_financiero AS top_intermediario_code,
    SUM(acciones)::INTEGER AS top_intermediario_acciones,
    ROW_NUMBER() OVER (
      PARTITION BY cve_ent
      ORDER BY SUM(acciones) DESC, intermediario_financiero ASC
    ) AS rk
  FROM ${estadoView}
  GROUP BY cve_ent, intermediario_financiero
),
top_lc_estado AS (
  SELECT
    cve_ent,
    linea_credito AS top_linea_credito_code,
    ROW_NUMBER() OVER (
      PARTITION BY cve_ent
      ORDER BY SUM(acciones) DESC, linea_credito ASC
    ) AS rk
  FROM ${estadoView}
  WHERE linea_credito IS NOT NULL
  GROUP BY cve_ent, linea_credito
),
top_esq_estado AS (
  SELECT
    cve_ent,
    esquema AS top_esquema_code,
    ROW_NUMBER() OVER (
      PARTITION BY cve_ent
      ORDER BY SUM(acciones) DESC, esquema ASC
    ) AS rk
  FROM ${estadoView}
  WHERE esquema IS NOT NULL
  GROUP BY cve_ent, esquema
)
SELECT
  pe.cve_ent,
  pe.periodo,
  pe.acciones_total,
  pe.monto_total,
  ROUND(pe.monto_total / NULLIF(pe.acciones_total, 0), 2) AS monto_per_accion_avg,
  ti.top_intermediario_code,
  i.nombre AS top_intermediario_nombre,
  ROUND(ti.top_intermediario_acciones * 100.0 / NULLIF(pe.acciones_total, 0), 2) AS top_intermediario_share,
  tl.top_linea_credito_code::INTEGER AS top_linea_credito_code,
  te.top_esquema_code::INTEGER AS top_esquema_code,
  pe.pct_vivienda_nueva,
  pe.pct_mejoramientos,
  pe.pct_vivienda_usada,
  pe.pct_otros,
  pe.pct_femenino,
  pe.pct_indigena,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_economica * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_economica,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_popular * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_popular,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_tradicional * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_tradicional,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_media * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_media,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_residencial * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_residencial,
  CASE WHEN pe.acciones_with_tier > 0
    THEN ROUND(pe.acciones_residencial_plus * 100.0 / pe.acciones_with_tier, 2)
  END AS pct_residencial_plus
FROM per_estado pe
LEFT JOIN top_int_estado ti ON ti.cve_ent = pe.cve_ent AND ti.rk = 1
LEFT JOIN cnbv_intermediarios i ON i.code = ti.top_intermediario_code
LEFT JOIN top_lc_estado tl ON tl.cve_ent = pe.cve_ent AND tl.rk = 1
LEFT JOIN top_esq_estado te ON te.cve_ent = pe.cve_ent AND te.rk = 1;

CREATE UNIQUE INDEX idx_cnbv_credito_est_cve_ent
  ON cnbv_credito_by_estado(cve_ent);
CREATE INDEX idx_cnbv_credito_est_monto_total
  ON cnbv_credito_by_estado(monto_total DESC);
`.trim();
}

export const CREDITO_BY_ESTADO_DDL = creditoByEstadoDdl(DEFAULT_YEAR);

// DROP cascade ordering per feedback_estado_grain_sibling_pattern (v0.2.15
// C1 lesson, v0.2.16 extended): Postgres DROP VIEW does NOT cascade. Drop
// dependent MVs first, then base views, then lookup tables.
//   1. estado MV (depends on lookups + estado base view)
//   2. muni MV   (depends on lookups + muni base view)
//   3. estado base view
//   4. muni base view
//   5. LOOKUPS_DDL (drops + recreates lookup tables — safe now)
//
// Without step 1, a second --force reload errors with "cannot drop table
// cnbv_intermediarios because materialized view cnbv_credito_by_estado
// depends on it".
//
// --year != --mv-source-year (e.g. 2026 H1 beside 2025): only that year's two
// views are dropped + rebuilt. Lookups and MVs stay as they are; a DROP of
// the lookups here would fail on the MVs' dependency (no CASCADE) anyway.
export function viewsDdlTransaction(year: string, mvSourceYear: string): string {
  const r = yearRelations(year);
  assertYear(mvSourceYear, "--mv-source-year");
  if (year !== mvSourceYear) {
    return `
BEGIN;

\\echo [load-cnbv] --year=${year} is not --mv-source-year=${mvSourceYear}: rebuilding the ${year} views only (MVs + lookup tables untouched)...

DROP VIEW IF EXISTS ${r.estadoView};
DROP VIEW IF EXISTS ${r.view};

${creditoViewDdl(year)}

${creditoEstadoViewDdl(year)}

${postLoadGrants([r.raw, r.view, r.estadoView])}

COMMIT;
`.trim();
  }
  return `
BEGIN;

\\echo [load-cnbv] dropping dependent views before lookup-table rebuild...

DROP MATERIALIZED VIEW IF EXISTS cnbv_credito_by_estado;
DROP MATERIALIZED VIEW IF EXISTS cnbv_credito_by_municipio;
DROP VIEW IF EXISTS ${r.estadoView};
DROP VIEW IF EXISTS ${r.view};

\\echo [load-cnbv] applying lookup tables (intermediarios / modalidades / vivienda_tiers)...

${LOOKUPS_DDL}

\\echo [load-cnbv] building credito view (typed cast + LPAD cve_mun)...

${creditoViewDdl(year)}

\\echo [load-cnbv] building credito estado-grain view (sibling-not-rollup)...

${creditoEstadoViewDdl(year)}

\\echo [load-cnbv] building credito-by-municipio MV + indexes (source: ${r.view})...

${creditoByMuniDdl(year)}

\\echo [load-cnbv] building credito-by-estado MV + indexes (source: ${r.estadoView})...

${creditoByEstadoDdl(year)}

${postLoadGrants([r.raw, r.view, r.estadoView, ...LOOKUP_TABLES, ...MV_RELATIONS])}

COMMIT;
`.trim();
}

export const VIEWS_DDL_TRANSACTION = viewsDdlTransaction(
  DEFAULT_YEAR,
  DEFAULT_YEAR,
);

// Post-load verification surfaces both row-count provenance AND a
// sum-invariant smoke check between muni-grain and estado-grain MVs.
//
// Audit W1 round-2: the sibling-not-rollup posture (estado MV reads from
// the catch-all-inclusive base view, NOT from the muni MV) means the two
// SUMs are EQUAL today (CNBV 2025 ships 0 catch-all rows) but COULD
// diverge in a future year if CNBV starts publishing state-level
// "no distribuido por municipio" entries the way SEDATU 2025 does.
// Surfacing `muni_acciones`, `estado_acciones`, `acciones_delta`,
// `monto_delta_b_mxn` at load time lets the operator visually flag
// non-zero deltas during the post-load console output. If a future
// ingest needs a hard guard, escalate the delta into ON_ERROR_STOP via
// a separate `\if` block.
// Without an MV rebuild the check reads the year's own views (the MVs still
// describe --mv-source-year).
export function postLoadVerifySql(year: string, mvSourceYear: string): string {
  const r = yearRelations(year);
  if (year !== mvSourceYear) {
    return `
SELECT
  (SELECT COUNT(*) FROM ${r.raw}) AS raw_rows,
  (SELECT COUNT(*) FROM ${r.view}) AS view_rows,
  (SELECT COUNT(DISTINCT cve_mun) FROM ${r.view}) AS distinct_muni,
  (SELECT MIN(ano)::INTEGER || '..' || MAX(ano)::INTEGER FROM ${r.estadoView}) AS ano_range,
  (SELECT MIN(mes)::INTEGER || '..' || MAX(mes)::INTEGER FROM ${r.estadoView}) AS mes_range,
  (SELECT TO_CHAR(SUM(acciones), 'FM999,999,999') FROM ${r.view}) AS total_acciones,
  (SELECT TO_CHAR(SUM(monto) / 1e9, 'FM999.99') FROM ${r.view}) AS total_monto_b_mxn,
  (SELECT COUNT(DISTINCT intermediario_financiero) FROM ${r.view}) AS distinct_intermediarios;
`.trim();
  }
  return `
SELECT
  (SELECT COUNT(*) FROM ${r.raw}) AS raw_rows,
  (SELECT COUNT(*) FROM ${r.view}) AS view_rows,
  (SELECT COUNT(DISTINCT cve_mun) FROM ${r.view}) AS distinct_muni,
  (SELECT COUNT(*) FROM cnbv_credito_by_municipio) AS muni_with_credito,
  (SELECT COUNT(*) FROM cnbv_credito_by_estado) AS estados_with_credito,
  (SELECT TO_CHAR(SUM(acciones_total), 'FM999,999,999') FROM cnbv_credito_by_municipio) AS muni_acciones,
  (SELECT TO_CHAR(SUM(acciones_total), 'FM999,999,999') FROM cnbv_credito_by_estado) AS estado_acciones,
  (SELECT (SELECT SUM(acciones_total) FROM cnbv_credito_by_estado)
        - (SELECT SUM(acciones_total) FROM cnbv_credito_by_municipio)) AS acciones_delta,
  (SELECT TO_CHAR(((SELECT SUM(monto_total) FROM cnbv_credito_by_estado)
                 - (SELECT SUM(monto_total) FROM cnbv_credito_by_municipio)) / 1e9, 'FM999.99')) AS monto_delta_b_mxn,
  (SELECT TO_CHAR(SUM(monto_total) / 1e9, 'FM999.99') FROM cnbv_credito_by_municipio) AS total_monto_b_mxn,
  (SELECT COUNT(DISTINCT intermediario_financiero) FROM ${r.view}) AS distinct_intermediarios;
`.trim();
}

export const POST_LOAD_VERIFY_SQL = postLoadVerifySql(DEFAULT_YEAR, DEFAULT_YEAR);

// --- Loader ---

function dockerExec(container: string, args: string[]): string {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name: ${container}`);
  }
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    encoding: "utf-8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function dockerExecStdin(
  container: string,
  args: string[],
  stdin: string | Buffer,
): string {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name: ${container}`);
  }
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    encoding: "utf-8",
    input: stdin,
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Convert ISO-8859-1 → UTF-8 in-memory. Mirrors SEDATU loader pattern
 * (feedback_iso_8859_1_to_utf8_inline) — Mexican gov CSVs ship Latin-1,
 * transcode in-loader before \copy.
 */
export function transcodeLatin1ToUtf8(input: Buffer): Buffer {
  // Already-UTF-8 input (e.g. the raw/*.utf8.csv copies) passes through
  // untouched: reinterpreting it as Latin-1 double-encodes every accent
  // ('Yucatán' -> 'YucatÃ¡n') and loads without error (audit #159).
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(input);
    return input;
  } catch {
    // not valid UTF-8 → Latin-1 source, transcode below
  }
  const text = input.toString("latin1");
  return Buffer.from(text, "utf-8");
}

export async function loadCnbvCredito(args: Args): Promise<void> {
  const year = assertYear(args.year ?? DEFAULT_YEAR, "--year");
  const mvSourceYear = assertYear(
    args.mvSourceYear ?? DEFAULT_YEAR,
    "--mv-source-year",
  );
  const rel = yearRelations(year);
  if (!existsSync(args.csv)) {
    throw new Error(
      year === "2025"
        ? `[load-cnbv] CSV not found: ${args.csv}. Download from https://sistemas.sedatu.gob.mx/repositorio/proxy/alfresco-noauth/api/internal/shared/node/s0iq4D3cSWKq-V3uus6trQ/content/cnbv_2025.csv?a=true`
        : `[load-cnbv] CSV not found: ${args.csv}. Resolve the download URL with https://sniiv.sedatu.gob.mx/api/ReporteAPI/GetDocumentoAnio/7/${year}/1`,
    );
  }
  assertSafePath(args.csv);

  // 0. Fail-loud input checks, before anything touches the DB: header ==
  // RAW_HEADER_COLS (\copy is positional), every row's ano == --year.
  const utf8 = transcodeLatin1ToUtf8(readFileSync(args.csv));
  const shape = checkSniivCsv(utf8, RAW_HEADER_COLS, year);
  console.log(
    `[load-cnbv] ${args.csv}: ${shape.rows} rows, ano=${year}, mes ${shape.mesMin}..${shape.mesMax}`,
  );
  // 0b. Pre-flight on the year pairing (read-only), before any write.
  checkMvSourcePairing(
    dockerExec(args.container, [
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-c",
      MV_SOURCE_VIEWS_SQL,
    ]),
    year,
    mvSourceYear,
    args.mvSourceYear !== undefined,
  );
  if (year !== mvSourceYear) {
    console.log(
      `[load-cnbv] --year=${year} != --mv-source-year=${mvSourceYear}: loading ${rel.raw} + its views only; cnbv_credito_by_municipio/_estado are NOT rebuilt and still read ${mvSourceYear}.`,
    );
  }

  // 1. Apply schema (idempotent).
  console.log("[load-cnbv] applying schema...");
  dockerExecStdin(
    args.container,
    ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    rawDdl(year),
  );

  // 2. Idempotency guard.
  const countOut = dockerExec(args.container, [
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tA",
    "-c",
    `SELECT COUNT(*) FROM ${rel.raw};`,
  ]).trim();
  const existing = Number.parseInt(countOut || "0", 10);
  if (existing > 0 && !args.force) {
    throw new Error(
      `[load-cnbv] ${rel.raw} has ${existing} rows. Use --force to truncate + reload.`,
    );
  }

  // 3. Transcode ISO-8859-1 → UTF-8 in tempdir.
  const tempdir = mkdtempSync(join(tmpdir(), "cnbv-credito-"));
  try {
    const utf8Path = join(tempdir, `credito_${year}.utf8.csv`);
    writeFileSync(utf8Path, utf8);

    // 4. Truncate raw + \copy.
    console.log(
      "[load-cnbv] truncating + loading raw CSV (UTF-8 transcoded)...",
    );
    // Audit #146: TRUNCATE and \copy share ONE psql session and
    // transaction (CSV piped inline after the \copy line), so a failed copy
    // rolls the TRUNCATE back instead of committing an empty raw table.
    const copyCmd = `\\copy ${rel.raw} (${RAW_HEADER_COLS.join(", ")}) FROM STDIN WITH (FORMAT csv, HEADER true)`;
    const csvBuf = readFileSync(utf8Path);
    runPsqlScript(
      args.container,
      copyFromStdinScript(
        `TRUNCATE TABLE ${rel.raw};`,
        copyCmd,
        csvBuf,
      ),
      30 * 60_000,
    );

    // 5. Build views atomically.
    console.log("[load-cnbv] building views (atomic transaction)...");
    dockerExecStdin(
      args.container,
      ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
      viewsDdlTransaction(year, mvSourceYear),
    );

    // 6. Verify.
    const stats = dockerExec(args.container, [
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-c",
      postLoadVerifySql(year, mvSourceYear),
    ]).trim();
    console.log(`[load-cnbv] done. ${stats}`);
  } finally {
    rmSync(tempdir, { recursive: true, force: true });
  }
}

// Auto-invoke when run directly (not when imported by tests).
const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");
if (isMain) {
  // parseArgs throws on a bad --year; route it through the same handler.
  Promise.resolve()
    .then(() => loadCnbvCredito(parseArgs()))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-cnbv] ✗ ${msg}`);
      process.exit(1);
    });
}
