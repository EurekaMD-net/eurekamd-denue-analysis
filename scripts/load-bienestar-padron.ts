/**
 * CLI: Load Padrón Único de Bienestar — entidad × trimestre panel.
 *
 * v0.2.11 of the analytical roadmap. SEDESOL/Secretaría de Bienestar publishes
 * a federal welfare-program coverage rollup at datos.gob.mx with one row per
 * (entidad, trimestre) pair plus a national-rolled row at CVEENT=99.
 *
 * Source CSV: ~114 KB UTF-8, 748 data rows, 14 columns.
 *   Coverage: 2019Q1 → 2024Q3 (23 quarters)
 *   Entidades: 32 + CVEENT=99 (national rolled, filtered out by view)
 *   Sentinels: NONE — all 5 numeric metric columns are clean.
 *   Cast nuance: `intervenciones` ships as `1851607.0` (float-formatted int);
 *                cast via ::numeric to absorb the decimal point.
 *
 * URL:
 *   https://www.datos.gob.mx/dataset/e9471afd-90be-4ed6-a052-b7a4ec9876d3/
 *     resource/91a2641d-1d9c-46e9-86a6-a0a038b10fd5/download/
 *     padron_unico_bienestar.csv
 *
 * Metrics (per entidad × trimestre):
 *   beneficiarios   — distinct people receiving any federal welfare program
 *   intervenciones  — count of program-event participations
 *   dependencias    — federal agencies operating in the entidad
 *   padrones        — registries reporting that quarter
 *   programas       — distinct programs delivered
 *
 * Usage:
 *   npx tsx scripts/load-bienestar-padron.ts --csv=/tmp/padron_unico_bienestar.csv
 *
 * Behavior (steps 1-3 run as ONE psql --single-transaction session, audit
 * #145 — a failed \copy leaves the live table and views untouched):
 *   1. Drop+create `_staging` raw table (all TEXT) idempotently.
 *   2. \copy CSV into staging (with try/finally cleanup on the in-container
 *      temp file), drop the two views, swap staging in.
 *   3. Replace TWO views:
 *        bienestar_estatal_trimestral (full panel, CVEENT<>99 filtered)
 *        bienestar_estatal_latest     (most-recent quarter per entidad)
 *   4. Verify view row counts.
 *
 * National row (CVEENT=99) is excluded from views — defense-in-depth pattern
 * mirroring v0.2.10's `entidad <> '00'` exclusion in censo_entidades. If a
 * /analytics/bienestar-national one-row endpoint is wanted later, raw table
 * preserves it; just add a separate view.
 */

import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import {
  assertRelationsExist,
  postLoadGrants,
  runPsqlScript,
  swapInStagingSql,
} from "./_psql-tx.js";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function readFirstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf-8");
    const nl = text.indexOf("\n");
    return (nl === -1 ? text : text.slice(0, nl)).replace(/\r$/, "");
  } finally {
    closeSync(fd);
  }
}

