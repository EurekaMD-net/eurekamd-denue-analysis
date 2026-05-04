/**
 * CLI: Load CONEVAL pobreza municipal + IRS (Índice de Rezago Social) 2020.
 *
 * v0.2.1 of the analytical roadmap. Joins to establecimientos via cve_mun
 * (the 5-char ENT||MUN code in the area_geo column).
 *
 * Two datasets, both keyed by cve_mun (5-char zero-padded):
 *
 *   coneval_pobreza_municipal — % población en pobreza, pobreza extrema,
 *     vulnerabilidad por carencias, vulnerabilidad por ingreso, las 6
 *     carencias sociales (educación, salud, seguridad social, calidad
 *     vivienda, servicios básicos, alimentación), línea de pobreza por
 *     ingreso. Source CSV: 2,469 rows × 37 cols.
 *
 *   coneval_irs_municipal — Índice de Rezago Social compuesto + indicadores
 *     base (analfabetismo, asistencia escolar, derechohabiencia salud,
 *     calidad vivienda — piso/excusado/agua/drenaje/electricidad/lavadora/
 *     refrigerador). Source XLSX (Sheet "Municipios"): 2,469 rows × 19 cols.
 *     CONEVAL doesn't host the IRS XLSX directly anymore; the Guanajuato
 *     state government mirrors it at:
 *     https://portalsocial.guanajuato.gob.mx/sites/default/files/documentos/2020_CONEVAL_Indice_rezago_social_entidades_municipios_2020.xlsx
 *
 * Inputs are operator-provided pre-cleaned CSVs:
 *   --pobreza=/path/to/coneval_pobreza_2020_utf8.csv
 *   --irs=/path/to/coneval_irs_2020_municipios.csv
 *
 * The pobreza CSV from CONEVAL ships in ISO-8859 — convert with
 * `iconv -f LATIN1 -t UTF-8 in.csv > out.csv` first.
 *
 * The IRS XLSX has the "Municipios" sheet at index 1; convert with
 * Python+openpyxl (script in docs/loading-coneval.md if added).
 *
 * Behavior:
 *   1. Drop+create coneval_*_raw tables (all columns TEXT) idempotently.
 *   2. \copy CSVs in.
 *   3. Replace coneval_pobreza_municipal + coneval_irs_municipal views
 *      that NULLIF the 'n.d' marker, strip thousand-separator commas, and
 *      cast hot-path columns to int/numeric.
 *   4. Add btree indexes on the cve_mun expression for join speed.
 *
 * The raw tables preserve everything verbatim — views are just the friendly
 * cast layer. To add a new exposed column: edit the view, no reload needed.
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
      `loadConeval: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
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
        `loadConeval: unsafe column name "${c}" in ${headerLine.slice(0, 80)}...`,
      );
    }
  }
  for (const e of expected) {
    if (!cols.includes(e)) {
      throw new Error(
        `loadConeval: missing required column "${e}". Got: ${cols.slice(0, 10).join(",")}...`,
      );
    }
  }
}

const POBREZA_REQUIRED = [
  "clave_entidad",
  "clave_municipio",
  "poblacion",
  "pobreza",
];
const IRS_REQUIRED = [
  "cve_ent",
  "cve_mun_local",
  "pob_total",
  "irs_indice",
  "irs_grado",
];

const POBREZA_DDL = `
DROP TABLE IF EXISTS coneval_pobreza_municipal_raw CASCADE;
CREATE TABLE coneval_pobreza_municipal_raw (
  clave_entidad TEXT,
  entidad_federativa TEXT,
  clave_municipio TEXT,
  municipio TEXT,
  poblacion TEXT,
  pobreza TEXT, pobreza_pob TEXT,
  pobreza_e TEXT, pobreza_e_pob TEXT,
  pobreza_m TEXT, pobreza_m_pob TEXT,
  vul_car TEXT, vul_car_pob TEXT,
  vul_ing TEXT, vul_ing_pob TEXT,
  npnv TEXT, npnv_pob TEXT,
  ic_rezedu TEXT, ic_rezedu_pob TEXT,
  ic_asalud TEXT, ic_asalud_pob TEXT,
  ic_segsoc TEXT, ic_segsoc_pob TEXT,
  ic_cv TEXT, ic_cv_pob TEXT,
  ic_sbv TEXT, ic_sbv_pob TEXT,
  ic_ali TEXT, ic_ali_pob TEXT,
  carencias TEXT, carencias_pob TEXT,
  carencias3 TEXT, carencias3_pob TEXT,
  plp TEXT, plp_pob TEXT,
  plp_e TEXT, plp_e_pob TEXT
);
`;

const IRS_DDL = `
DROP TABLE IF EXISTS coneval_irs_municipal_raw CASCADE;
CREATE TABLE coneval_irs_municipal_raw (
  cve_ent TEXT, entidad TEXT, cve_mun_local TEXT, municipio TEXT, pob_total TEXT,
  analfabeta_15ymas TEXT, no_asisten_6a14 TEXT, edu_basica_incompleta_15ymas TEXT,
  sin_derechohab_salud TEXT, piso_tierra TEXT, sin_excusado TEXT, sin_agua TEXT,
  sin_drenaje TEXT, sin_electricidad TEXT, sin_lavadora TEXT, sin_refrigerador TEXT,
  irs_indice TEXT, irs_grado TEXT, irs_lugar_nacional TEXT
);
`;

/**
 * The post-load SQL (views + indexes). Exported so tests can assert that
 * `n.d` guards exist on every numeric column — audit C1 (2026-05-04).
 */
