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
 * Behavior:
 *   1. Drop+create raw table (all TEXT) idempotently.
 *   2. \copy CSV in via docker exec (with try/finally cleanup on the
 *      in-container temp file).
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
DROP TABLE IF EXISTS bienestar_padron_estatal_trimestral_raw CASCADE;
CREATE TABLE bienestar_padron_estatal_trimestral_raw (
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
 */
export const POST_LOAD_SQL_FOR_TEST = `
-- Full panel view: 32 entidades × 23 quarters = ~716 rows after CVEENT<>99 filter.
-- Defensive: also filter cveent ~ '^[0-9]+$' to drop any future header/blank-row drift.
DROP VIEW IF EXISTS bienestar_estatal_trimestral CASCADE;
CREATE VIEW bienestar_estatal_trimestral AS
SELECT
  LPAD(cveent, 2, '0')                         AS cve_ent,
  cveent                                       AS cveent_raw,
  entidad_etq                                  AS nom_ent_bienestar,
  beneficiarios::int                           AS beneficiarios,
  intervenciones::numeric                      AS intervenciones,
  dependencias::int                            AS dependencias,
  padrones::int                                AS padrones,
  programas::int                               AS programas,
  periodo_cve                                  AS periodo_cve,
  anio::int                                    AS anio,
  trimestre                                    AS trimestre,
  fecha::date                                  AS fecha
FROM bienestar_padron_estatal_trimestral_raw
WHERE cveent ~ '^[0-9]+$'
  AND cveent::int <> 99;

-- Latest-quarter slice: one row per entidad, the most recent fecha.
-- Powers /analytics/entidad-detail's bienestar_latest nested category.
-- ROW_NUMBER() with PARTITION BY cve_ent ORDER BY fecha DESC, periodo_cve DESC
-- guarantees one row per entidad even if two rows share fecha (stable tiebreak).
DROP VIEW IF EXISTS bienestar_estatal_latest CASCADE;
CREATE VIEW bienestar_estatal_latest AS
SELECT cve_ent, nom_ent_bienestar,
       beneficiarios, intervenciones, dependencias, padrones, programas,
       periodo_cve, anio, trimestre, fecha
FROM (
  SELECT *,
         ROW_NUMBER() OVER (
           PARTITION BY cve_ent
           ORDER BY fecha DESC NULLS LAST, periodo_cve DESC
         ) AS rn
  FROM bienestar_estatal_trimestral
) t
WHERE rn = 1;
`;

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

  // 1. Create raw table
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
      RAW_DDL,
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );

  // 2. \copy CSV in
  const containerPath = "/tmp/bienestar_padron.csv";
  execFileSync(
    "docker",
    ["cp", "--", config.csvPath, `${config.dbContainer}:${containerPath}`],
    { encoding: "utf-8", timeout: 60_000 },
  );
  try {
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
        `\\copy bienestar_padron_estatal_trimestral_raw FROM '${containerPath}' WITH (FORMAT csv, HEADER true)`,
      ],
      { encoding: "utf-8", timeout: 60_000 },
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

  // 3. Post-load: views
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
      POST_LOAD_SQL_FOR_TEST,
    ],
    { encoding: "utf-8", timeout: 60_000 },
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
      throw new Error(`loadBienestarPadron: unexpected count output "${out}"`);
    }
    return n;
  };
  const panel_rows = cnt("SELECT COUNT(*) FROM bienestar_estatal_trimestral;");
  const latest_rows = cnt("SELECT COUNT(*) FROM bienestar_estatal_latest;");
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
