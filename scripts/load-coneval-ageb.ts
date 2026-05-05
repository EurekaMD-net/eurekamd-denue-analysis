/**
 * CLI: Load CONEVAL Grado de Rezago Social (GRS) por AGEB urbana 2020.
 *
 * Source URL (verified 2026-05-05):
 *   https://www.coneval.org.mx/Medicion/Documents/GRS_AGEB_2020/
 *     GRS_AGEB_urbana_2020.zip → GRS_AGEB_urbana_2020.xlsx
 *
 * Why this matters: the existing `coneval_irs_municipal` table has 1 row
 * per municipio (~2,469 rows). Joining it to AGEB-level data gives every
 * AGEB inside a muni the same IRS — but a single muni like Iztapalapa
 * has AGEBs ranging from "Muy alto" rezago (Sierra de Santa Catarina)
 * to "Bajo" (zonas comerciales). This loader brings the granularity to
 * the right level — 61,433 AGEB-level rows with Grado + 17 indicators.
 *
 * Why not just `\copy` the XLSX: \copy can't read binary. The
 * `coneval-ageb-xlsx-to-csv.py` sibling script converts the workbook
 * to a clean CSV first (openpyxl, ~12s), then the CSV is loaded the
 * same way as load-censo-ageb (docker cp + \copy with NULL '*').
 *
 * Output schema:
 *   - `coneval_grs_ageb_raw` — TEXT-only landing table, * = NULL via \copy
 *   - `coneval_grs_ageb` (view) — typed cast, AGEBs only, the join target
 *   - `idx_coneval_grs_ageb_raw_cvegeo` — btree for the LEFT JOIN hot path
 *
 * Usage:
 *   1. Download + unzip + convert:
 *        curl -L -A 'Mozilla/5.0' \
 *          'https://www.coneval.org.mx/Medicion/Documents/GRS_AGEB_2020/GRS_AGEB_urbana_2020.zip' \
 *          -o /tmp/grs.zip
 *        unzip -p /tmp/grs.zip GRS_AGEB_urbana_2020.xlsx > /tmp/grs.xlsx
 *        python3 scripts/coneval-ageb-xlsx-to-csv.py /tmp/grs.xlsx > /tmp/coneval_grs.csv
 *   2. Load + post-load (idempotent — view is CREATE OR REPLACE):
 *        npx tsx --env-file=.env scripts/load-coneval-ageb.ts \
 *          --csv-path=/tmp/coneval_grs.csv [--force]
 *
 * Single-file, single-shot loader. No --append (the dataset is one-and-done
 * for the 2020 census wave). --force overrides the C1 guard if you need
 * to re-run after a partial failure.
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

const EXPECTED_HEADER =
  "cvegeo,pobtot,vivpar_hab,ind_analfabeta,ind_no_escuela_6_14,ind_no_escuela_15_24,ind_basica_incompleta,ind_sin_salud,ind_hacinamiento,ind_sin_agua,ind_sin_excusado,ind_sin_drenaje,ind_sin_luz,ind_piso_tierra,ind_sin_lavadora,ind_sin_refri,ind_sin_telfijo,ind_sin_celular,ind_sin_compu,ind_sin_internet,grado";

/** Read the first line so we can pin-check the CSV shape before trusting the load. */
function readFirstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(2048);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf-8");
    const eol = text.indexOf("\n");
    return (eol >= 0 ? text.slice(0, eol) : text).replace(/^﻿/, "").trim();
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

export interface LoadConevalAgebConfig {
  csvPath: string;
  dbContainer: string;
  /**
   * Allow re-load even if `coneval_grs_ageb_raw` already has rows. Without
   * this, a re-run refuses to drop the populated table — same C1 guard as
   * load-censo-ageb (operator-friction footgun: silent destruction of a
   * good load by an idle re-run).
   */
  force?: boolean;
}

export interface LoadConevalAgebResult {
  rows_loaded: number;
  rows_in_view: number;
  duration_ms: number;
}

/**
 * The raw table is the landing zone; the view is the join target. Both
 * stored in the same DDL for atomic apply via single \c invocation. The
 * 21 columns mirror `coneval-ageb-xlsx-to-csv.py`'s HEADER tuple — keep
 * in sync if either changes.
 *
 * Why TEXT for raw: INEGI's `*` sentinel is text. `\copy NULL '*'` only
 * coerces to actual NULL on import — so the raw table holds nullable
 * TEXT, and the view casts to numeric where the value is non-null.
 */