export const POST_LOAD_SQL_FOR_TEST = `
-- NULLIF strips CONEVAL's 'n.d' (no disponible) marker so casts succeed.
-- REPLACE strips the thousand-separator commas in poblacion / *_pob columns.
-- CRITICAL: when CONEVAL flags an indicator as 'n.d', BOTH the percent
-- column AND the paired *_pob personas column carry 'n.d' (the personas
-- count is derived from the %). Every numeric column needs the 'n.d'
-- guard, including the int *_pob columns. Audit C1, 2026-05-04.
DROP VIEW IF EXISTS coneval_pobreza_municipal CASCADE;
CREATE VIEW coneval_pobreza_municipal AS
SELECT
  LPAD(clave_municipio, 5, '0')                                            AS cve_mun,
  clave_entidad, entidad_federativa, municipio,
  NULLIF(NULLIF(REPLACE(poblacion, ',', ''), ''), 'n.d')::int               AS poblacion,
  NULLIF(pobreza, 'n.d')::numeric                                          AS pobreza_pct,
  NULLIF(NULLIF(REPLACE(pobreza_pob, ',', ''), ''), 'n.d')::int             AS pobreza_personas,
  NULLIF(pobreza_e, 'n.d')::numeric                                        AS pobreza_extrema_pct,
  NULLIF(NULLIF(REPLACE(pobreza_e_pob, ',', ''), ''), 'n.d')::int           AS pobreza_extrema_personas,
  NULLIF(pobreza_m, 'n.d')::numeric                                        AS pobreza_moderada_pct,
  NULLIF(vul_car, 'n.d')::numeric                                          AS vulnerable_carencias_pct,
  NULLIF(vul_ing, 'n.d')::numeric                                          AS vulnerable_ingreso_pct,
  NULLIF(npnv, 'n.d')::numeric                                             AS no_pobre_no_vul_pct,
  NULLIF(ic_rezedu, 'n.d')::numeric                                        AS carencia_rezago_edu_pct,
  NULLIF(ic_asalud, 'n.d')::numeric                                        AS carencia_acceso_salud_pct,
  NULLIF(ic_segsoc, 'n.d')::numeric                                        AS carencia_seg_social_pct,
  NULLIF(ic_cv, 'n.d')::numeric                                            AS carencia_calidad_vivienda_pct,
  NULLIF(ic_sbv, 'n.d')::numeric                                           AS carencia_serv_basicos_pct,
  NULLIF(ic_ali, 'n.d')::numeric                                           AS carencia_alimentacion_pct,
  NULLIF(plp, 'n.d')::numeric                                              AS pob_lp_ingreso_pct
FROM coneval_pobreza_municipal_raw;

DROP VIEW IF EXISTS coneval_irs_municipal CASCADE;
CREATE VIEW coneval_irs_municipal AS
SELECT
  cve_mun_local                                                    AS cve_mun,
  cve_ent, entidad, municipio,
  pob_total::int                                                   AS pob_total,
  analfabeta_15ymas::numeric                                       AS analfabeta_15ymas_pct,
  no_asisten_6a14::numeric                                         AS no_asisten_escuela_6a14_pct,
  edu_basica_incompleta_15ymas::numeric                            AS edu_basica_incompleta_pct,
  sin_derechohab_salud::numeric                                    AS sin_derechohab_salud_pct,
  piso_tierra::numeric                                             AS viv_piso_tierra_pct,
  sin_excusado::numeric                                            AS viv_sin_excusado_pct,
  sin_agua::numeric                                                AS viv_sin_agua_pct,
  sin_drenaje::numeric                                             AS viv_sin_drenaje_pct,
  sin_electricidad::numeric                                        AS viv_sin_electricidad_pct,
  sin_refrigerador::numeric                                        AS viv_sin_refrigerador_pct,
  sin_lavadora::numeric                                            AS viv_sin_lavadora_pct,
  NULLIF(irs_indice, 'n.d')::numeric                               AS irs_indice,
  NULLIF(irs_grado, 'n.d')                                         AS irs_grado,
  NULLIF(irs_lugar_nacional, 'n.d')::int                           AS irs_lugar_nacional
FROM coneval_irs_municipal_raw;

DROP INDEX IF EXISTS idx_coneval_pobreza_cve_mun;
CREATE INDEX idx_coneval_pobreza_cve_mun
  ON coneval_pobreza_municipal_raw((LPAD(clave_municipio, 5, '0')));

DROP INDEX IF EXISTS idx_coneval_irs_cve_mun;
CREATE INDEX idx_coneval_irs_cve_mun
  ON coneval_irs_municipal_raw(cve_mun_local);
`;

