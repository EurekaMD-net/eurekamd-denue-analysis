/**
 * CLI: Load INEGI Censo 2020 "Resultados por AGEB y manzana urbana"
 * (RESAGEBURB) into PostgreSQL. Per-state ZIP, ~250-350 MB nationally.
 *
 * Source URL pattern (verified 2026-05-05):
 *   https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/
 *     ageb_manzana/ageb_mza_urbana_<EE>_cpv2020_csv.zip
 *
 * `<EE>` = 2-digit zero-padded entidad code (01..32).
 *
 * The CSV in each ZIP contains rows at MULTIPLE granularities, distinguished
 * by which key columns are populated:
 *
 *   ENTIDAD MUN  LOC  AGEB MZA  → meaning
 *   --------------------------------------------------
 *   NN      000  0000 0000 000  estado total
 *   NN      MMM  0000 0000 000  municipio total
 *   NN      MMM  LLLL 0000 000  localidad total (already in censo_iter)
 *   NN      MMM  LLLL AAAA 000  AGEB total          ← v0.2.4-B target
 *   NN      MMM  LLLL AAAA NNN  manzana             ← skip for now
 *
 * Loader strategy:
 *  1. Drop+create `censo_ageb_raw` on FIRST state (no --append flag).
 *  2. Per-state \copy into the same table — all granularities preserved.
 *  3. Subsequent states: pass `--append` to skip the drop.
 *  4. After ALL 32 states load, run POST_LOAD_SQL to create indexes +
 *     `censo_ageb` view (AGEB-level rows only) + `censo_manzana` view
 *     (manzana-level rows only). POST_LOAD is gated on `--post-load`.
 *
 * The 13-char CVEGEO is built as ENTIDAD || MUN || LOC || AGEB. Joins to
 * `ageb_polygons.cvegeo` and `establecimientos.ageb` cleanly. ~9% of
 * AGEBs have a letter suffix (e.g. `211140001086A`), so cvegeo is TEXT,
 * not numeric.
 *
 * Idempotency: each per-state \copy is fully replaced if the same state
 * runs twice with --append (DELETE WHERE entidad = 'NN' before \copy).
 *
 * Usage:
 *   # Download the ZIP first (operator or script):
 *   curl -O https://www.inegi.org.mx/contenidos/programas/ccpv/2020/datosabiertos/ageb_manzana/ageb_mza_urbana_01_cpv2020_csv.zip
 *   unzip ageb_mza_urbana_01_cpv2020_csv.zip
 *
 *   # First state (drops + creates table):
 *   npx tsx --env-file=.env scripts/load-censo-ageb.ts \
 *     --csv=ageb_mza_urbana_01_cpv2020/conjunto_de_datos/conjunto_de_datos_ageb_urbana_01_cpv2020.csv
 *
 *   # Subsequent states:
 *   npx tsx --env-file=.env scripts/load-censo-ageb.ts \
 *     --csv=...02.csv --append
 *
 *   # After all 32 states loaded, build views + indexes:
 *   npx tsx --env-file=.env scripts/load-censo-ageb.ts --post-load
 */

import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;
const ENTIDAD_RE = /^(0[1-9]|[12][0-9]|3[0-2])$/;

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