export const CREATE_TABLE_SQL = `
DROP TABLE IF EXISTS coneval_grs_ageb_raw CASCADE;
CREATE TABLE coneval_grs_ageb_raw (
  cvegeo TEXT NOT NULL,
  pobtot TEXT,
  vivpar_hab TEXT,
  ind_analfabeta TEXT,
  ind_no_escuela_6_14 TEXT,
  ind_no_escuela_15_24 TEXT,
  ind_basica_incompleta TEXT,
  ind_sin_salud TEXT,
  ind_hacinamiento TEXT,
  ind_sin_agua TEXT,
  ind_sin_excusado TEXT,
  ind_sin_drenaje TEXT,
  ind_sin_luz TEXT,
  ind_piso_tierra TEXT,
  ind_sin_lavadora TEXT,
  ind_sin_refri TEXT,
  ind_sin_telfijo TEXT,
  ind_sin_celular TEXT,
  ind_sin_compu TEXT,
  ind_sin_internet TEXT,
  grado TEXT
);
`;

/**
 * POST_LOAD_SQL: index + view derived from `coneval_grs_ageb_raw`.
 *
 * Wrapped in BEGIN/COMMIT (carries the qa-audit C3 lesson from
 * load-censo-ageb): DROP+CREATE VIEW under concurrent reads from
 * `agebDetailHandler` / `opportunityByAgebHandler` would 502 with
 * "relation does not exist" mid-flight. Atomic transaction collapses
 * the window. CREATE OR REPLACE VIEW is also idempotent.
 *
 * Index choice: btree on cvegeo. Hot path is `LEFT JOIN coneval_grs_ageb
 * cga ON cga.cvegeo = a.cvegeo` against a single AGEB or a list returned
 * by agebs-by-municipio (≤200 rows). Equality lookup, btree is optimal.
 *
 * Grado allowlist via CHECK is intentionally NOT in the raw table — `\copy`
 * would fail-loud on any malformed row instead of letting NULL pass; the
 * view filter (`WHERE grado IN (...)`) is the right enforcement layer.
 */
export const POST_LOAD_SQL = `
BEGIN;

CREATE INDEX IF NOT EXISTS idx_coneval_grs_ageb_raw_cvegeo
  ON coneval_grs_ageb_raw(cvegeo);

CREATE OR REPLACE VIEW coneval_grs_ageb AS
SELECT
  cvegeo,
  NULLIF(pobtot, '*')::int                 AS pobtot,
  NULLIF(vivpar_hab, '*')::int             AS vivpar_hab,
  NULLIF(ind_analfabeta, '*')::numeric     AS ind_analfabeta,
  NULLIF(ind_no_escuela_6_14, '*')::numeric  AS ind_no_escuela_6_14,
  NULLIF(ind_no_escuela_15_24, '*')::numeric AS ind_no_escuela_15_24,
  NULLIF(ind_basica_incompleta, '*')::numeric AS ind_basica_incompleta,
  NULLIF(ind_sin_salud, '*')::numeric      AS ind_sin_salud,
  NULLIF(ind_hacinamiento, '*')::numeric   AS ind_hacinamiento,
  NULLIF(ind_sin_agua, '*')::numeric       AS ind_sin_agua,
  NULLIF(ind_sin_excusado, '*')::numeric   AS ind_sin_excusado,
  NULLIF(ind_sin_drenaje, '*')::numeric    AS ind_sin_drenaje,
  NULLIF(ind_sin_luz, '*')::numeric        AS ind_sin_luz,
  NULLIF(ind_piso_tierra, '*')::numeric    AS ind_piso_tierra,
  NULLIF(ind_sin_lavadora, '*')::numeric   AS ind_sin_lavadora,
  NULLIF(ind_sin_refri, '*')::numeric      AS ind_sin_refri,
  NULLIF(ind_sin_telfijo, '*')::numeric    AS ind_sin_telfijo,
  NULLIF(ind_sin_celular, '*')::numeric    AS ind_sin_celular,
  NULLIF(ind_sin_compu, '*')::numeric      AS ind_sin_compu,
  NULLIF(ind_sin_internet, '*')::numeric   AS ind_sin_internet,
  grado
FROM coneval_grs_ageb_raw
WHERE grado IN ('Muy bajo', 'Bajo', 'Medio', 'Alto', 'Muy alto');

COMMIT;
`;

