/**
 * CLI: Load SINBA Enfermedades Crónicas (DGIS Servicios Otorgados SIS).
 *
 * Source URL pattern (verified 2026-05-05):
 *   http://www.dgis.salud.gob.mx/descargas/datosabiertos/serviciosOtorgados/
 *     Enfermedades_cronicas_no_transmisibles_en_el_adulto_y_en_el_anciano/
 *     DA_EC_SIS_<YYYY>.zip
 *
 * Latest available bulk: DA_EC_SIS_2023.zip (5.5 MB ZIP / 49 MB CSV / 141k rows).
 * 2024+ only published behind the SINBA cube — no public bulk yet.
 *
 * Why this matters: closes the "pobreza-as-proxy for pharmacy demand" trap.
 * CONEVAL pobreza is a wealth signal; chronic-disease prevalence is the
 * actual demand driver for ~60% of OTC + Rx farmacy spend (DM2 + HTA +
 * obesidad). This loader brings actual case counts per municipio, computed
 * from monthly SIS reports across ~14k SSA / IMSS-Bienestar clinics.
 *
 * SINBA EC reports (per CLUES × month) cases under active management
 * across these chronic-disease classes:
 *   ADL — Adultos en Detección de Diabetes (screening)
 *   ADM — Adultos Diabéticos en Manejo (active DM2 treatment)  ← demand signal
 *   AEC — Adultos en Estado de Control diabético
 *   AHA — Adultos con Hipertensión Arterial                     ← demand signal
 *   AOB — Adultos con Obesidad                                   ← demand signal
 *   FRS, HBA, PDM, PMA, RUN — secondary metrics (not used for v0.2.7)
 *
 * Aggregation: for each (cve_mun, anio), SUM monthly case counts across
 * CLUES and age bands, then divide by 12 to get **average active cases
 * per month** — the steady-state caseload. Summing without /12 would
 * double-count patients (a DM2 patient under management in Jan AND Feb
 * shows up in both rows). Averaging gives an interpretable "how many
 * patients are being treated for X here" number.
 *
 * Source quirks:
 *   - CSV is ISO-8859-1 (Latin-1). \copy needs UTF-8, so we iconv first.
 *   - NULL values ship as the literal text "NULL", not empty strings.
 *     Use `\copy NULL 'NULL'`.
 *   - clave_municipio is 3-char zero-padded; CVE_MUN = entidad||muni works.
 *
 * Usage:
 *   curl -L 'http://www.dgis.salud.gob.mx/descargas/datosabiertos/serviciosOtorgados/Enfermedades_cronicas_no_transmisibles_en_el_adulto_y_en_el_anciano/DA_EC_SIS_2023.zip' -o /tmp/sinba.zip
 *   unzip -p /tmp/sinba.zip DA_EC_SIS_2023.csv > /tmp/sinba_raw.csv
 *   iconv -f LATIN1 -t UTF-8 /tmp/sinba_raw.csv > /tmp/sinba.csv
 *   npx tsx --env-file=.env scripts/load-sinba.ts --csv-path=/tmp/sinba.csv [--force]
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

const EXPECTED_FIRST_COLS =
  "CLAVE_ENTIDAD,ENTIDAD,CLAVE_MUNICIPIO,MUNICIPIO,CLUES,NOMBRE_CLUES,MES,ANIO";

function readFirstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4096);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf-8");
    const eol = text.indexOf("\n");
    return (eol >= 0 ? text.slice(0, eol) : text).replace(/^﻿/, "").trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * Sniff the first 16 KB of the CSV for non-UTF-8 sequences. SINBA ships
 * Latin-1; if operator skips the iconv step the column-name header still
 * looks fine (pure ASCII) but mid-file accented MUNICIPIO names ("Tláhuac")
 * trip `\copy` after 30 minutes of load. Fail loud at second 1 instead.
 *
 * qa-audit W4 (2026-05-05).
 */
