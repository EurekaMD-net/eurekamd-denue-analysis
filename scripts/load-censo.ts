/**
 * CLI: Load INEGI Censo 2020 ITER into PostgreSQL.
 *
 * The ITER (Iterador) bundle has 195k rows × 286 columns covering national,
 * state, municipal, and locality aggregates of the 2020 census.
 *
 * Usage:
 *   # Download zip from INEGI portal (UA-gated — see docs):
 *   #   https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/iter/iter_00_cpv2020_csv.zip
 *   # Extract conjunto_de_datos_iter_00CSV20.csv somewhere, then:
 *   npx tsx --env-file=.env scripts/load-censo.ts --csv=/opt/data/iter/.../conjunto_de_datos_iter_00CSV20.csv
 *   docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql   # only if needed, see below
 *
 * The reload drops and recreates the censo views and municipios_2025;
 * postLoadGrants restores denue_sage and denue_api from this checkout's
 * sage-role.sql / api-role.sql. Re-run api-role.sql only if a recreated
 * relation is missing from that allowlist, or the API role (denue_api) loses
 * access to it (/analytics/municipio-detail, locust-muni, ... answer 502).
 *
 * Behavior (ONE psql transaction — a failure leaves the DB untouched):
 *  1. Reads CSV header → CREATE TABLE censo_iter_staging (col1 TEXT, ...)
 *     with 286 TEXT columns. Verbatim — no row filtering, no value casting.
 *  2. \copy ... NULL '*' so INEGI's null marker becomes SQL NULL.
 *  3. Drops municipios_2025 / censo_localidades / censo_entidades /
 *     censo_municipios explicitly (no CASCADE, audit #144) and swaps staging
 *     in as censo_iter.
 *  4. Adds generated column cve_mun (entidad||mun) for joins.
 *  5. Creates a partial btree index on cve_mun (loc='0000') for hot path.
 *  6. Recreates the censo views + municipios_2025 (and the
 *     municipio_bridge_2025 seed) from scripts/migrate-censo-views.sql
 *     + re-applies grants.
 *
 * Idempotent: replaces censo_iter on each run.
 */

import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";
import {
  assertRelationsExist,
  CENSO_VIEWS,
  censoViewsSql,
  postLoadGrants,
  runPsqlScript,
} from "./_psql-tx.js";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

/** Read just the first line of a file without slurping the whole thing. */
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

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

export interface LoadCensoConfig {
  csvPath: string;
  dbContainer: string;
}

export interface LoadCensoResult {
  rows_loaded: number;
  municipios_count: number;
  duration_ms: number;
}

/**
 * Read CSV header line and produce the column-list portion of the
 * CREATE TABLE statement. Strips BOM, lowercases names, all TEXT.
 */
export function buildCensoCreateTable(
  csvHeaderLine: string,
  table = "censo_iter",
): string {
  const stripped = csvHeaderLine.replace(/^﻿/, "").trim();
  const cols = stripped.split(",").map((c) => c.trim().toLowerCase());
  if (cols.length < 5) {
    throw new Error(
      `buildCensoCreateTable: expected ≥5 columns, got ${cols.length}`,
    );
  }
  if (
    !cols.includes("entidad") ||
    !cols.includes("mun") ||
    !cols.includes("loc")
  ) {
    throw new Error(
      `buildCensoCreateTable: missing required columns (entidad/mun/loc). Got: ${cols.slice(0, 10).join(",")}...`,
    );
  }
  // Reject column names that aren't safe identifiers — defense in depth
  // against a malformed CSV header reaching SQL composition.
  for (const c of cols) {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) {
      throw new Error(`buildCensoCreateTable: unsafe column name "${c}"`);
    }
  }
  // Quote identifiers (R3): defends against future ITER releases where a
  // column name might happen to be a Postgres reserved word (`user`, `from`,
  // etc.). Real INEGI columns don't trigger this today, but the cost of
  // quoting is zero and the surprise on a future release would be ugly.
  const colDefs = cols.map((c) => `  "${c}" TEXT`).join(",\n");
  // No CASCADE (audit #144): the loader builds `censo_iter_staging` and
  // swaps it in after dropping the known censo views explicitly.
  return [
    `DROP TABLE IF EXISTS ${table};`,
    `CREATE TABLE ${table} (\n${colDefs}\n);`,
  ].join("\n");
}

// S1: the partial-index predicate (loc='0000') MUST stay aligned with the
// censo_municipios view's filter. ITER aggregation level is encoded in
// `loc`: '0000' = municipal aggregate, anything else = locality. Don't
// touch one without the other.
//
// S2: the censo views (censo_municipios, censo_localidades,
// censo_entidades) are defined ONLY in scripts/migrate-censo-views.sql —
// the loader recreates them from that file so a reload can't drop the
// locality/state views for good (audit #144). All 286 raw columns remain
// accessible via `censo_iter` for ad-hoc queries.
const POST_LOAD_SQL = `
ALTER TABLE censo_iter ADD COLUMN cve_mun TEXT GENERATED ALWAYS AS (entidad || mun) STORED;
CREATE INDEX idx_censo_iter_cve_mun ON censo_iter(cve_mun) WHERE loc = '0000';
CREATE INDEX idx_censo_iter_level ON censo_iter(entidad, mun, loc);
-- #118: serves censo_localidades lookups by cve_mun / (cve_mun, loc).
CREATE INDEX idx_censo_iter_cve_mun_loc ON censo_iter(cve_mun, loc) WHERE loc <> '0000' AND mun <> '000';
`;

