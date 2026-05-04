/**
 * CLI: Load CLUES (Clave Única de Establecimientos de Salud) — DGIS catálogo.
 *
 * v0.2.2 of the analytical roadmap. Health-facility directory with lat/lon,
 * institution, level-of-care, and bed/consultorio counts. Joins to the rest
 * of the warehouse via cve_mun (5-char ENT||MUN, derived from the two CLUES
 * code columns) and via PostGIS spatial proximity to establecimientos.geom.
 *
 * Source: http://www.dgis.salud.gob.mx/contenidos/intercambio/clues_gobmx.html
 *   → http://gobi.salud.gob.mx/gobi/catalogos/catalogosmaestros/ESTABLECIMIENTO_SALUD_YYYYMM.xlsx
 *
 * The XLSX has three sheets: CLUES_YYYYMM (canonical), SUBCLUES_YYYYMM,
 * HORARIOS_YYYYMM. Only the first sheet is loaded here. The 68 columns are
 * normalized to snake_case ASCII headers in the CSV pre-pass (see
 * docs/v0.2-status.md for the openpyxl conversion script).
 *
 * Behavior:
 *   1. Drop+create clues_raw table (68 TEXT columns) idempotently.
 *   2. \copy CSV in (~63k rows: 41k EN OPERACION + 22k FUERA + handful of
 *      under-construction).
 *   3. Replace `clues` materialized view filtered to EN OPERACION with cast
 *      columns: nivel_atencion::int, lat/lon::numeric, geom POINT(4326).
 *      MATERIALIZED so we can build a GIST index over geom for ST_DWithin.
 *   4. Create btree index on cve_mun + GIST index on geom.
 *
 * Idempotent: rerun freely. The CSV is the boundary of trust.
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
      `loadClues: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
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
        `loadClues: unsafe column name "${c}" in ${headerLine.slice(0, 80)}...`,
      );
    }
  }
  for (const e of expected) {
    if (!cols.includes(e)) {
      throw new Error(
        `loadClues: missing required column "${e}". Got: ${cols.slice(0, 10).join(",")}...`,
      );
    }
  }
}

const CLUES_REQUIRED = [
  "clues",
  "clave_de_la_entidad",
  "clave_del_municipio",
  "clave_de_la_localidad",
  "estatus_de_operacion",
  "clave_nivel_atencion",
  "latitud",
  "longitud",
];

const CLUES_DDL = `
DROP TABLE IF EXISTS clues_raw CASCADE;
CREATE TABLE clues_raw (
  clues TEXT,
  clave_de_la_institucion TEXT, nombre_de_la_institucion TEXT,
  clave_de_la_entidad TEXT, entidad TEXT,
  clave_del_municipio TEXT, municipio TEXT,
  clave_de_la_localidad TEXT, localidad TEXT,
  clave_de_la_jurisdiccion TEXT, jurisdiccion TEXT,
  clave_del_tipo_establecimiento TEXT, nombre_tipo_establecimiento TEXT,
  clave_de_tipologia TEXT, nombre_de_tipologia TEXT,
  clave_de_subtipologia TEXT, nombre_de_subtipologia TEXT,
  nombre_de_la_unidad TEXT, nombre_comercial TEXT,
  clave_tipo_de_vialidad TEXT, tipo_de_vialidad TEXT, vialidad TEXT,
  numero_exterior TEXT, numero_interior TEXT,
  clave_tipo_de_asentamiento TEXT, tipo_de_asentamiento TEXT, asentamiento TEXT,
  codigo_postal TEXT, referencias_del_domicilio TEXT,
  clave_estatus_de_operacion TEXT, estatus_de_operacion TEXT,
  rfc_del_establecimiento TEXT,
  telefono_1_del_establecimiento TEXT, extension_telefonica_1_del_establecimiento TEXT,
  telefono_2_del_establecimiento TEXT, extension_telefonica_2_del_establecimiento TEXT,
  fecha_de_construccion TEXT, fecha_de_inicio_de_operacion TEXT,
  clave_unidad_movil_marca TEXT, unidad_movil_marca TEXT,
  unidad_movil_marca_especifica TEXT, unidad_movil_modelo TEXT,
  clave_unidad_movil_programa TEXT, unidad_movil_programa TEXT,
  clave_unidad_movil_tipo TEXT, unidad_movil_tipo TEXT,
  clave_unidad_movil_tipologia TEXT, unidad_movil_tipologia TEXT,
  clave_de_la_ins_adm TEXT, nombre_de_la_ins_adm TEXT,
  clave_nivel_atencion TEXT, nivel_atencion TEXT,
  clave_estrato_unidad TEXT, estrato_unidad TEXT,
  clave_tipo_obra TEXT, tipo_obra TEXT,
  clave_propiedad_del_inmueble TEXT, propiedad_del_inmueble TEXT,
  observaciones_al_registro TEXT,
  latitud TEXT, longitud TEXT,
  clave_ultimo_movimiento TEXT, ultimo_movimiento TEXT, fecha_ultimo_movimiento TEXT,
  comentarios_de_la_validacion TEXT,
  clave_motivo_baja TEXT, motivo_baja TEXT, fecha_efectiva_de_baja TEXT
);
`;

/**
 * Post-load SQL (materialized view + indexes). Exported so tests can assert
 * NULL/empty guards on every cast — same audit-C1-style guard from the
 * coneval loader.
 *
 * The view is MATERIALIZED so a GIST index can be built on the geom column
 * for ST_DWithin proximity joins to establecimientos. Refresh implicit on
 * CREATE; future reloads happen via DROP+CREATE in this same SQL.
 */