function assertUtf8(path: string): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const slice = buf.subarray(0, bytes);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      decoder.decode(slice);
    } catch (err) {
      throw new Error(
        `loadSinba: CSV at ${path} is not valid UTF-8. Did you forget the iconv step? ` +
          `Run: iconv -f LATIN1 -t UTF-8 <raw.csv> > <utf8.csv>. ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
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

export interface LoadSinbaConfig {
  csvPath: string;
  dbContainer: string;
  /** Allow re-load even if sinba_ec_raw is populated (carries v0.2.4-B C1 lesson). */
  force?: boolean;
}

export interface LoadSinbaResult {
  rows_loaded: number;
  munis_covered: number;
  duration_ms: number;
}

/**
 * Build CREATE TABLE from the actual CSV header. SINBA EC has 85 columns —
 * 8 keys + 77 case-count age-band columns whose exact names depend on the
 * dataset year (DGIS occasionally renames bands). Generating the DDL from
 * the live header avoids drift if 2024+ ships with different age groupings.
 */
export function buildSinbaCreateTable(csvHeaderLine: string): string {
  const stripped = csvHeaderLine.replace(/^﻿/, "").trim();
  const cols = stripped.split(",").map((c) => c.trim().toLowerCase());
  if (cols.length < 20) {
    throw new Error(
      `buildSinbaCreateTable: expected ≥20 columns, got ${cols.length}`,
    );
  }
  // Required keys that the view depends on. If any is missing, the
  // header changed shape and we should fail loud.
  for (const required of ["clave_entidad", "clave_municipio", "anio"]) {
    if (!cols.includes(required)) {
      throw new Error(
        `buildSinbaCreateTable: missing required column "${required}". Got: ${cols.slice(0, 10).join(",")}...`,
      );
    }
  }
  for (const c of cols) {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) {
      throw new Error(`buildSinbaCreateTable: unsafe column name "${c}"`);
    }
  }
  const colDefs = cols.map((c) => `  "${c}" TEXT`).join(",\n");
  return [
    "DROP TABLE IF EXISTS sinba_ec_raw CASCADE;",
    `CREATE TABLE sinba_ec_raw (\n${colDefs}\n);`,
  ].join("\n");
}

/**
 * POST_LOAD_SQL builds the municipal aggregation view. SUM-then-divide-by-12
 * gives the average monthly steady-state caseload — the right interpretation
 * for "how many patients does this muni's SUS network treat for X."
 *
 * Wrapped in BEGIN/COMMIT (qa-audit C3 from v0.2.4-B): atomic DROP/CREATE
 * so concurrent endpoint reads don't 502 with relation-missing.
 *
 * Casts every TEXT case-count to int with `NULLIF(_, 'NULL')::int` —
 * SINBA's literal-NULL sentinel. SUM ignores NULLs by default so missing
 * cells contribute 0 to the rollup.
 *
 * Index: btree on cve_mun (the JOIN target for endpoint extension).
 */
export function buildPostLoadSql(headerLine: string): string {
  const stripped = headerLine.replace(/^﻿/, "").trim();
  const cols = stripped.split(",").map((c) => c.trim().toLowerCase());

  // qa-audit W5 (2026-05-05): anchored regex so a future SINBA dataset
  // with an `admisiones` or `aob_extra` column can't silently pollute the
  // SUM rollup. SINBA's case-count columns are always `<prefix><2digits>`
  // (e.g. adm02..adm23). Tighter than `startsWith` which would match those.
  const filterByPrefix = (prefix: string) =>
    cols.filter((c) => new RegExp(`^${prefix}\\d+$`).test(c));

  const admCols = filterByPrefix("adm");
  const ahaCols = filterByPrefix("aha");
  const aobCols = filterByPrefix("aob");
  if (admCols.length === 0 || ahaCols.length === 0 || aobCols.length === 0) {
    throw new Error(
      `buildPostLoadSql: missing chronic-disease prefix columns. ADM=${admCols.length} AHA=${ahaCols.length} AOB=${aobCols.length}`,
    );
  }

  // Build SUM expression: SUM(COALESCE(NULLIF(col, 'NULL')::int, 0) + ...) for each disease bucket.
  const sumExpr = (group: string[]): string =>
    group.map((c) => `COALESCE(NULLIF(${c}, 'NULL')::int, 0)`).join(" + ");

  return `
BEGIN;

CREATE INDEX IF NOT EXISTS idx_sinba_ec_raw_cve
  ON sinba_ec_raw(clave_entidad, clave_municipio);

CREATE OR REPLACE VIEW sinba_morbidity_municipal AS
SELECT
  clave_entidad || clave_municipio AS cve_mun,
  NULLIF(anio, 'NULL')::int AS anio,
  ROUND(SUM(${sumExpr(admCols)})::numeric / 12, 1) AS casos_dm2_promedio,
  ROUND(SUM(${sumExpr(ahaCols)})::numeric / 12, 1) AS casos_hta_promedio,
  ROUND(SUM(${sumExpr(aobCols)})::numeric / 12, 1) AS casos_obesidad_promedio,
  COUNT(DISTINCT clues) AS clues_reportando
FROM sinba_ec_raw
WHERE clave_entidad ~ '^[0-9]{2}$'
  AND clave_municipio ~ '^[0-9]{3}$'
  AND anio ~ '^[0-9]{4}$'
GROUP BY clave_entidad || clave_municipio, NULLIF(anio, 'NULL')::int;

COMMIT;
`;
}

export async function loadSinba(
  config: LoadSinbaConfig,
): Promise<LoadSinbaResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(`loadSinba: dbContainer inválido "${config.dbContainer}".`);
  }
  if (config.csvPath.startsWith("-") || config.csvPath.length === 0) {
    throw new Error(`loadSinba: csvPath inválido "${config.csvPath}".`);
  }
  const headerLine = readFirstLine(config.csvPath);
  if (!headerLine.startsWith(EXPECTED_FIRST_COLS)) {
    throw new Error(
      `loadSinba: CSV header doesn't start with expected columns.\nexpected prefix: ${EXPECTED_FIRST_COLS}\ngot: ${headerLine.slice(0, 200)}`,
    );
  }
  const stat = statSync(config.csvPath);
  if (stat.size < 1_000_000) {
    throw new Error(
      `loadSinba: CSV at ${config.csvPath} is suspiciously small (${stat.size} bytes).`,
    );
  }
  assertUtf8(config.csvPath);

  const started = Date.now();

  // C1 guard: refuse to drop a populated table without --force.
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
          "SELECT COUNT(*) FROM sinba_ec_raw;",
        ],
        { encoding: "utf-8", timeout: 60_000 },
      ).trim();
      const n = parseInt(out, 10);
      if (Number.isFinite(n)) existingRows = n;
    } catch {
      // table absent — proceed
    }
    if (existingRows > 0) {
      throw new Error(
        `loadSinba: sinba_ec_raw already has ${existingRows} rows. Use --force to drop and re-load.`,
      );
    }
  }

  // 1. Create table from CSV header.
  const createSql = buildSinbaCreateTable(headerLine);
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

  // 2. Copy + \copy into raw table.
  const tmpName = "/tmp/sinba_ec.csv";
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
        `\\copy sinba_ec_raw FROM '${tmpName}' WITH (FORMAT csv, HEADER true, NULL 'NULL')`,
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

  // 3. POST_LOAD: aggregate view + index (idempotent, atomic).
  const postLoadSql = buildPostLoadSql(headerLine);
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
      postLoadSql,
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
      throw new Error(`loadSinba: unexpected count output "${out}"`);
    }
    return n;
  };
  const rows_loaded = cnt(`SELECT COUNT(*) FROM sinba_ec_raw;`);
  const munis_covered = cnt(`SELECT COUNT(*) FROM sinba_morbidity_municipal;`);

  // 5. Stress-test view (qa-audit W1 from v0.2.6 — COUNT doesn't evaluate casts).
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
      "SELECT cve_mun, anio, casos_dm2_promedio, casos_hta_promedio FROM sinba_morbidity_municipal LIMIT 5;",
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );

  process.stderr.write(`[load-sinba] ${copyOut.trim()}\n`);

  return {
    rows_loaded,
    munis_covered,
    duration_ms: Date.now() - started,
  };
}

