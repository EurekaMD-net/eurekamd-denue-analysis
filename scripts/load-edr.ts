/**
 * CLI: Load EDR (Estadísticas de Defunciones Registradas) — INEGI.
 *
 * v0.2.3-A of the analytical roadmap. Per-record mortality microdata with
 * CIE-10 cause codes, age, sex, residence, and circumstance. Joins to the
 * rest of the warehouse via cve_mun (5-char ENT||MUN) derived from the
 * `ent_resid` + `mun_resid` columns (entity + municipio of habitual
 * residence of the deceased). Closes the "salud poblacional" quadrant
 * complementing CLUES (capacity) + CONEVAL (welfare) + SESNSP (violence).
 *
 * Source: https://www.inegi.org.mx/programas/edr/
 *   Direct ZIP (operator-supplied 2026-05-05):
 *   https://www.inegi.org.mx/contenidos/programas/edr/datosabiertos/defunciones/2024/conjunto_de_datos_edr2024_csv.zip
 *
 * The ZIP unpacks to:
 *   - conjunto_de_datos/conjunto_de_datos_defunciones_registradas24_csv.csv (the data, 819,672 rows + header)
 *   - catalogos/* (column-value lookup CSVs — not loaded; used as reference only)
 *   - diccionario_de_datos/* (column dictionary — see top comment for schema)
 *
 * Behavior:
 *   1. Drop+create inegi_edr_defunciones_raw table (74 TEXT cols) idempotently.
 *   2. \copy CSV in (~820k rows / year — 2024 = 819,672).
 *   3. Build cve_mun btree + anio_ocur btree on raw for fast aggregation.
 *   4. Mat-view `mv_mortalidad_municipal_yearly` (separate file
 *      scripts/perf-matviews.sql — same as the SESNSP pattern). Loader
 *      prints reminder to run scripts/refresh-matviews.sh.
 *
 * Idempotent: rerun freely. The CSV is the boundary of trust. Reloading
 * an already-loaded year DROPs and recreates — no append.
 *
 * For multi-year loads (e.g. operator drops 2022, 2023, 2024 separately),
 * use --append to skip the DROP. The btree+mat-view are per-year-agnostic.
 */

import { execFileSync } from "node:child_process";
import { openSync, readSync, closeSync } from "node:fs";

const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function getFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
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

/**
 * Parse the year of registration (`anio_regis`, column index 31 in
 * EDR_COLUMNS) from the first data row of the CSV. Used by --append loads
 * to purge prior-loaded rows for the same registration year before \copy
 * (audit M1 — without this, re-running the same year doubles every
 * aggregate silently). Returns the 4-digit year string, or null if the
 * value is missing/malformed (caller treats as "skip purge"; load still
 * proceeds on raw table append).
 *
 * Assumes the CSV is anio_regis-homogeneous, which INEGI EDR releases
 * always are by design (one release = one calendar year of registrations,
 * even though individual rows may have anio_ocur in earlier years).
 */
export function readAnioRegisFromFirstDataRow(path: string): string | null {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(64 * 1024);
    const bytes = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, bytes).toString("utf-8");
    // Skip header line.
    const firstNl = text.indexOf("\n");
    if (firstNl === -1) return null;
    const rest = text.slice(firstNl + 1);
    const secondNl = rest.indexOf("\n");
    const dataLine = secondNl === -1 ? rest : rest.slice(0, secondNl);
    if (dataLine.trim().length === 0) return null;
    // EDR_COLUMNS has anio_regis at index 31. CSV is comma-delimited with
    // some columns wrapped in quotes; anio_regis is numeric so it ships
    // unquoted, but a defensive split-and-strip handles both.
    const fields = dataLine.split(",");
    if (fields.length < 32) return null;
    const raw = (fields[31] ?? "").trim().replace(/^"|"$/g, "");
    if (!/^(19|20)[0-9]{2}$/.test(raw)) return null;
    return raw;
  } finally {
    closeSync(fd);
  }
}

