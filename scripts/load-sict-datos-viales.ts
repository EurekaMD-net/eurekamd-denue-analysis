#!/usr/bin/env npx tsx --env-file=.env
/**
 * Loader: SICT Datos Viales (TDPA) 2024.
 *
 * Source: https://repodatos.atdt.gob.mx/api_update/secretaria_comunicaciones/datos_viales/datos_viales_2024.csv
 *
 * Schema doc: docs/scan-sict-datos-viales-2024.md
 *
 * Pipeline:
 *   1. Rename `k'` header → `k_prime` (PostgreSQL identifier rules).
 *   2. \copy raw CSV into `sict_estaciones_viales_raw_2024` (all TEXT).
 *   3. Build view `sict_estaciones_viales`:
 *      - DISTINCT ON dedupes border-double-reported stations (same lat/lon
 *        published under both estados).
 *      - Filter rows missing tdpa or lat/lon.
 *      - Cast numeric columns via NULLIF.
 *      - Spatial-join to mun_polygons (PostGIS ST_Contains, SRID 4326).
 *   4. Build MATERIALIZED VIEW `sict_traffic_by_municipio`:
 *      - Per-muni aggregates (station_count, tdpa_total/max/mean).
 *      - TDPA-weighted vehicle composition.
 *      - Top-3 routes by station count.
 *   5. Build MATERIALIZED VIEW `sict_traffic_by_estado` (v0.2.15):
 *      - Per-estado aggregates with the SAME formula as muni MV (re-applied
 *        from station-level rows; not rolled up from muni MV — averaging
 *        muni-percentages across estados drifts the weighted composition).
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/load-sict-datos-viales.ts \
 *     [--csv=raw/sict/datos_viales_2024.csv] [--force]
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { argv } from "node:process";

interface Args {
  csv: string;
  force: boolean;
  container: string;
}

// First char alphanumeric so the value cannot be interpreted as a docker flag
// (e.g. `--rm`). Same posture as load-cnbv-panorama.ts.
const SAFE_CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

function assertSafePath(p: string): void {
  const r = resolve(p);
  if (!SAFE_PATH_RE.test(r)) {
    throw new Error(`unsafe path: ${p}`);
  }
}

function parseArgs(): Args {
  const args = argv.slice(2);
  let csv = "raw/sict/datos_viales_2024.csv";
  let force = false;
  for (const a of args) {
    if (a.startsWith("--csv=")) csv = a.slice(6);
    else if (a === "--force") force = true;
  }
  return {
    csv,
    force,
    container: process.env.SUPABASE_DB_CONTAINER ?? "supabase-db",
  };
}

// --- Schema ---

// Raw table column ordering MUST match CSV header (after k' → k_prime rename).
// Keep this in sync with HEADER constant below and the DDL drift-guard test.
export const RAW_HEADER_COLS = [
  "periodo",
  "estado",
  "carretera",
  "clave",
  "ruta",
  "punto_generador",
  "km",
  "te",
  "sc",
  "tdpa",
  "m",
  "a",
  "b",
  "c2",
  "c3",
  "t3s2",
  "t3s3",
  "t3s2r4",
  "otros",
  "a1",
  "b1",
  "c",
  "k_prime",
  "d",
  "latitud",
  "longitud",
] as const;

export const NUMERIC_RAW_COLS = [
  "km",
  "te",
  "sc",
  "tdpa",
  "m",
  "a",
  "b",
  "c2",
  "c3",
  "t3s2",
  "t3s3",
  "t3s2r4",
  "otros",
  "a1",
  "b1",
  "c",
  "k_prime",
  "d",
  "latitud",
  "longitud",
] as const;

export const RAW_DDL = `
CREATE TABLE IF NOT EXISTS sict_estaciones_viales_raw_2024 (
  periodo TEXT,
  estado TEXT,
  carretera TEXT,
  clave TEXT,
  ruta TEXT,
  punto_generador TEXT,
  km TEXT,
  te TEXT,
  sc TEXT,
  tdpa TEXT,
  m TEXT,
  a TEXT,
  b TEXT,
  c2 TEXT,
  c3 TEXT,
  t3s2 TEXT,
  t3s3 TEXT,
  t3s2r4 TEXT,
  otros TEXT,
  a1 TEXT,
  b1 TEXT,
  c TEXT,
  k_prime TEXT,
  d TEXT,
  latitud TEXT,
  longitud TEXT,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sict_raw_clave
  ON sict_estaciones_viales_raw_2024(clave);
`.trim();

const numericCast = (col: string): string =>
  // Empty string AND literal 'sin dato' (495 rows in clave) AND '*' all → NULL.
  // The double-NULLIF guards against any of the three sentinels.
  `NULLIF(NULLIF(NULLIF(${col}, ''), 'sin dato'), '*')::numeric AS ${col}`;

// View 1: dedupe + spatial-join. The DISTINCT ON tuple intentionally INCLUDES
// estado so we keep both border copies alive in the view's underlying scan,
// then the spatial join filters them to the SAME muni — net effect: one row
// per (lat, lon, clave, punto_generador, km, te, sc) regardless of which
// estado published it. Empirically simpler: dedupe BEFORE the spatial join.
export const STATIONS_VIEW_DDL = `
-- Drop dependents BEFORE the base view. Postgres DROP VIEW does not cascade;
-- without this ordering a second \`--force\` reload after v0.2.15 fails with
-- "cannot drop view sict_estaciones_viales because other objects depend on it"
-- (the estado MV references this view). Audit C1 round-1 fix.
DROP MATERIALIZED VIEW IF EXISTS sict_traffic_by_estado;
DROP MATERIALIZED VIEW IF EXISTS sict_traffic_by_municipio;
DROP VIEW IF EXISTS sict_estaciones_viales;

CREATE VIEW sict_estaciones_viales AS
WITH dedup AS (
  SELECT DISTINCT ON (latitud, longitud, clave, punto_generador, km, te, sc)
    periodo,
    estado AS estado_publicado,
    carretera,
    clave,
    ruta,
    punto_generador,
    ${NUMERIC_RAW_COLS.map(numericCast).join(",\n    ")}
  FROM sict_estaciones_viales_raw_2024
  WHERE NULLIF(latitud, '') IS NOT NULL
    AND NULLIF(longitud, '') IS NOT NULL
    AND NULLIF(tdpa, '') IS NOT NULL
)
SELECT
  d.periodo,
  d.estado_publicado,
  d.carretera,
  d.clave,
  d.ruta,
  d.punto_generador,
  d.km,
  d.te,
  d.sc,
  d.tdpa,
  d.m, d.a, d.b, d.c2, d.c3, d.t3s2, d.t3s3, d.t3s2r4, d.otros,
  d.a1, d.b1, d.c,
  d.k_prime,
  d.d,
  d.latitud,
  d.longitud,
  mp.cvegeo AS cve_mun,
  mp.cve_ent
FROM dedup d
LEFT JOIN mun_polygons mp
  ON ST_Contains(mp.geom, ST_SetSRID(ST_MakePoint(d.longitud, d.latitud), 4326));
`.trim();

// View 2: per-muni aggregates. Camiones = sum of all truck axle classes.
export const TRAFFIC_BY_MUNI_DDL = `
CREATE MATERIALIZED VIEW sict_traffic_by_municipio AS
WITH per_muni AS (
  SELECT
    cve_mun,
    cve_ent,
    COUNT(*)::INTEGER AS station_count,
    SUM(tdpa)::INTEGER AS tdpa_total,
    MAX(tdpa)::INTEGER AS tdpa_max,
    ROUND(AVG(tdpa))::INTEGER AS tdpa_mean,
    -- TDPA-weighted vehicle composition (rounded 2dp).
    ROUND((SUM(m * tdpa) / NULLIF(SUM(tdpa), 0))::numeric, 2) AS pct_motos,
    ROUND((SUM(a * tdpa) / NULLIF(SUM(tdpa), 0))::numeric, 2) AS pct_autos,
    ROUND((SUM(b * tdpa) / NULLIF(SUM(tdpa), 0))::numeric, 2) AS pct_buses,
    ROUND(
      (SUM((c2 + c3 + t3s2 + t3s3 + t3s2r4) * tdpa) / NULLIF(SUM(tdpa), 0))::numeric,
      2
    ) AS pct_camiones,
    ROUND((SUM(otros * tdpa) / NULLIF(SUM(tdpa), 0))::numeric, 2) AS pct_otros,
    COUNT(DISTINCT ruta)::INTEGER AS route_count
  FROM sict_estaciones_viales
  WHERE cve_mun IS NOT NULL
  GROUP BY cve_mun, cve_ent
),
top_routes AS (
  -- Audit W1 round-1: tie-breaker ruta ASC matches the inner ROW_NUMBER's
  -- so ARRAY_AGG output ordering stays deterministic across REFRESH cycles
  -- AND mirrors the estado MV's tie-breaker (avoids cross-grain drift).
  SELECT
    cve_mun,
    ARRAY_AGG(ruta ORDER BY n DESC, ruta ASC)::TEXT[] AS routes_top
  FROM (
    SELECT cve_mun, ruta, COUNT(*) AS n,
           ROW_NUMBER() OVER (PARTITION BY cve_mun ORDER BY COUNT(*) DESC, ruta ASC) AS rk
    FROM sict_estaciones_viales
    WHERE cve_mun IS NOT NULL AND ruta IS NOT NULL
    GROUP BY cve_mun, ruta
  ) ranked
  WHERE rk <= 3
  GROUP BY cve_mun
)
SELECT
  pm.cve_mun,
  pm.cve_ent,
  pm.station_count,
  pm.tdpa_total,
  pm.tdpa_max,
  pm.tdpa_mean,
  pm.pct_motos,
  pm.pct_autos,
  pm.pct_buses,
  pm.pct_camiones,
  pm.pct_otros,
  pm.route_count,
  COALESCE(tr.routes_top, ARRAY[]::TEXT[]) AS routes_top
FROM per_muni pm
LEFT JOIN top_routes tr USING (cve_mun);

CREATE UNIQUE INDEX idx_sict_tbm_cve_mun
  ON sict_traffic_by_municipio(cve_mun);
CREATE INDEX idx_sict_tbm_cve_ent
  ON sict_traffic_by_municipio(cve_ent);
CREATE INDEX idx_sict_tbm_tdpa_total
  ON sict_traffic_by_municipio(tdpa_total DESC);
`.trim();

// View 3 (v0.2.15): per-estado aggregates. Built from the dedupe view, NOT
// from `sict_traffic_by_municipio` — averaging muni-level percentages would
// weight a 5-station muni equal to a 100-station muni and drift the estado
// composition. Re-applying the TDPA-weighted formula at estado grain uses
// the station-level absolute percentages (m, a, b, c2..t3s2r4, otros) which
// are already PER-TDPA fractions on the source row.
//
// Estado attribution uses SUBSTRING(cve_mun, 1, 2) — i.e. the spatially-
// joined muni's home estado, not the CSV-published `estado_publicado` column.
// This keeps semantics aligned with the muni MV: traffic physically inside
// estado X's borders, even if SICT published the station under a neighbor.
export const TRAFFIC_BY_ESTADO_DDL = `
CREATE MATERIALIZED VIEW sict_traffic_by_estado AS
WITH per_estado AS (
  SELECT
    SUBSTRING(cve_mun, 1, 2) AS cve_ent,
    COUNT(*)::INTEGER AS station_count,
    SUM(tdpa)::INTEGER AS tdpa_total,
    MAX(tdpa)::INTEGER AS tdpa_max,
    ROUND(AVG(tdpa))::INTEGER AS tdpa_mean,
    ROUND((SUM(m * tdpa) / NULLIF(SUM(tdpa), 0))::numeric, 2) AS pct_motos,
    ROUND((SUM(a * tdpa) / NULLIF(SUM(tdpa), 0))::numeric, 2) AS pct_autos,
    ROUND((SUM(b * tdpa) / NULLIF(SUM(tdpa), 0))::numeric, 2) AS pct_buses,
    ROUND(
      (SUM((c2 + c3 + t3s2 + t3s3 + t3s2r4) * tdpa) / NULLIF(SUM(tdpa), 0))::numeric,
      2
    ) AS pct_camiones,
    ROUND((SUM(otros * tdpa) / NULLIF(SUM(tdpa), 0))::numeric, 2) AS pct_otros,
    COUNT(DISTINCT ruta)::INTEGER AS route_count
  FROM sict_estaciones_viales
  WHERE cve_mun IS NOT NULL
  GROUP BY SUBSTRING(cve_mun, 1, 2)
),
top_routes AS (
  SELECT
    cve_ent,
    ARRAY_AGG(ruta ORDER BY n DESC, ruta ASC)::TEXT[] AS routes_top
  FROM (
    SELECT
      SUBSTRING(cve_mun, 1, 2) AS cve_ent,
      ruta,
      COUNT(*) AS n,
      ROW_NUMBER() OVER (
        PARTITION BY SUBSTRING(cve_mun, 1, 2)
        ORDER BY COUNT(*) DESC, ruta ASC
      ) AS rk
    FROM sict_estaciones_viales
    WHERE cve_mun IS NOT NULL AND ruta IS NOT NULL
    GROUP BY SUBSTRING(cve_mun, 1, 2), ruta
  ) ranked
  WHERE rk <= 3
  GROUP BY cve_ent
)
SELECT
  pe.cve_ent,
  pe.station_count,
  pe.tdpa_total,
  pe.tdpa_max,
  pe.tdpa_mean,
  pe.pct_motos,
  pe.pct_autos,
  pe.pct_buses,
  pe.pct_camiones,
  pe.pct_otros,
  pe.route_count,
  COALESCE(tr.routes_top, ARRAY[]::TEXT[]) AS routes_top
FROM per_estado pe
LEFT JOIN top_routes tr USING (cve_ent);

CREATE UNIQUE INDEX idx_sict_tbe_cve_ent
  ON sict_traffic_by_estado(cve_ent);
CREATE INDEX idx_sict_tbe_tdpa_total
  ON sict_traffic_by_estado(tdpa_total DESC);
`.trim();

// Audit W1 (round-2): execute ALL view DDLs in ONE transaction so a partial
// failure (e.g. transient psql restart between calls) cannot leave
// `sict_estaciones_viales` alive without its consumer MVs — which would 500
// every `municipio-detail` and `entidad-detail` request via the LEFT JOIN.
// `BEGIN ... COMMIT` makes the creates atomic; rollback restores prior state.
//
// Round-3 audit W2: `\echo` markers between DDL blocks so a partial psql
// failure (under `ON_ERROR_STOP=1`) emits an unambiguous "we got past X,
// failed at Y" trail in stderr.
export const VIEWS_DDL_TRANSACTION = `
BEGIN;

\\echo [load-sict] building stations view (DISTINCT ON dedupe + spatial join)...

${STATIONS_VIEW_DDL}

\\echo [load-sict] building traffic-by-municipio MV + indexes...

${TRAFFIC_BY_MUNI_DDL}

\\echo [load-sict] building traffic-by-estado MV + indexes...

${TRAFFIC_BY_ESTADO_DDL}

COMMIT;
`.trim();

export const POST_LOAD_VERIFY_SQL = `
SELECT
  (SELECT COUNT(*) FROM sict_estaciones_viales_raw_2024) AS raw_rows,
  (SELECT COUNT(*) FROM sict_estaciones_viales) AS view_stations,
  (SELECT COUNT(DISTINCT cve_mun) FROM sict_estaciones_viales WHERE cve_mun IS NOT NULL) AS distinct_muni,
  (SELECT COUNT(*) FROM sict_traffic_by_municipio) AS muni_with_traffic,
  (SELECT COUNT(*) FROM sict_traffic_by_estado) AS estados_with_traffic;
`.trim();

// --- Loader ---

function dockerExec(container: string, args: string[]): string {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name: ${container}`);
  }
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function dockerExecStdin(
  container: string,
  args: string[],
  stdin: string | Buffer,
): string {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name: ${container}`);
  }
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    encoding: "utf-8",
    input: stdin,
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * Rewrite the CSV header line so `k'` becomes `k_prime`. Body rows are
 * untouched; the apostrophe-named column does not appear in body content.
 */