/**
 * The single-transaction reload script: \copy into staging, drop the three
 * censo views explicitly (an unknown dependent makes DROP TABLE fail →
 * rollback), swap, index, recreate the views, re-apply grants.
 */
export function buildCensoReloadSql(csvHeaderLine: string): string {
  return [
    buildCensoCreateTable(csvHeaderLine, "censo_iter_staging"),
    `\\copy censo_iter_staging FROM '/tmp/iter.csv' WITH (FORMAT csv, HEADER true, NULL '*')`,
    // municipios_2025 selects from censo_municipios + censo_entidades, so it
    // goes first or their DROPs fail.
    "DROP VIEW IF EXISTS municipios_2025;",
    "DROP VIEW IF EXISTS censo_localidades;",
    "DROP VIEW IF EXISTS censo_entidades;",
    "DROP VIEW IF EXISTS censo_municipios;",
    "DROP TABLE IF EXISTS censo_iter;",
    "ALTER TABLE censo_iter_staging RENAME TO censo_iter;",
    POST_LOAD_SQL,
    censoViewsSql(),
    postLoadGrants(["censo_iter", "municipio_bridge_2025", ...CENSO_VIEWS]),
  ].join("\n");
}

export async function loadCenso(
  config: LoadCensoConfig,
): Promise<LoadCensoResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadCenso: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  // W1 fix: reject csvPath beginning with `-` so it can't be parsed as a
  // docker-cp / psql flag when passed positionally to execFileSync below.
  if (config.csvPath.startsWith("-") || config.csvPath.length === 0) {
    throw new Error(
      `loadCenso: csvPath inválido "${config.csvPath}". No puede empezar con '-' ni estar vacío.`,
    );
  }
  const started = Date.now();
  const headerLine = readFirstLine(config.csvPath);
  if (!headerLine) throw new Error(`loadCenso: empty CSV at ${config.csvPath}`);
  const reloadSql = buildCensoReloadSql(headerLine);

  // 1. Copy CSV into container, then ONE transaction: \copy into staging →
  // swap → indexes → censo views (audit #144). Keeps containerd I/O path
  // simple. `--` separates flags from positional args so a csvPath beginning
  // with '-' (already rejected above, but defense-in-depth) can never reach
  // docker as a flag.
  execFileSync(
    "docker",
    ["cp", "--", config.csvPath, `${config.dbContainer}:/tmp/iter.csv`],
    { encoding: "utf-8", timeout: 60_000 },
  );
  let copyOut = "";
  try {
    copyOut = runPsqlScript(config.dbContainer, reloadSql, 10 * 60_000);
  } finally {
    // Always clean up the in-container temp file even on \copy failure.
    try {
      execFileSync(
        "docker",
        ["exec", config.dbContainer, "rm", "-f", "/tmp/iter.csv"],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch {
      // best-effort — never mask a real upstream error
    }
  }

  // 2. Verify counts
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
      throw new Error(`loadCenso: unexpected count output "${out}"`);
    }
    return n;
  };
  const rows_loaded = cnt("SELECT COUNT(*) FROM censo_iter;");
  const municipios_count = cnt("SELECT COUNT(*) FROM censo_municipios;");
  assertRelationsExist(config.dbContainer);

  // copyOut contains "COPY <n>" — sanity log only
  process.stderr.write(`[load-censo] ${copyOut.match(/^COPY \d+$/m)?.[0] ?? ""}\n`);

  return { rows_loaded, municipios_count, duration_ms: Date.now() - started };
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
      [
        "Usage: npx tsx scripts/load-censo.ts --csv=/path/to/conjunto_de_datos_iter_00CSV20.csv",
        "Then:  docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql   # only if a recreated view is missing from its allowlist (postLoadGrants restores denue_sage and denue_api)",
      ].join("\n"),
    );
    process.exit(1);
  }
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(
    `[load-censo] loading ${csvPath} → ${dbContainer}/censo_iter ...`,
  );
  loadCenso({ csvPath, dbContainer })
    .then((r) => {
      console.log(
        `[load-censo] ✓ ${r.rows_loaded.toLocaleString()} ITER rows, ${r.municipios_count.toLocaleString()} municipios in ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      console.log(
        "[load-censo] next: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql   # only if a recreated view is missing from its allowlist (postLoadGrants restores denue_sage and denue_api from this checkout's sage-role.sql / api-role.sql)",
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-censo] ✗ ${msg}`);
      process.exit(1);
    });
}