function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-")) {
    throw new Error(
      `loadEdr: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
    );
  }
}

/**
 * 74 INEGI EDR column names in canonical CSV order. Source of truth is
 * `diccionario_de_datos/diccionario_datos_defunciones_registradas_2024.csv`
 * inside the ZIP. Names match the CSV header verbatim — header validation
 * below asserts this exact list.
 */
export const EDR_COLUMNS = [
  "ent_regis",
  "mun_regis",
  "tloc_regis",
  "loc_regis",
  "ent_resid",
  "mun_resid",
  "tloc_resid",
  "loc_resid",
  "ent_ocurr",
  "mun_ocurr",
  "tloc_ocurr",
  "loc_ocurr",
  "causa_def",
  "cod_adicio",
  "lista_mex",
  "sexo",
  "ent_nac",
  "afromex",
  "conindig",
  "lengua",
  "cve_lengua",
  "nacionalid",
  "nacesp_cve",
  "edad",
  "sem_gest",
  "gramos",
  "dia_ocurr",
  "mes_ocurr",
  "anio_ocur",
  "dia_regis",
  "mes_regis",
  "anio_regis",
  "dia_nacim",
  "mes_nacim",
  "anio_nacim",
  "cond_act",
  "ocupacion",
  "escolarida",
  "edo_civil",
  "tipo_defun",
  "ocurr_trab",
  "lugar_ocur",
  "par_agre",
  "vio_fami",
  "asist_medi",
  "cirugia",
  "natviole",
  "necropsia",
  "usonecrops",
  "encefalica",
  "donador",
  "sitio_ocur",
  "cond_cert",
  "derechohab",
  "embarazo",
  "rel_emba",
  "horas",
  "minutos",
  "capitulo",
  "grupo",
  "lista1",
  "gr_lismex",
  "area_ur",
  "edad_agru",
  "complicaro",
  "dia_cert",
  "mes_cert",
  "anio_cert",
  "maternas",
  "ent_ocules",
  "mun_ocules",
  "loc_ocules",
  "razon_m",
  "dis_re_oax",
] as const;

export function expectEdrHeader(headerLine: string): void {
  const cols = headerLine
    .replace(/^﻿/, "")
    .trim()
    .split(",")
    .map((c) => c.trim().toLowerCase());
  if (cols.length !== EDR_COLUMNS.length) {
    throw new Error(
      `loadEdr: expected ${EDR_COLUMNS.length} columns, got ${cols.length}. Got header: ${headerLine.slice(0, 120)}...`,
    );
  }
  for (let i = 0; i < EDR_COLUMNS.length; i++) {
    if (cols[i] !== EDR_COLUMNS[i]) {
      throw new Error(
        `loadEdr: column ${i + 1} mismatch — expected "${EDR_COLUMNS[i]}", got "${cols[i]}". CSV schema may have changed; review diccionario_datos.csv.`,
      );
    }
  }
  // Defense: every column name must be a safe SQL identifier (the 74-list
  // is curated, but this guard catches a future maintainer slipping in a
  // hyphenated alias by mistake).
  for (const c of cols) {
    if (!/^[a-z][a-z0-9_]*$/.test(c)) {
      throw new Error(`loadEdr: unsafe column name "${c}"`);
    }
  }
}

const EDR_DDL = `
DROP TABLE IF EXISTS inegi_edr_defunciones_raw CASCADE;
CREATE TABLE inegi_edr_defunciones_raw (
  ${EDR_COLUMNS.map((c) => `${c} TEXT`).join(",\n  ")}
);
CREATE INDEX idx_edr_ent_resid ON inegi_edr_defunciones_raw (ent_resid);
CREATE INDEX idx_edr_anio_ocur ON inegi_edr_defunciones_raw (anio_ocur);
CREATE INDEX idx_edr_cve_mun_resid
  ON inegi_edr_defunciones_raw ((ent_resid || mun_resid))
  WHERE ent_resid IN ('01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','31','32')
    AND mun_resid IS NOT NULL AND mun_resid != '999';
`;

export const EDR_DDL_FOR_TEST = EDR_DDL;

export interface LoadEdrConfig {
  csvPath: string;
  dbContainer: string;
  /** When true, skip the DROP — used for multi-year stacking loads. */
  append?: boolean;
}

export interface LoadEdrResult {
  raw_rows: number;
  rows_with_residence: number;
  rows_unique_municipios: number;
  duration_ms: number;
}

export async function loadEdr(config: LoadEdrConfig): Promise<LoadEdrResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadEdr: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  assertSafePath("csvPath", config.csvPath);

  expectEdrHeader(readFirstLine(config.csvPath));

  const started = Date.now();

  // 1. Create raw table (skip in append mode — caller is stacking).
  // In append mode, instead purge any prior load for the same anio_regis
  // (audit M1 — without this, re-running the same year doubles every
  // aggregate silently). The CSV is anio_regis-homogeneous by INEGI design.
  if (!config.append) {
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
        EDR_DDL,
      ],
      { encoding: "utf-8", timeout: 120_000 },
    );
  } else {
    const year = readAnioRegisFromFirstDataRow(config.csvPath);
    if (year !== null) {
      // Year value is regex-validated (^(19|20)[0-9]{2}$) so safe to inline.
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
          `DELETE FROM inegi_edr_defunciones_raw WHERE anio_regis = '${year}';`,
        ],
        { encoding: "utf-8", timeout: 5 * 60_000 },
      );
    }
    // Year unparseable → skip purge. Loader still appends; operator can
    // catch the duplication via the count assertions in the result.
  }

  // 2. Copy CSV in via temp container path + try/finally cleanup
  const containerPath = `/tmp/edr_raw_${Date.now()}.csv`;
  execFileSync(
    "docker",
    ["cp", "--", config.csvPath, `${config.dbContainer}:${containerPath}`],
    { encoding: "utf-8", timeout: 10 * 60_000 },
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
        `\\copy inegi_edr_defunciones_raw FROM '${containerPath}' WITH (FORMAT csv, HEADER true)`,
      ],
      { encoding: "utf-8", timeout: 30 * 60_000 },
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
      throw new Error(`loadEdr: unexpected count output "${out}"`);
    }
    return n;
  };

  const raw_rows = cnt("SELECT COUNT(*) FROM inegi_edr_defunciones_raw;");
  const rows_with_residence = cnt(
    `SELECT COUNT(*) FROM inegi_edr_defunciones_raw
     WHERE ent_resid IN ('01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','31','32')
       AND mun_resid IS NOT NULL AND mun_resid != '999';`,
  );
  const rows_unique_municipios = cnt(
    `SELECT COUNT(DISTINCT ent_resid || mun_resid) FROM inegi_edr_defunciones_raw
     WHERE ent_resid IN ('01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21','22','23','24','25','26','27','28','29','30','31','32')
       AND mun_resid IS NOT NULL AND mun_resid != '999';`,
  );

  return {
    raw_rows,
    rows_with_residence,
    rows_unique_municipios,
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
  const append = getFlag("append");
  if (!csvPath) {
    console.error(
      "Usage: npx tsx scripts/load-edr.ts --csv=/path/to/conjunto_de_datos_defunciones_registradas24_csv.csv [--append]",
    );
    console.error(
      "  --append: skip DROP+CREATE so multiple years stack into the same raw table.",
    );
    process.exit(1);
  }
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(
    `[load-edr] loading EDR ${append ? "(append)" : "(replace)"} → ${dbContainer} ...`,
  );
  loadEdr({ csvPath, dbContainer, append })
    .then((r) => {
      console.log(
        `[load-edr] ✓ raw=${r.raw_rows.toLocaleString()} | con residencia=${r.rows_with_residence.toLocaleString()} | municipios únicos=${r.rows_unique_municipios.toLocaleString()} en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      console.log(
        `[load-edr] reminder: refresh analytics mat-views: scripts/refresh-matviews.sh`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-edr] ✗ ${msg}`);
      process.exit(1);
    });
}