/** Read the ENTIDAD value from row 2 (first data row) — 2-digit zero-padded. */
function readEntidadFromFirstDataRow(path: string): string {
  const fd = openSync(path, "r");
  try {
    // Buffer ample for header + 1 data row (~32KB is plenty).
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf-8");
    const lines = text.split(/\r?\n/);
    if (lines.length < 2 || !lines[1]) {
      throw new Error(`load-censo-ageb: CSV at ${path} has no data rows`);
    }
    const firstField = lines[1].split(",")[0]?.trim() ?? "";
    if (!ENTIDAD_RE.test(firstField)) {
      throw new Error(
        `load-censo-ageb: first data row's ENTIDAD invalid ("${firstField}"). Expected 2-digit zero-padded 01..32.`,
      );
    }
    return firstField;
  } finally {
    closeSync(fd);
  }
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

export interface LoadCensoAgebConfig {
  csvPath: string;
  dbContainer: string;
  /** Skip DROP — append to an existing table (states 02..32 in a national load). */
  append: boolean;
  /**
   * Allow DROP of an already-populated table. Without this, a non-append
   * call against an existing table refuses to wipe prior states (qa-audit
   * C1 — operator-friction footgun: forgetting --append on state 17 of 32
   * silently destroyed the prior 16 states).
   */
  force?: boolean;
}

export interface LoadCensoAgebResult {
  entidad: string;
  rows_loaded_state: number;
  rows_loaded_total: number;
  duration_ms: number;
}

/**
 * Build the column-list portion of CREATE TABLE censo_ageb_raw — same
 * shape as load-censo's ITER variant but with the AGEB + MZA columns
 * the urbana dataset adds.
 */
export function buildCensoAgebCreateTable(csvHeaderLine: string): string {
  const stripped = csvHeaderLine.replace(/^﻿/, "").trim();
  const cols = stripped.split(",").map((c) => c.trim().toLowerCase());
  if (cols.length < 8) {
    throw new Error(
      `buildCensoAgebCreateTable: expected ≥8 columns, got ${cols.length}`,
    );
  }
  for (const required of ["entidad", "mun", "loc", "ageb", "mza"]) {
    if (!cols.includes(required)) {
      throw new Error(
        `buildCensoAgebCreateTable: missing required column "${required}". Got: ${cols.slice(0, 12).join(",")}...`,
      );
    }
  }
  for (const c of cols) {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) {
      throw new Error(`buildCensoAgebCreateTable: unsafe column name "${c}"`);
    }
  }
  const colDefs = cols.map((c) => `  "${c}" TEXT`).join(",\n");
  return [
    "DROP TABLE IF EXISTS censo_ageb_raw CASCADE;",
    `CREATE TABLE censo_ageb_raw (\n${colDefs}\n);`,
  ].join("\n");
}

/**
 * POST_LOAD_SQL: indexes + views derived from `censo_ageb_raw`. Run once
 * after all 32 states finish loading. Splits the multi-granularity raw
 * data into AGEB-level (MZA='000') and manzana-level (MZA!='000') views.
 *
 * S1: cvegeo derivation MUST stay 13 chars exactly. ENTIDAD is 2,
 * MUN is 3, LOC is 4, AGEB is 4 → 13 total. Letter suffixes occur in
 * AGEB only (last 1 of 4 chars), so the result is 12 digits + 1 char.
 *
 * qa-audit C3 (2026-05-05): wrapped in BEGIN/COMMIT so DROP+CREATE VIEW
 * is atomic from the readers' perspective. Without the transaction, a
 * concurrent ageb-detail or ageb-farmacia-opportunity request mid-flight
 * would 502 with "relation censo_ageb does not exist" for ~10ms.
 *
 * qa-audit C2: added non-partial cvegeo index alongside the partial one.
 * The partial index `WHERE mza='000' AND ageb!='0000'` predicate doesn't
 * always match the censo_ageb view's predicate (which adds loc/mun
 * filters), and Postgres planner may fail predicate-implication checks.
 * The non-partial cvegeo index is the safe fallback for the LEFT JOIN
 * `cab.cvegeo = a.cvegeo` in agebFarmaciaOpportunitySql.
 *
 * qa-audit W4: censo_ageb view also defends against unexpected mza
 * sentinels (`'*'`, non-numeric). manzana view already filters mza!='*';
 * the AGEB-level view now uses the same defensive approach.
 */