export async function loadConevalAgeb(
  config: LoadConevalAgebConfig,
): Promise<LoadConevalAgebResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadConevalAgeb: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  if (config.csvPath.startsWith("-") || config.csvPath.length === 0) {
    throw new Error(
      `loadConevalAgeb: csvPath inválido "${config.csvPath}". No puede empezar con '-' ni estar vacío.`,
    );
  }
  // Pin-check the CSV shape so a stale/corrupted converter output doesn't
  // silently load garbage. The header is fixed by the converter; if it
  // diverges, we'd be loading wrong-column-order data into TEXT cells
  // and only catching it on the cast in the view (or worse, NOT catching
  // it because TEXT accepts anything).
  const headerLine = readFirstLine(config.csvPath);
  if (headerLine !== EXPECTED_HEADER) {
    throw new Error(
      `loadConevalAgeb: CSV header mismatch.\nexpected: ${EXPECTED_HEADER}\ngot:      ${headerLine}`,
    );
  }
  // Quick file-non-empty check — if the converter ran but emitted only the
  // header, fail loudly here rather than load 0 rows and mark "success."
  const stat = statSync(config.csvPath);
  if (stat.size < 1024) {
    throw new Error(
      `loadConevalAgeb: CSV at ${config.csvPath} is suspiciously small (${stat.size} bytes). Did the XLSX→CSV converter run?`,
    );
  }

  const started = Date.now();

  // C1 guard: refuse to drop a populated table without --force. Mirrors
  // load-censo-ageb's discipline.
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
          "SELECT COUNT(*) FROM coneval_grs_ageb_raw;",
        ],
        { encoding: "utf-8", timeout: 60_000 },
      ).trim();
      const n = parseInt(out, 10);
      if (Number.isFinite(n)) existingRows = n;
    } catch {
      // Relation does not exist yet — proceed with create.
    }
    if (existingRows > 0) {
      throw new Error(
        `loadConevalAgeb: coneval_grs_ageb_raw already has ${existingRows} rows. ` +
          `Use --force to drop and re-load.`,
      );
    }
  }

  // 1. (Re)create the raw table.
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
      CREATE_TABLE_SQL,
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );

  // 2. Copy CSV into container, then \copy.
  const tmpName = "/tmp/coneval_grs_ageb.csv";
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
        `\\copy coneval_grs_ageb_raw FROM '${tmpName}' WITH (FORMAT csv, HEADER true, NULL '*')`,
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

  // 3. POST_LOAD: index + view (idempotent, atomic).
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
    { encoding: "utf-8", timeout: 60_000 },
  );

  // 4. Verify counts.
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
      throw new Error(`loadConevalAgeb: unexpected count output "${out}"`);
    }
    return n;
  };
  const rows_loaded = cnt(`SELECT COUNT(*) FROM coneval_grs_ageb_raw;`);
  const rows_in_view = cnt(`SELECT COUNT(*) FROM coneval_grs_ageb;`);

  // 5. View stress-test — qa-audit W1 (2026-05-05). COUNT(*) doesn't evaluate
  //    non-grouping cast expressions, so a row with a malformed indicator
  //    (e.g. empty string slipping past `\copy NULL '*'`) would pass the
  //    counts above and only manifest when an endpoint hits the broken row.
  //    Force evaluation of the typed casts on a small sample before declaring
  //    success — mirrors C1 defense at deploy time.
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
      "SELECT cvegeo, pobtot, vivpar_hab, ind_analfabeta, ind_sin_internet, grado FROM coneval_grs_ageb LIMIT 5;",
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );

  process.stderr.write(`[load-coneval-ageb] ${copyOut.trim()}\n`);

  return {
    rows_loaded,
    rows_in_view,
    duration_ms: Date.now() - started,
  };
}

if (
  import.meta.url ===
  `file://${process.argv[1]}` /* run directly, not imported */
) {
  const csvPath = getArg("csv-path");
  if (!csvPath) {
    process.stderr.write(
      [
        "Usage: load-coneval-ageb --csv-path=/path/to/coneval_grs.csv [--force]",
        "",
        "Steps to produce the CSV (one-time):",
        "  curl -L -A 'Mozilla/5.0' 'https://www.coneval.org.mx/Medicion/Documents/GRS_AGEB_2020/GRS_AGEB_urbana_2020.zip' -o /tmp/grs.zip",
        "  unzip -p /tmp/grs.zip GRS_AGEB_urbana_2020.xlsx > /tmp/grs.xlsx",
        "  python3 scripts/coneval-ageb-xlsx-to-csv.py /tmp/grs.xlsx > /tmp/coneval_grs.csv",
        "",
        "Then:",
        "  npx tsx --env-file=.env scripts/load-coneval-ageb.ts --csv-path=/tmp/coneval_grs.csv",
      ].join("\n") + "\n",
    );
    process.exit(2);
  }
  const dbContainer = process.env.DB_CONTAINER ?? "supabase-db";
  loadConevalAgeb({ csvPath, dbContainer, force: hasFlag("force") })
    .then((result) => {
      process.stderr.write(
        `[load-coneval-ageb] done in ${result.duration_ms}ms — ` +
          `${result.rows_loaded} raw rows, ${result.rows_in_view} in view\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(
        `[load-coneval-ageb] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