function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-")) {
    throw new Error(
      `loadBienestarPadron: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
    );
  }
}

function expectSafeIdentList(headerLine: string, expected: string[]): void {
  const cols = headerLine
    .replace(/^﻿/, "")
    .trim()
    .split(",")
    .map((c) => c.trim().toLowerCase());
  for (const c of cols) {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) {
      throw new Error(
        `loadBienestarPadron: unsafe column name "${c}" in ${headerLine.slice(0, 80)}...`,
      );
    }
  }
  for (const e of expected) {
    if (!cols.includes(e)) {
      throw new Error(
        `loadBienestarPadron: missing required column "${e}". Got: ${cols.slice(0, 14).join(",")}`,
      );
    }
  }
}

const REQUIRED_HEADERS = [
  "cveent",
  "entidad",
  "beneficiarios",
  "intervenciones",
  "dependencias",
  "padrones",
  "programas",
  "periodo_cve",
  "anio",
  "fecha",
];

const RAW_DDL = `
DROP TABLE IF EXISTS bienestar_padron_estatal_trimestral_raw_staging;
CREATE TABLE bienestar_padron_estatal_trimestral_raw_staging (
  cveent TEXT,
  entidad TEXT,
  beneficiarios TEXT,
  intervenciones TEXT,
  dependencias TEXT,
  padrones TEXT,
  programas TEXT,
  periodo TEXT,
  periodo_cve TEXT,
  trimestre TEXT,
  anio TEXT,
  fecha TEXT,
  entidad_etiqueta TEXT,
  entidad_etq TEXT
);
`;

/**
 * Post-load SQL (views). Exported so tests can pin invariants:
 *   1. CVEENT=99 (national rolled) is excluded from the panel view.
 *   2. cve_ent normalized via LPAD to '01'..'32' (matches censo_entidades).
 *   3. `intervenciones` ::numeric handles the decimal-formatted-int CSV quirk.
 *   4. The latest-quarter view uses ROW_NUMBER() with deterministic ordering.
 *
 * Audit log (rounds 1-3, closed 2026-05-09):
 *   - Numeric NULLIF chain guards the project-canon sentinels: '' / 'N/D' /
 *     'n.d'. CONEVAL '*' deliberately omitted (Bienestar isn't CONEVAL).
 *     Live probe 2026-05-09: zero rows match `^-?[0-9.]+$` negation across
 *     all 5 metric cols; re-probe on quarterly refresh.
 *   - Latest-slice ROW_NUMBER has no terminal tiebreaker — periodo_cve and
 *     cveent_raw are co-derived with the partition key + fecha so neither
 *     can break a tie. Producer guarantees one-row-per-(entidad, quarter);
 *     the duplicate guard (BIENESTAR_DUP_GUARD_SQL, inside the reload
 *     transaction) hard-fails and rolls back the load if that invariant is
 *     violated.
 *   - No btree on raw table — 748 rows seq-scans optimally; an index would
 *     be slower than the scan it replaces.
 */
export const POST_LOAD_SQL_FOR_TEST = `
-- Full panel view: 32 entidades × 23 quarters = 736 rows after CVEENT<>99 filter.
-- Defensive: also filter cveent ~ '^[0-9]+$' to drop any future header/blank-row drift.
DROP VIEW IF EXISTS bienestar_estatal_trimestral CASCADE;
CREATE VIEW bienestar_estatal_trimestral AS
SELECT
  LPAD(cveent, 2, '0')                                          AS cve_ent,
  cveent                                                        AS cveent_raw,
  entidad_etq                                                   AS nom_ent_bienestar,
  NULLIF(NULLIF(NULLIF(beneficiarios, ''), 'N/D'), 'n.d')::int  AS beneficiarios,
  NULLIF(NULLIF(NULLIF(intervenciones, ''), 'N/D'), 'n.d')::numeric  AS intervenciones,
  NULLIF(NULLIF(NULLIF(dependencias, ''), 'N/D'), 'n.d')::int   AS dependencias,
  NULLIF(NULLIF(NULLIF(padrones, ''), 'N/D'), 'n.d')::int       AS padrones,
  NULLIF(NULLIF(NULLIF(programas, ''), 'N/D'), 'n.d')::int      AS programas,
  periodo_cve                                                   AS periodo_cve,
  NULLIF(anio, '')::int                                         AS anio,
  trimestre                                                     AS trimestre,
  NULLIF(fecha, '')::date                                       AS fecha
FROM bienestar_padron_estatal_trimestral_raw
WHERE cveent ~ '^[0-9]+$'
  AND cveent::int <> 99;

-- Latest-quarter slice: one row per entidad, the most recent fecha.
-- Powers /analytics/entidad-detail's bienestar_latest nested category.
-- See header audit log for the no-tiebreaker rationale.
DROP VIEW IF EXISTS bienestar_estatal_latest CASCADE;
CREATE VIEW bienestar_estatal_latest AS
SELECT cve_ent, nom_ent_bienestar,
       beneficiarios, intervenciones, dependencias, padrones, programas,
       periodo_cve, anio, trimestre, fecha
FROM (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY cve_ent
           ORDER BY fecha DESC NULLS LAST
         ) AS rn
  FROM bienestar_estatal_trimestral
) t
WHERE rn = 1;
`;

/**
 * Duplicate-key guard (audit #154). Runs inside the reload transaction,
 * after the views are rebuilt and before COMMIT, so a corrupted source
 * (two rows for one (cve_ent, fecha)) rolls the whole reload back instead
 * of committing a panel whose latest-quarter pick is nondeterministic. It
 * reads the new panel view so the key is derived exactly as the API sees it.
 */
export const BIENESTAR_DUP_GUARD_SQL = `
DO $$
DECLARE n int;
BEGIN
  SELECT COUNT(*) INTO n FROM (
    SELECT cve_ent, fecha
    FROM bienestar_estatal_trimestral
    GROUP BY cve_ent, fecha
    HAVING COUNT(*) > 1
  ) dup;
  IF n > 0 THEN
    RAISE EXCEPTION 'loadBienestarPadron: producer invariant violated - % (cve_ent, fecha) groups have >1 row. Source CSV is corrupted; reload rolled back.', n;
  END IF;