export function rewriteHeader(csv: string): string {
  const nl = csv.indexOf("\n");
  if (nl < 0) throw new Error("CSV has no newline — file empty or corrupt");
  const header = csv.slice(0, nl);
  const body = csv.slice(nl);
  const expected =
    "periodo,estado,carretera,clave,ruta,punto_generador,km,te,sc,tdpa,m,a,b,c2,c3,t3s2,t3s3,t3s2r4,otros,a1,b1,c,k',d,latitud,longitud";
  const cleaned = header.replace(/\r$/, "");
  if (cleaned !== expected) {
    throw new Error(
      `Unexpected CSV header. Got:\n  ${cleaned}\nExpected:\n  ${expected}\nIf SICT changed schema, update RAW_HEADER_COLS + DDL.`,
    );
  }
  // Audit W4 (round-2): anchor the swap with surrounding column names so a
  // future schema where a different column accidentally ends in apostrophe
  // (e.g. a hypothetical `risk',`) cannot redirect the replace. The exact
  // assertion above on the entire header gives belt; this is suspenders.
  return cleaned.replace(",c,k',d,", ",c,k_prime,d,") + body;
}

export async function loadSictDatosViales(args: Args): Promise<void> {
  if (!existsSync(args.csv)) {
    throw new Error(
      `[load-sict] CSV not found: ${args.csv}. Download from https://repodatos.atdt.gob.mx/api_update/secretaria_comunicaciones/datos_viales/datos_viales_2024.csv`,
    );
  }
  assertSafePath(args.csv);

  // 1. Apply schema (idempotent).
  console.log("[load-sict] applying schema...");
  dockerExecStdin(
    args.container,
    ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    RAW_DDL,
  );

  // 2. Idempotency guard.
  const countOut = dockerExec(args.container, [
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tA",
    "-c",
    "SELECT COUNT(*) FROM sict_estaciones_viales_raw_2024;",
  ]).trim();
  const existing = Number.parseInt(countOut || "0", 10);
  if (existing > 0 && !args.force) {
    throw new Error(
      `[load-sict] sict_estaciones_viales_raw_2024 has ${existing} rows. Use --force to truncate + reload.`,
    );
  }

  // 3. Rewrite header → tempfile.
  const tempdir = mkdtempSync(join(tmpdir(), "sict-datos-viales-"));
  try {
    const cleanedPath = join(tempdir, "datos_viales_2024.cleaned.csv");
    const raw = readFileSync(args.csv, "utf-8");
    writeFileSync(cleanedPath, rewriteHeader(raw));

    // 4. Truncate raw + \copy.
    console.log("[load-sict] truncating + loading raw CSV...");
    dockerExecStdin(
      args.container,
      ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
      `TRUNCATE TABLE sict_estaciones_viales_raw_2024;`,
    );

    const copyCmd = `\\copy sict_estaciones_viales_raw_2024 (${RAW_HEADER_COLS.join(", ")}) FROM STDIN WITH (FORMAT csv, HEADER true)`;
    const csvBuf = readFileSync(cleanedPath);
    execFileSync(
      "docker",
      [
        "exec",
        "-i",
        args.container,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        copyCmd,
      ],
      { input: csvBuf, maxBuffer: 64 * 1024 * 1024 },
    );

    // 5. Build views atomically (audit W1: one transaction so partial
    //    failure cannot leave the API in a broken state).
    console.log("[load-sict] building views (atomic transaction)...");
    dockerExecStdin(
      args.container,
      ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
      VIEWS_DDL_TRANSACTION,
    );

    // 6. Verify.
    const stats = dockerExec(args.container, [
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-tA",
      "-c",
      POST_LOAD_VERIFY_SQL,
    ]).trim();
    console.log(`[load-sict] done. ${stats}`);
  } finally {
    rmSync(tempdir, { recursive: true, force: true });
  }
}

// Auto-invoke when run directly (not when imported by tests). Match CNBV
// loader pattern: fire-and-forget Promise chain, no top-level await.
const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");
if (isMain) {
  loadSictDatosViales(parseArgs()).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[load-sict] ✗ ${msg}`);
    process.exit(1);
  });
}
