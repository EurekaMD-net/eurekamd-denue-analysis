/**
 * CLI: Load COFEPRIS Padrón de Licencias Sanitarias de Farmacias, Droguerías y Boticas.
 *
 * Source URL (verified 2026-05-05):
 *   https://www.gob.mx/cms/uploads/attachment/file/1020177/
 *     BASE_DE_DATOS_DE_LICENCIAS_SANITARIAS_DE_FARMACIAS___DROGUERIAS_Y_BOTICAS__EMITIDAS_POR_COFEPRIS.pdf
 *
 * Pipeline:
 *   1. Python `cofepris-pdf-to-csv.py` extracts 14 cols + 6 line-class flags from PDF (pdfplumber).
 *   2. Python `cofepris-geocode.py` matches each row to DENUE establecimientos via (cve_ent, cp,
 *      colonia) — first exact CP+colonia, then modal AGEB within CP. Produces cve_mun + cvegeo_ageb
 *      + geocode_method per row. Probe 2026-05-05 yielded 92.3% combined hit (74.7% precise +
 *      17.6% CP-modal). Below 60% would have forced muni-only fallback.
 *   3. This loader \copies the geocoded CSV into `cofepris_farmacias` raw table and creates
 *      `cofepris_farmacias_by_municipio` view aggregating Vigente counts per cve_mun by class.
 *
 * Why this matters: COFEPRIS licensing is the only public source of "this farmacia is authorized
 * to sell controlados (Estupefacientes Fracción I, Psicotrópicos II/III, Vacunas, Sueros,
 * Hemoderivados)" — which carries the highest margin per unit of the entire pharma OTC universe.
 * DENUE knows there's a farmacia at the address; only COFEPRIS knows what kind. This is the
 * licensure floor for site-selection of higher-margin pharma networks.
 *
 * Usage (one-time, manual; PDF doesn't have a stable download API):
 *   curl -L '<URL above>' -o /tmp/cofepris/farmacias.pdf
 *   python3 scripts/cofepris-pdf-to-csv.py /tmp/cofepris/farmacias.pdf /tmp/cofepris/farmacias.csv
 *   python3 scripts/cofepris-geocode.py  # reads /tmp/cofepris/farmacias.csv → farmacias_geocoded.csv
 *   npx tsx --env-file=.env scripts/load-cofepris.ts --csv-path=/tmp/cofepris/farmacias_geocoded.csv [--force]
 */

import { execFileSync } from "node:child_process";
import { closeSync, openSync, readSync, statSync } from "node:fs";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

/** Inside-container scratch path for \copy. Hardcoded — never operator input. */
const TMP_CSV_PATH = "/tmp/cofepris_farmacias.csv";

const EXPECTED_HEADER =
  "consec,nombre,giro,calle,colonia,colonia_norm,cp,localidad,localidad_norm,entidad,cve_ent,licencia,fecha_expedicion,lineas_autorizadas,estatus_licencia,estatus_establecimiento,observaciones,has_estupefacientes,has_psicotropicos,has_vacunas,has_toxoides,has_sueros_antitoxinas,has_hemoderivados,cve_mun,cvegeo_ageb,geocode_method";

function readFirstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf-8");
    const eol = text.indexOf("\n");
    return (eol >= 0 ? text.slice(0, eol) : text).replace(/^﻿/, "").trim();
  } finally {
    closeSync(fd);
  }
}

/**
 * Sniff first 16 KB for non-UTF-8. Python script writes UTF-8 by default, but
 * if operator hand-edits the CSV in a Latin-1 editor we fail loud at second 1
 * instead of mid-\copy. Carries v0.2.7 W4 lesson.
 */