export const POST_LOAD_SQL = `
BEGIN;

ALTER TABLE censo_ageb_raw
  ADD COLUMN IF NOT EXISTS cvegeo TEXT
  GENERATED ALWAYS AS (entidad || mun || loc || ageb) STORED;

CREATE INDEX IF NOT EXISTS idx_censo_ageb_raw_cvegeo_ageb_only
  ON censo_ageb_raw(cvegeo) WHERE mza = '000' AND ageb != '0000';
CREATE INDEX IF NOT EXISTS idx_censo_ageb_raw_cvegeo
  ON censo_ageb_raw(cvegeo);
CREATE INDEX IF NOT EXISTS idx_censo_ageb_raw_level
  ON censo_ageb_raw(entidad, mun, loc, ageb, mza);

CREATE OR REPLACE VIEW censo_ageb AS
SELECT
  cvegeo,
  entidad,
  mun,
  loc,
  ageb,
  nom_loc,
  NULLIF(pobtot, '*')::int    AS pobtot,
  NULLIF(pobfem, '*')::int    AS pobfem,
  NULLIF(pobmas, '*')::int    AS pobmas,
  NULLIF(p_60ymas, '*')::int  AS p_60ymas,
  NULLIF(p_15ymas, '*')::int  AS p_15ymas,
  NULLIF(p_18ymas, '*')::int  AS p_18ymas,
  NULLIF(pea, '*')::int       AS pea,
  NULLIF(pocupada, '*')::int  AS pocupada,
  NULLIF(graproes, '*')::numeric AS graproes,
  NULLIF(tvivhab, '*')::int   AS tvivhab,
  NULLIF(tvivpar, '*')::int   AS tvivpar,
  NULLIF(vph_inter, '*')::int AS vph_inter,
  NULLIF(vph_autom, '*')::int AS vph_autom
FROM censo_ageb_raw
WHERE mza = '000'
  AND ageb != '0000' AND ageb != '*'
  AND loc != '0000' AND loc != '*'
  AND mun != '000' AND mun != '*';

CREATE OR REPLACE VIEW censo_manzana AS
SELECT
  entidad || mun || loc || ageb AS cvegeo_ageb,
  entidad,
  mun,
  loc,
  ageb,
  mza,
  NULLIF(pobtot, '*')::int    AS pobtot,
  NULLIF(pobfem, '*')::int    AS pobfem,
  NULLIF(pobmas, '*')::int    AS pobmas
FROM censo_ageb_raw
WHERE mza != '000' AND mza != '*' AND mza ~ '^[0-9]+$';

COMMIT;
`;