END $$;
`;

const BIENESTAR_RELATIONS = [
  "bienestar_padron_estatal_trimestral_raw",
  "bienestar_estatal_trimestral",
  "bienestar_estatal_latest",
];

/**
 * The single-transaction reload script (audit #145): \copy into staging,
 * drop both views explicitly (latest reads trimestral, so it goes first),
 * swap, recreate the views, grants.
 */
export function buildBienestarReloadSql(containerPath: string): string {
  return [
    RAW_DDL,
    `\\copy bienestar_padron_estatal_trimestral_raw_staging FROM '${containerPath}' WITH (FORMAT csv, HEADER true)`,
    swapInStagingSql("bienestar_padron_estatal_trimestral_raw", [
      "DROP VIEW IF EXISTS bienestar_estatal_latest;",
      "DROP VIEW IF EXISTS bienestar_estatal_trimestral;",
    ]),
    POST_LOAD_SQL_FOR_TEST,
    BIENESTAR_DUP_GUARD_SQL,
    postLoadGrants(BIENESTAR_RELATIONS),
  ].join("\n");
}

export interface LoadBienestarConfig {
  csvPath: string;
  dbContainer: string;
}

export interface LoadBienestarResult {
  panel_rows: number;
  latest_rows: number;
  duration_ms: number;
}

export async function loadBienestarPadron(
  config: LoadBienestarConfig,
): Promise<LoadBienestarResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadBienestarPadron: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  assertSafePath("csvPath", config.csvPath);

  expectSafeIdentList(readFirstLine(config.csvPath), REQUIRED_HEADERS);

  const started = Date.now();

  // 1-3. One transaction: staging DDL → \copy → swap → views → grants.
  const containerPath = "/tmp/bienestar_padron.csv";
  execFileSync(
    "docker",
    ["cp", "--", config.csvPath, `${config.dbContainer}:${containerPath}`],
    { encoding: "utf-8", timeout: 60_000 },
  );
  try {
    // W2 audit (ronda 1): aligned to load-coneval.ts \copy timeout (5 min).
    // Current bienestar CSV is 114 KB and loads in <1s, but a future quarterly
    // refresh could ship multi-year backfill or operator-supplied snapshot.
    runPsqlScript(
      config.dbContainer,
      buildBienestarReloadSql(containerPath),
      6 * 60_000,
    );
  } finally {
    try {
      execFileSync(
        "docker",
        ["exec", config.dbContainer, "rm", "-f", containerPath],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch {
      // best-effort
    }
  }

  // 4. Verify counts. The (cve_ent, fecha) duplicate guard already ran
  //    inside the reload transaction (BIENESTAR_DUP_GUARD_SQL, audit #154).
  const cnt = (sql: string): number => {
    const out = execFileSync(
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
      { encoding: "utf-8", timeout: 60_000 },
    ).trim();
    const n = parseInt(out, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`loadBienestarPadron: unexpected count output "${out}"`);
    }
    return n;
  };
  const panel_rows = cnt("SELECT COUNT(*) FROM bienestar_estatal_trimestral;");
  const latest_rows = cnt("SELECT COUNT(*) FROM bienestar_estatal_latest;");
  assertRelationsExist(config.dbContainer, BIENESTAR_RELATIONS);
  return {
    panel_rows,
    latest_rows,
    duration_ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const csvPath = getArg("csv");
  if (!csvPath) {
    console.error(
      "Usage: npx tsx scripts/load-bienestar-padron.ts --csv=/path/padron.csv",
    );
    process.exit(1);
  }
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(`[load-bienestar-padron] loading panel → ${dbContainer} ...`);
  loadBienestarPadron({ csvPath, dbContainer })
    .then((r) => {
      console.log(
        `[load-bienestar-padron] ✓ panel=${r.panel_rows.toLocaleString()} | latest=${r.latest_rows.toLocaleString()} en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-bienestar-padron] ✗ ${msg}`);
      process.exit(1);
    });
}