function assertUtf8(path: string): void {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(16 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    decoder.decode(buf.subarray(0, bytes));
  } catch (err) {
    throw new Error(
      `loadCofepris: CSV at ${path} is not valid UTF-8. ` +
        `Re-run the Python extractor or pipe through iconv. ` +
        `(${err instanceof Error ? err.message : String(err)})`,
    );
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

export interface LoadCofeprisConfig {
  csvPath: string;
  dbContainer: string;
  force?: boolean;
}

export interface LoadCofeprisResult {
  rows_loaded: number;
  vigente: number;
  with_cve_mun: number;
  with_cvegeo_ageb: number;
  munis_in_view: number;
  duration_ms: number;
}

/**
 * Schema is fixed at v0.2.8. New COFEPRIS columns would require a migration
 * — unlike SINBA's wide age-band table this dataset has a stable shape
 * (the form was designed by COFEPRIS, not exported from a normalized DB).
 */
export const CREATE_TABLE_SQL = `
DROP TABLE IF EXISTS cofepris_farmacias CASCADE;

CREATE TABLE cofepris_farmacias (
  consec                    TEXT NOT NULL,
  nombre                    TEXT,
  giro                      TEXT,
  calle                     TEXT,
  colonia                   TEXT,
  colonia_norm              TEXT,
  cp                        TEXT,
  localidad                 TEXT,
  localidad_norm            TEXT,
  entidad                   TEXT,
  cve_ent                   TEXT,
  licencia                  TEXT NOT NULL,
  fecha_expedicion          DATE,
  lineas_autorizadas        TEXT,
  estatus_licencia          TEXT,
  estatus_establecimiento   TEXT,
  observaciones             TEXT,
  has_estupefacientes       BOOLEAN NOT NULL DEFAULT false,
  has_psicotropicos         BOOLEAN NOT NULL DEFAULT false,
  has_vacunas               BOOLEAN NOT NULL DEFAULT false,
  has_toxoides              BOOLEAN NOT NULL DEFAULT false,
  has_sueros_antitoxinas    BOOLEAN NOT NULL DEFAULT false,
  has_hemoderivados         BOOLEAN NOT NULL DEFAULT false,
  cve_mun                   TEXT,
  cvegeo_ageb               TEXT,
  geocode_method            TEXT,
  -- 2026-05-06: defense-in-depth at storage boundary.
  -- INEGI's Marco Geoestadístico distinguishes rural (9 chars: ENT+MUN+AGEB,
  -- no locality) from urban (13 chars: ENT+MUN+LOC+AGEB). Both are valid;
  -- ~21% of municipios have at least some rural AGEBs. NULL is allowed for
  -- rows that failed geocoding entirely. The geocoder ships a pre-load
  -- integrity check that joins back to ageb_polygons; this CHECK is the
  -- second gate even if the geocoder is bypassed.
  CONSTRAINT cofepris_cvegeo_ageb_shape
    CHECK (cvegeo_ageb IS NULL OR cvegeo_ageb ~ '^([0-9A-Z]{9}|[0-9A-Z]{13})$')
);
`.trim();

/**
 * POST_LOAD_SQL: indexes + municipal aggregation view.
 *
 * The view counts only Vigente licenses. Suspendida/Cancelada licenses are
 * historical and don't represent active competition. has_* flags carry over
 * from raw row → muni-aggregate so /licensed-pharmacies-by-municipio can
 * surface "muni X has 12 farmacias authorized for Estupefacientes".
 *
 * Wrapped in BEGIN/COMMIT so concurrent endpoint reads don't 502 with
 * relation-missing during atomic redeploy. Carries v0.2.6 C3 lesson.
 */
export const POST_LOAD_SQL = `
BEGIN;

-- Hot path for both views: WHERE estatus_licencia = 'Vigente' AND cve_mun = '...'.
-- Partial-on-Vigente cuts the index to ~92% of rows and matches the planner's
-- predicate exactly. Replaces the v0.2.7-style un-conditional index +
-- standalone status index that wouldn't be used (qa-audit M2 from v0.2.8 R1).
CREATE INDEX IF NOT EXISTS idx_cofepris_cve_mun_vigente
  ON cofepris_farmacias(cve_mun)
  WHERE estatus_licencia = 'Vigente' AND cve_mun IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cofepris_cvegeo_vigente
  ON cofepris_farmacias(cvegeo_ageb)
  WHERE estatus_licencia = 'Vigente' AND cvegeo_ageb IS NOT NULL;

CREATE OR REPLACE VIEW cofepris_farmacias_by_municipio AS
SELECT
  cve_mun,
  COUNT(*) AS total_licenciadas,
  COUNT(*) FILTER (WHERE has_estupefacientes)    AS con_estupefacientes,
  COUNT(*) FILTER (WHERE has_psicotropicos)      AS con_psicotropicos,
  COUNT(*) FILTER (WHERE has_vacunas)            AS con_vacunas,
  COUNT(*) FILTER (WHERE has_toxoides)           AS con_toxoides,
  COUNT(*) FILTER (WHERE has_sueros_antitoxinas) AS con_sueros_antitoxinas,
  COUNT(*) FILTER (WHERE has_hemoderivados)      AS con_hemoderivados,
  COUNT(*) FILTER (WHERE giro ILIKE 'Farmacia hospitalaria') AS hospitalarias,
  COUNT(*) FILTER (WHERE giro ILIKE 'Botica')                AS boticas,
  COUNT(*) FILTER (WHERE giro ILIKE 'Drogueria' OR giro ILIKE 'Drogu%') AS droguerias
FROM cofepris_farmacias
WHERE estatus_licencia = 'Vigente'
  AND cve_mun IS NOT NULL
  AND cve_mun ~ '^[0-9]{5}$'
GROUP BY cve_mun;

-- 2026-05-06: accept rural (9-char) AND urban (13-char) cvegeos. INEGI's
-- Marco Geoestadístico encodes rural AGEB without a locality component
-- (ENT+MUN+AGEB), which is a legitimate shape — not a defect.
CREATE OR REPLACE VIEW cofepris_farmacias_by_ageb AS
SELECT
  cvegeo_ageb,
  COUNT(*) AS total_licenciadas,
  COUNT(*) FILTER (WHERE has_estupefacientes OR has_psicotropicos
                      OR has_vacunas OR has_hemoderivados) AS con_controlados
FROM cofepris_farmacias
WHERE estatus_licencia = 'Vigente'
  AND cvegeo_ageb IS NOT NULL
  AND cvegeo_ageb ~ '^([0-9A-Z]{9}|[0-9A-Z]{13})$'
GROUP BY cvegeo_ageb;

COMMIT;
`.trim();

export async function loadCofepris(
  config: LoadCofeprisConfig,
): Promise<LoadCofeprisResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadCofepris: dbContainer inválido "${config.dbContainer}".`,
    );
  }
  if (config.csvPath.startsWith("-") || config.csvPath.length === 0) {
    throw new Error(`loadCofepris: csvPath inválido "${config.csvPath}".`);
  }

  const headerLine = readFirstLine(config.csvPath);
  if (headerLine !== EXPECTED_HEADER) {
    throw new Error(
      `loadCofepris: CSV header mismatch.\nexpected: ${EXPECTED_HEADER}\ngot:      ${headerLine.slice(0, 400)}`,
    );
  }

  const stat = statSync(config.csvPath);
  if (stat.size < 100_000) {
    throw new Error(
      `loadCofepris: CSV at ${config.csvPath} is suspiciously small (${stat.size} bytes).`,
    );
  }
  assertUtf8(config.csvPath);

  const started = Date.now();

  // C1 guard from v0.2.4-B: refuse to drop a populated table without --force.
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
          "SELECT COUNT(*) FROM cofepris_farmacias;",
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
        `loadCofepris: cofepris_farmacias already has ${existingRows} rows. Use --force to drop and re-load.`,
      );
    }
  }

  // 1. CREATE TABLE.
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

  // 2. Copy + \copy. Booleans land as '0'/'1' from Python — use NULL '' so
  //    blank cells become NULL rather than failing the bool cast.
  //    qa-audit W3 from R1: tmpName is a literal const, never operator input,
  //    so the \copy meta-command path can't be threaded by a caller.
  const tmpName = TMP_CSV_PATH;
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
        `\\copy cofepris_farmacias FROM '${tmpName}' WITH (FORMAT csv, HEADER true, NULL '')`,
      ],
      { encoding: "utf-8", timeout: 5 * 60_000 },
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

  // 3. POST_LOAD: indexes + views.
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

  // 4. Counts + stress test.
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
      throw new Error(`loadCofepris: unexpected count output "${out}"`);
    }
    return n;
  };
  const rows_loaded = cnt(`SELECT COUNT(*) FROM cofepris_farmacias;`);
  const vigente = cnt(
    `SELECT COUNT(*) FROM cofepris_farmacias WHERE estatus_licencia = 'Vigente';`,
  );
  const with_cve_mun = cnt(
    `SELECT COUNT(*) FROM cofepris_farmacias WHERE cve_mun IS NOT NULL AND cve_mun != '';`,
  );
  const with_cvegeo_ageb = cnt(
    `SELECT COUNT(*) FROM cofepris_farmacias WHERE cvegeo_ageb IS NOT NULL AND cvegeo_ageb != '';`,
  );
  const munis_in_view = cnt(
    `SELECT COUNT(*) FROM cofepris_farmacias_by_municipio;`,
  );

  // Stress-test: force evaluation of view CASTs (qa-audit W1 from v0.2.6).
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
      "SELECT cve_mun, total_licenciadas, con_estupefacientes FROM cofepris_farmacias_by_municipio LIMIT 5;",
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );

  process.stderr.write(`[load-cofepris] ${copyOut.trim()}\n`);

  return {
    rows_loaded,
    vigente,
    with_cve_mun,
    with_cvegeo_ageb,
    munis_in_view,
    duration_ms: Date.now() - started,
  };
}

if (import.meta.url === `file://${process.argv[1]}` /* run directly */) {
  const csvPath = getArg("csv-path");
  if (!csvPath) {
    process.stderr.write(
      [
        "Usage: load-cofepris --csv-path=/path/to/farmacias_geocoded.csv [--force]",
        "",
        "Pipeline (one-time):",
        "  curl -L '<COFEPRIS PDF URL>' -o /tmp/cofepris/farmacias.pdf",
        "  python3 scripts/cofepris-pdf-to-csv.py /tmp/cofepris/farmacias.pdf /tmp/cofepris/farmacias.csv",
        "  python3 scripts/cofepris-geocode.py",
        "  npx tsx --env-file=.env scripts/load-cofepris.ts --csv-path=/tmp/cofepris/farmacias_geocoded.csv",
      ].join("\n") + "\n",
    );
    process.exit(2);
  }
  const dbContainer = process.env.DB_CONTAINER ?? "supabase-db";
  loadCofepris({ csvPath, dbContainer, force: hasFlag("force") })
    .then((result) => {
      process.stderr.write(
        `[load-cofepris] done in ${result.duration_ms}ms — ` +
          `${result.rows_loaded} rows loaded (${result.vigente} Vigente), ` +
          `${result.with_cve_mun} geocoded to muni, ${result.with_cvegeo_ageb} to AGEB, ` +
          `${result.munis_in_view} munis in view\n`,
      );
    })
    .catch((err) => {
      process.stderr.write(
        `[load-cofepris] FAILED: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