if (import.meta.url === `file://${process.argv[1]}` /* run directly */) {
  const csvPath = getArg("csv-path");
  if (!csvPath) {
    process.stderr.write(
      [
        "Usage: load-sinba --csv-path=/path/to/sinba_ec.csv [--force]",
        "",
        "Steps to produce the CSV (one-time):",
        "  curl -L 'http://www.dgis.salud.gob.mx/descargas/datosabiertos/serviciosOtorgados/Enfermedades_cronicas_no_transmisibles_en_el_adulto_y_en_el_anciano/DA_EC_SIS_2023.zip' -o /tmp/sinba.zip",
        "  unzip -p /tmp/sinba.zip DA_EC_SIS_2023.csv > /tmp/sinba_raw.csv",
        "  iconv -f LATIN1 -t UTF-8 /tmp/sinba_raw.csv > /tmp/sinba.csv",
        "  npx tsx --env-file=.env scripts/load-sinba.ts --csv-path=/tmp/sinba.csv",
      ].join("\n") + "\n",
    );
    process.exit(2);
  }
  const dbContainer = process.env.DB_CONTAINER ?? "supabase-db";
  loadSinba({ csvPath, dbContainer, force: hasFlag("force") })
    .then((result) => {
      process.stderr.write(
        `[load-sinba] done in ${result.duration_ms}ms — ` +
          `${result.rows_loaded} raw rows, ${result.munis_covered} munis in view\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(
        `[load-sinba] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