export const POST_LOAD_SQL_FOR_TEST = `
-- NULLIF strips empty-string sentinel so casts succeed. lat/lon are TEXT in
-- raw because non-geocoded rows ship as ''. Filter to EN OPERACION units
-- with valid coordinates for the canonical view.
DROP MATERIALIZED VIEW IF EXISTS clues CASCADE;
CREATE MATERIALIZED VIEW clues AS
SELECT
  clues                                                        AS clave_clues,
  clave_de_la_institucion                                      AS institucion,
  nombre_de_la_institucion                                     AS institucion_nombre,
  clave_de_la_entidad                                          AS entidad,
  clave_del_municipio                                          AS municipio_codigo,
  (clave_de_la_entidad || clave_del_municipio)                 AS cve_mun,
  (clave_de_la_entidad || clave_del_municipio || clave_de_la_localidad) AS cve_loc,
  municipio                                                    AS municipio_nombre,
  localidad                                                    AS localidad_nombre,
  clave_de_tipologia                                           AS tipologia_codigo,
  nombre_de_tipologia                                          AS tipologia,
  nombre_tipo_establecimiento                                  AS tipo_establecimiento,
  nombre_de_la_unidad                                          AS unidad_nombre,
  NULLIF(clave_nivel_atencion, '')::int                        AS nivel_atencion,
  nivel_atencion                                               AS nivel_atencion_nombre,
  estatus_de_operacion                                         AS estatus,
  codigo_postal,
  NULLIF(latitud, '')::numeric                                 AS lat,
  NULLIF(longitud, '')::numeric                                AS lon,
  CASE
    WHEN NULLIF(latitud, '') IS NOT NULL AND NULLIF(longitud, '') IS NOT NULL
    THEN ST_SetSRID(ST_MakePoint(longitud::numeric, latitud::numeric), 4326)
    ELSE NULL
  END                                                          AS geom
FROM clues_raw
WHERE estatus_de_operacion = 'EN OPERACION';

DROP INDEX IF EXISTS idx_clues_cve_mun;
CREATE INDEX idx_clues_cve_mun ON clues (cve_mun);

DROP INDEX IF EXISTS idx_clues_cve_loc;
CREATE INDEX idx_clues_cve_loc ON clues (cve_loc);

DROP INDEX IF EXISTS idx_clues_geom;
CREATE INDEX idx_clues_geom ON clues USING GIST (geom);

DROP INDEX IF EXISTS idx_clues_institucion;
CREATE INDEX idx_clues_institucion ON clues (institucion);

DROP INDEX IF EXISTS idx_clues_nivel;
CREATE INDEX idx_clues_nivel ON clues (nivel_atencion);
`;

export interface LoadCluesConfig {
  csvPath: string;
  dbContainer: string;
}

export interface LoadCluesResult {
  raw_rows: number;
  clues_rows: number;
  clues_with_geom: number;
  duration_ms: number;
}

export async function loadClues(
  config: LoadCluesConfig,
): Promise<LoadCluesResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadClues: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  assertSafePath("csvPath", config.csvPath);

  expectSafeIdentList(readFirstLine(config.csvPath), CLUES_REQUIRED);

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
      CLUES_DDL,
    ],
    { encoding: "utf-8", timeout: 60_000 },
  );

  // 2. Copy CSV in + \copy with try/finally cleanup
  const containerPath = "/tmp/clues_raw.csv";
  execFileSync(
    "docker",
    ["cp", "--", config.csvPath, `${config.dbContainer}:${containerPath}`],
    { encoding: "utf-8", timeout: 5 * 60_000 },
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
        `\\copy clues_raw FROM '${containerPath}' WITH (FORMAT csv, HEADER true)`,
      ],
      { encoding: "utf-8", timeout: 10 * 60_000 },
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

  // 3. Post-load: materialized view + indexes
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
      throw new Error(`loadClues: unexpected count output "${out}"`);
    }
    return n;
  };
  const raw_rows = cnt("SELECT COUNT(*) FROM clues_raw;");
  const clues_rows = cnt("SELECT COUNT(*) FROM clues;");
  const clues_with_geom = cnt(
    "SELECT COUNT(*) FROM clues WHERE geom IS NOT NULL;",
  );
  return {
    raw_rows,
    clues_rows,
    clues_with_geom,
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
    console.error("Usage: npx tsx scripts/load-clues.ts --csv=/path/clues.csv");
    process.exit(1);
  }
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(`[load-clues] loading CLUES → ${dbContainer} ...`);
  loadClues({ csvPath, dbContainer })
    .then((r) => {
      console.log(
        `[load-clues] ✓ raw=${r.raw_rows.toLocaleString()} | EN OPERACION=${r.clues_rows.toLocaleString()} | con geom=${r.clues_with_geom.toLocaleString()} en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-clues] ✗ ${msg}`);
      process.exit(1);
    });
}
