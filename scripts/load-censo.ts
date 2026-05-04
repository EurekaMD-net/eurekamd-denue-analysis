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
 *
 * Behavior:
 *  1. Reads CSV header → CREATE TABLE censo_iter (col1 TEXT, col2 TEXT, ...)
 *     with 286 TEXT columns. Verbatim — no row filtering, no value casting.
 *  2. \copy ... NULL '*' so INEGI's null marker becomes SQL NULL.
 *  3. Adds generated column cve_mun (entidad||mun) for joins.
 *  4. Creates a partial btree index on cve_mun (loc='0000') for hot path.
 *  5. Creates censo_municipios view with cast columns for common analytics.
 *
 * Idempotent: drops + recreates censo_iter on each run.
 */

import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";

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
export function buildCensoCreateTable(csvHeaderLine: string): string {
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
  // CASCADE drops the censo_municipios view that depends on this table —
  // intentional, the view is recreated by POST_LOAD_SQL below. If a future
  // migration adds another dependent (e.g. censo_municipios_with_denue),
  // it would be silently dropped here. Replace CASCADE with explicit
  // `DROP VIEW … ; DROP TABLE …` if that becomes a real risk.
  return [
    "DROP TABLE IF EXISTS censo_iter CASCADE;",
    `CREATE TABLE censo_iter (\n${colDefs}\n);`,
  ].join("\n");
}

// S1: the partial-index predicate (loc='0000') MUST stay aligned with the
// censo_municipios view's filter. ITER aggregation level is encoded in
// `loc`: '0000' = municipal aggregate, anything else = locality. Don't
// touch one without the other.
//
// S2: the 14 columns exposed by censo_municipios are the v0.2.1-roadmap
// hot path (population × age × employment × education × housing). All 286
// raw columns remain accessible via `censo_iter` for ad-hoc queries.
// Add to this list when a new analytical use case justifies the cast.
const POST_LOAD_SQL = `
ALTER TABLE censo_iter ADD COLUMN cve_mun TEXT GENERATED ALWAYS AS (entidad || mun) STORED;
CREATE INDEX idx_censo_iter_cve_mun ON censo_iter(cve_mun) WHERE loc = '0000';
CREATE INDEX idx_censo_iter_level ON censo_iter(entidad, mun, loc);

CREATE OR REPLACE VIEW censo_municipios AS
SELECT
  cve_mun,
  entidad,
  mun,
  nom_mun,
  pobtot::int     AS pobtot,
  pobfem::int     AS pobfem,
  pobmas::int     AS pobmas,
  p_60ymas::int   AS p_60ymas,
  p_15ymas::int   AS p_15ymas,
  p_18ymas::int   AS p_18ymas,
  pea::int        AS pea,
  pocupada::int   AS pocupada,
  graproes::numeric AS graproes,
  tvivhab::int    AS tvivhab,
  tvivpar::int    AS tvivpar,
  vph_inter::int  AS vph_inter,
  vph_autom::int  AS vph_autom
FROM censo_iter
WHERE loc = '0000' AND mun != '000';
`;

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
  const createSql = buildCensoCreateTable(headerLine);

  // 1. Create table
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      config.dbContainer,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      createSql,
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );

  // 2. Copy CSV into container then \copy. Keeps containerd I/O path simple.
  // `--` separates flags from positional args so a csvPath beginning with '-'
  // (already rejected above, but defense-in-depth) can never reach docker as
  // a flag.
  execFileSync(
    "docker",
    ["cp", "--", config.csvPath, `${config.dbContainer}:/tmp/iter.csv`],
    { encoding: "utf-8", timeout: 60_000 },
  );
  let copyOut = "";
  try {
    copyOut = execFileSync(
      "docker",
      [
        "exec",
        config.dbContainer,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        `\\copy censo_iter FROM '/tmp/iter.csv' WITH (FORMAT csv, HEADER true, NULL '*')`,
      ],
      { encoding: "utf-8", timeout: 5 * 60_000 },
    );
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

  // 3. Post-load: indexes + view
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      config.dbContainer,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      POST_LOAD_SQL,
    ],
    { encoding: "utf-8", timeout: 5 * 60_000 },
  );

  // 4. Verify counts
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

  // copyOut contains "COPY <n>" — sanity log only
  process.stderr.write(`[load-censo] ${copyOut.trim()}\n`);

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
      "Usage: npx tsx scripts/load-censo.ts --csv=/path/to/conjunto_de_datos_iter_00CSV20.csv",
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
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-censo] ✗ ${msg}`);
      process.exit(1);
    });
}