export interface LoadConevalConfig {
  pobrezaCsvPath: string;
  irsCsvPath: string;
  dbContainer: string;
}

export interface LoadConevalResult {
  pobreza_rows: number;
  irs_rows: number;
  duration_ms: number;
}

export async function loadConeval(
  config: LoadConevalConfig,
): Promise<LoadConevalResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadConeval: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  assertSafePath("pobrezaCsvPath", config.pobrezaCsvPath);
  assertSafePath("irsCsvPath", config.irsCsvPath);

  // Header sanity checks (defense-in-depth — operator may swap CSV files).
  expectSafeIdentList(readFirstLine(config.pobrezaCsvPath), POBREZA_REQUIRED);
  expectSafeIdentList(readFirstLine(config.irsCsvPath), IRS_REQUIRED);

  const started = Date.now();

  // 1. Create raw tables
  for (const ddl of [POBREZA_DDL, IRS_DDL]) {
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
        ddl,
      ],
      { encoding: "utf-8", timeout: 60_000 },
    );
  }

  // 2. Copy CSVs in + \copy with try/finally cleanup
  const copyOne = (csvPath: string, table: string): void => {
    const containerPath = `/tmp/${table}.csv`;
    execFileSync(
      "docker",
      ["cp", "--", csvPath, `${config.dbContainer}:${containerPath}`],
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
          `\\copy ${table} FROM '${containerPath}' WITH (FORMAT csv, HEADER true)`,
        ],
        { encoding: "utf-8", timeout: 5 * 60_000 },
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
  };
  copyOne(config.pobrezaCsvPath, "coneval_pobreza_municipal_raw");
  copyOne(config.irsCsvPath, "coneval_irs_municipal_raw");

  // 3. Post-load: views + indexes
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
      throw new Error(`loadConeval: unexpected count output "${out}"`);
    }
    return n;
  };
  const pobreza_rows = cnt("SELECT COUNT(*) FROM coneval_pobreza_municipal;");
  const irs_rows = cnt("SELECT COUNT(*) FROM coneval_irs_municipal;");
  return {
    pobreza_rows,
    irs_rows,
    duration_ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const pobrezaCsvPath = getArg("pobreza");
  const irsCsvPath = getArg("irs");
  if (!pobrezaCsvPath || !irsCsvPath) {
    console.error(
      "Usage: npx tsx scripts/load-coneval.ts --pobreza=/path/p.csv --irs=/path/irs.csv",
    );
    process.exit(1);
  }
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(`[load-coneval] loading pobreza + IRS → ${dbContainer} ...`);
  loadConeval({ pobrezaCsvPath, irsCsvPath, dbContainer })
    .then((r) => {
      console.log(
        `[load-coneval] ✓ pobreza=${r.pobreza_rows.toLocaleString()} | IRS=${r.irs_rows.toLocaleString()} en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-coneval] ✗ ${msg}`);
      process.exit(1);
    });
}