export async function loadCensoAgeb(
  config: LoadCensoAgebConfig,
): Promise<LoadCensoAgebResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadCensoAgeb: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  if (config.csvPath.startsWith("-") || config.csvPath.length === 0) {
    throw new Error(
      `loadCensoAgeb: csvPath inválido "${config.csvPath}". No puede empezar con '-' ni estar vacío.`,
    );
  }
  const started = Date.now();
  const headerLine = readFirstLine(config.csvPath);
  if (!headerLine) {
    throw new Error(`loadCensoAgeb: empty CSV at ${config.csvPath}`);
  }
  const entidad = readEntidadFromFirstDataRow(config.csvPath);

  // 1. Create table on first state, or DELETE existing rows for this entidad
  //    on subsequent states (idempotent re-run for one state).
  if (!config.append) {
    // qa-audit C1: refuse to drop a populated table without explicit --force.
    // Forgetting --append on state 17 of 32 would silently wipe the prior 16
    // states. Check for existing data BEFORE dropping. If the relation does
    // not exist, the COUNT errors out — that's expected for first-ever load.
    if (!config.force) {
      let existingRows = 0;
      try {
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
            "SELECT COUNT(*) FROM censo_ageb_raw;",
          ],
          { encoding: "utf-8", timeout: 30_000 },
        ).trim();
        existingRows = parseInt(out, 10);
        if (!Number.isFinite(existingRows)) existingRows = 0;
      } catch {
        // Relation does not exist — first-ever load, OK to proceed.
        existingRows = 0;
      }
      if (existingRows > 0) {
        throw new Error(
          `loadCensoAgeb: censo_ageb_raw already has ${existingRows.toLocaleString()} rows. ` +
            `Use --append to add another state, or --force to wipe.`,
        );
      }
    }
    const createSql = buildCensoAgebCreateTable(headerLine);
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
  } else {
    execFileSync(
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
        `DELETE FROM censo_ageb_raw WHERE entidad = '${entidad}';`,
      ],
      { encoding: "utf-8", timeout: 60_000 },
    );
  }

  // 2. Copy CSV into container, then \copy. Per-entidad temp filename so
  //    concurrent loads (if ever) don't stomp on each other.
  const tmpName = `/tmp/censo_ageb_${entidad}.csv`;
  execFileSync(
    "docker",
    ["cp", "--", config.csvPath, `${config.dbContainer}:${tmpName}`],
    { encoding: "utf-8", timeout: 5 * 60_000 },
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
        `\\copy censo_ageb_raw FROM '${tmpName}' WITH (FORMAT csv, HEADER true, NULL '*')`,
      ],
      { encoding: "utf-8", timeout: 10 * 60_000 },
    );
  } finally {
    try {
      execFileSync(
        "docker",
        ["exec", config.dbContainer, "rm", "-f", tmpName],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch {
      // best-effort
    }
  }

  // 3. Verify counts
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
      throw new Error(`loadCensoAgeb: unexpected count output "${out}"`);
    }
    return n;
  };
  const rows_loaded_state = cnt(
    `SELECT COUNT(*) FROM censo_ageb_raw WHERE entidad = '${entidad}';`,
  );
  const rows_loaded_total = cnt(`SELECT COUNT(*) FROM censo_ageb_raw;`);

  process.stderr.write(`[load-censo-ageb] ${copyOut.trim()}\n`);

  return {
    entidad,
    rows_loaded_state,
    rows_loaded_total,
    duration_ms: Date.now() - started,
  };
}

/**
 * Run POST_LOAD_SQL — call once after all 32 states finish loading.
 * Idempotent (CREATE INDEX IF NOT EXISTS / DROP VIEW IF EXISTS).
 */
export function runPostLoad(dbContainer: string): { duration_ms: number } {
  if (!CONTAINER_RE.test(dbContainer)) {
    throw new Error(
      `runPostLoad: dbContainer inválido "${dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  const started = Date.now();
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      dbContainer,
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
  return { duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";

  if (hasFlag("post-load")) {
    console.log(`[load-censo-ageb] running post-load (indexes + views) ...`);
    try {
      const r = runPostLoad(dbContainer);
      console.log(
        `[load-censo-ageb] ✓ post-load in ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-censo-ageb] ✗ post-load failed: ${msg}`);
      process.exit(1);
    }
  }

  const csvPath = getArg("csv");
  if (!csvPath) {
    console.error(
      "Usage:\n" +
        "  Per-state load (first state): npx tsx scripts/load-censo-ageb.ts --csv=/path/conjunto_de_datos_ageb_urbana_01_cpv2020.csv\n" +
        "  Subsequent states:            npx tsx scripts/load-censo-ageb.ts --csv=/path/.../02.csv --append\n" +
        "  After all 32 states:          npx tsx scripts/load-censo-ageb.ts --post-load",
    );
    process.exit(1);
  }
  const append = hasFlag("append");
  const force = hasFlag("force");
  console.log(
    `[load-censo-ageb] loading ${csvPath} → ${dbContainer}/censo_ageb_raw (append=${append}, force=${force}) ...`,
  );
  loadCensoAgeb({ csvPath, dbContainer, append, force })
    .then((r) => {
      console.log(
        `[load-censo-ageb] ✓ entidad ${r.entidad}: ${r.rows_loaded_state.toLocaleString()} state rows / ${r.rows_loaded_total.toLocaleString()} total in ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-censo-ageb] ✗ ${msg}`);
      process.exit(1);
    });
}
