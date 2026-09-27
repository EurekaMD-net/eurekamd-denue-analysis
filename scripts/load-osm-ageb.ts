/**
 * CLI: Load OpenStreetMap road aggregates per AGEB.
 *
 * v0.3.x — first satellite-/external-spatial layer in the warehouse.
 * Per-AGEB rollup of OSM road network metrics: road length, road density,
 * distance-to-nearest-major-road, road-class histogram. Joins to the rest
 * of the warehouse via cvegeo 13-char on `ageb_polygons`.
 *
 * Source: https://download.geofabrik.de/north-america/mexico-latest.osm.pbf
 *   (~750 MB, daily-refreshed). Fetch with scripts/fetch-osm-mexico.sh.
 *
 * Pipeline:
 *   1. osmium tags-filter — keep only w/highway ways from the PBF
 *      (~750 MB → ~80 MB), drop nodes/relations/non-road ways.
 *   2. osmium export — convert filtered PBF → GeoJSONSeq (~150 MB).
 *      One LineString feature per road segment with highway= tag.
 *   3. Copy the GeoJSONSeq into the Supabase container, ingest into a
 *      TEMPORARY table (geom + highway), build a GIST index. The temp
 *      table is session-scoped and disappears when psql exits.
 *   4. Aggregate against ageb_polygons.geom: SUM length intersecting
 *      each AGEB (cast to geography for true meters), divide by AGEB
 *      area for density, MIN distance to major roads (motorway/trunk/
 *      primary), per-class counts as JSONB. Write to osm_ageb_aggregates.
 *   5. The TEMPORARY table is gone after the psql session ends. Steady-
 *      state disk: ~10 MB for the 80k-row aggregate table.
 *
 * Idempotent: rerun freely. osm_ageb_aggregates is rebuilt on every run —
 * into osm_ageb_aggregates_staging, swapped in inside the aggregate's own
 * transaction (audit #145), so a failed run leaves the live table intact.
 * The GeoJSONSeq is rebuilt from the PBF every time.
 *
 * Stays inside the project's existing TS + psql + osmium toolchain — no
 * Python, no GDAL beyond what PostGIS already provides, no QGIS.
 *
 * Companion plan: docs/osm-roads-plan.md.
 */

import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { postLoadGrants } from "./_psql-tx.js";

// Matches load-clues.ts:32 — strict allowlist for docker container names
// to neutralize any flag-injection via env override.
const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

// Major road classes whose nearest-distance we surface as
// dist_to_major_road_m: motorway/trunk/primary. Hardcoded in
// buildAggregateSql's nearest_major CTE. Picked to match OSM convention for
// highway-grade connector roads (excludes residential/service which inflate
// "nearest") while keeping motorway/trunk/primary symmetric across MX
// urban + rural.

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function assertSafePath(label: string, p: string): void {
  if (p.length === 0 || p.startsWith("-")) {
    throw new Error(
      `loadOsmAgeb: ${label} inválido "${p}". No puede empezar con '-' ni estar vacío.`,
    );
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/**
 * Final aggregate table. PK = cvegeo (FK to ageb_polygons). Numeric columns
 * are NUMERIC not float — the rest of the warehouse uses NUMERIC for spatial
 * derivatives and a downstream divide-by-zero on density should error not
 * silently produce ±Infinity.
 */
function aggregateTableDdl(table: string): string {
  return `
DROP TABLE IF EXISTS ${table};
CREATE TABLE ${table} (
  -- cvegeo is the warehouse-wide AGEB key; no FK declared because
  -- ageb_polygons has its PK on ogc_fid (ogr2ogr-assigned), no UNIQUE
  -- on cvegeo. Consistent with how every other *_ageb consumer joins.
  cvegeo                       TEXT PRIMARY KEY,
  road_length_m                NUMERIC,
  road_density_km_per_km2      NUMERIC,
  dist_to_major_road_m         NUMERIC,
  has_major_road_within_5km    BOOLEAN,
  road_class_counts            JSONB,
  loaded_at                    TIMESTAMPTZ DEFAULT now()
);
COMMENT ON TABLE  ${table} IS 'Per-AGEB OSM road network rollup. Loaded by scripts/load-osm-ageb.ts from Geofabrik MX PBF. cvegeo joins to ageb_polygons / censo_ageb / coneval_grs_ageb_raw.';
COMMENT ON COLUMN ${table}.dist_to_major_road_m IS 'Geodetic distance (m) from AGEB centroid to nearest motorway/trunk/primary. NULL if no major road exists in the country slice (should be vanishingly rare for MX).';
COMMENT ON COLUMN ${table}.road_class_counts IS 'JSONB: {"residential":42, "secondary":3, ...}. Includes ALL highway classes counted within the AGEB, not just major.';

-- Consumer grants. Loader runs as 'postgres' which is OUTSIDE the
-- default-ACL path that auto-grants supabase_admin-created tables to
-- mcp_readonly. Explicit GRANTs keep the table reachable from:
--   - mcp_readonly (Jarvis mission-control via mcp__supabase__query)
--   - denue_sage   (Sage LLM-drafted SQL path in this analyzer)
-- Idempotent: re-running the loader re-issues these without conflict.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly') THEN
    EXECUTE 'GRANT SELECT ON ${table} TO mcp_readonly';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_sage') THEN
    EXECUTE 'GRANT SELECT ON ${table} TO denue_sage';
  END IF;
END $$;
`;
}

export const CREATE_AGGREGATE_TABLE_SQL = aggregateTableDdl("osm_ageb_aggregates");

/**
 * Build the aggregate SQL block. Runs inside a single psql session against a
 * TEMPORARY staging table (so the raw road geometry never lands persistently).
 *
 * Steps inside one psql session and ONE transaction (audit #145):
 *   - CREATE osm_ageb_aggregates_staging (same DDL + grants as the live table)
 *   - CREATE TEMP table osm_roads_staging (highway TEXT, geom geometry)
 *   - \copy GeoJSONSeq → JSONB temp loader → parse into staging
 *   - GIST index on staging.geom (only this session sees it)
 *   - INSERT INTO osm_ageb_aggregates_staging SELECT ... FROM ageb_polygons
 *       LEFT JOIN staging ON ST_Intersects(...)
 *   - DROP the live table, RENAME staging (and its PK index) into place,
 *     re-apply the P02 grant hygiene — all before COMMIT, so readers see
 *     the old table or the new one, never none or an empty one
 *   - psql exits → TEMP table + index gone, only osm_ageb_aggregates persists
 *
 * The `containerGeojsonPath` is the GeoJSONSeq path INSIDE the docker
 * container (after `docker cp`). Caller is responsible for that copy.
 *
 * `\copy` is used (not server-side COPY) so the path is interpreted on the
 * psql client side — same machine, but explicit.
 *
 * 5km threshold for has_major_road_within_5km: an arbitrary "this AGEB has
 * highway-grade access" boundary; tune later if it doesn't carry signal.
 */
export function buildAggregateSql(containerGeojsonPath: string): string {
  // Single-quote escape just in case the path ever picks up an apostrophe
  // (defense in depth — assertSafePath already rejects unsafe shapes).
  const escapedPath = containerGeojsonPath.replace(/'/g, "''");
  // QUOTE byte choice: any 0x01-0x1F byte is safe because JSON forbids
  // unescaped control bytes in strings (RFC 8259 §7). We pick 0x02 (STX);
  // 0x1E (RS) would collide with osmium's RFC 8142 geojsonseq prefix —
  // the prefix is stripped via sed in the loader BEFORE this SQL runs, but
  // belt-and-suspenders we keep the quote byte well clear of the strip set.
  // DELIMITER 0x01 (SOH) is equally control-byte-safe and never appears
  // mid-record (no multi-column ingest here — one JSONB per line).
  return `
\\set ON_ERROR_STOP on
SET statement_timeout = '25min';
BEGIN;
${aggregateTableDdl("osm_ageb_aggregates_staging")}

CREATE TEMPORARY TABLE osm_roads_loader (
  feat JSONB
) ON COMMIT DROP;

\\copy osm_roads_loader (feat) FROM '${escapedPath}' WITH (FORMAT csv, DELIMITER E'\\x01', QUOTE E'\\x02')

CREATE TEMPORARY TABLE osm_roads_staging ON COMMIT DROP AS
SELECT
  (feat->'properties'->>'highway')                         AS highway,
  ST_SetSRID(ST_GeomFromGeoJSON(feat->>'geometry'), 4326)  AS geom
FROM osm_roads_loader
WHERE feat->'properties' ? 'highway'
  AND feat->>'geometry' IS NOT NULL;

-- Pre-compute per-road centroid + geodesic length ONCE, then index it.
-- ST_Length on each road's full geometry is much cheaper than ST_Intersection
-- per (road, AGEB) pair — point-in-polygon attribution scales as
-- O(roads × log(AGEBs)) via the GIST below, vs O(roads × intersecting AGEBs
-- × polygon-clip cost) for the original ST_Intersection approach (which
-- statement_timeout'd at 25 min on the full MX dataset).
CREATE TEMPORARY TABLE osm_roads_centroids ON COMMIT DROP AS
SELECT
  highway,
  ST_Length(geom::geography)  AS road_len_m,
  ST_Centroid(geom)           AS pt
FROM osm_roads_staging
WHERE highway IS NOT NULL;
CREATE INDEX ON osm_roads_centroids USING GIST (pt);

-- Keep the major-road geometries available for the nearest_major LATERAL
-- (KNN needs the line geometry, not the centroid, for accurate distance).
CREATE INDEX ON osm_roads_staging USING GIST (geom)
  WHERE highway IN ('motorway','trunk','primary');

ANALYZE osm_roads_staging;
ANALYZE osm_roads_centroids;

INSERT INTO osm_ageb_aggregates_staging (
  cvegeo,
  road_length_m,
  road_density_km_per_km2,
  dist_to_major_road_m,
  has_major_road_within_5km,
  road_class_counts
)
WITH ageb_rollup AS (
  -- Centroid attribution: each road counts toward ONE AGEB (the one
  -- containing its midpoint). Long highways spanning multiple AGEBs are
  -- counted in whichever AGEB owns the midpoint — acceptable for
  -- "density per AGEB" since a road just clipping a corner shouldn't add
  -- much to that AGEB's density anyway. Trade-off documented at column
  -- comment time; consumers should treat road_length_m as "roads whose
  -- midpoint lies inside the AGEB", not as "linear meters of road within
  -- the AGEB polygon".
  SELECT
    a.cvegeo,
    ST_Area(a.geom::geography)                AS ageb_area_m2,
    COALESCE(SUM(rc.road_len_m), 0)           AS total_len_m,
    jsonb_object_agg(rc.highway, hw_count)
      FILTER (WHERE rc.highway IS NOT NULL)   AS class_counts
  FROM ageb_polygons a
  LEFT JOIN LATERAL (
    SELECT highway, COUNT(*) AS hw_count, SUM(road_len_m) AS road_len_m
    FROM osm_roads_centroids rc
    WHERE ST_Contains(a.geom, rc.pt)
    GROUP BY highway
  ) rc ON TRUE
  GROUP BY a.cvegeo, a.geom
),
nearest_major AS (
  SELECT
    a.cvegeo,
    MIN(ST_Distance(a.geom::geography, r.geom::geography))     AS dist_major_m
  FROM ageb_polygons a
  CROSS JOIN LATERAL (
    -- geom on both sides is already SRID 4326 (set at staging insert).
    -- ST_SetSRID wraps would defeat the GIST KNN index — keep unwrapped.
    SELECT geom
    FROM osm_roads_staging
    WHERE highway = ANY (ARRAY['motorway','trunk','primary'])
    ORDER BY geom <-> a.geom
    LIMIT 5
  ) r
  GROUP BY a.cvegeo
)
SELECT
  ar.cvegeo,
  ar.total_len_m                                                            AS road_length_m,
  CASE
    WHEN ar.ageb_area_m2 > 0
    THEN (ar.total_len_m / 1000.0) / (ar.ageb_area_m2 / 1000000.0)
    ELSE NULL
  END                                                                       AS road_density_km_per_km2,
  nm.dist_major_m                                                           AS dist_to_major_road_m,
  (nm.dist_major_m IS NOT NULL AND nm.dist_major_m <= 5000)                 AS has_major_road_within_5km,
  COALESCE(ar.class_counts, '{}'::jsonb)                                    AS road_class_counts
FROM ageb_rollup ar
LEFT JOIN nearest_major nm USING (cvegeo);

DROP TABLE IF EXISTS osm_ageb_aggregates;
ALTER TABLE osm_ageb_aggregates_staging RENAME TO osm_ageb_aggregates;
ALTER INDEX osm_ageb_aggregates_staging_pkey RENAME TO osm_ageb_aggregates_pkey;
${postLoadGrants(["osm_ageb_aggregates"])}

COMMIT;
`;
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

export interface LoadOsmAgebConfig {
  /** Path on the HOST filesystem to mexico-latest.osm.pbf */
  pbfPath: string;
  /** Working directory for intermediate filtered PBF + GeoJSONSeq */
  workDir: string;
  /** Docker container running Supabase Postgres */
  dbContainer: string;
  /** `osmium` binary path; default just "osmium" (looked up via $PATH). */
  osmiumBin?: string;
}

export interface LoadOsmAgebResult {
  pbf_bytes: number;
  filtered_pbf_bytes: number;
  geojson_bytes: number;
  ageb_rows_loaded: number;
  duration_ms: number;
}

export async function loadOsmAgeb(
  config: LoadOsmAgebConfig,
): Promise<LoadOsmAgebResult> {
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `loadOsmAgeb: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  assertSafePath("pbfPath", config.pbfPath);
  assertSafePath("workDir", config.workDir);
  const osmiumBin = config.osmiumBin ?? "osmium";
  assertSafePath("osmiumBin", osmiumBin);

  const started = Date.now();
  const filteredPbf = `${config.workDir}/mexico-roads.osm.pbf`;
  const geojsonPath = `${config.workDir}/mexico-roads.geojsonseq`;
  const containerGeojsonPath = "/tmp/osm_roads.geojsonseq";

  // 1. osmium tags-filter — keep only highway ways. -O = overwrite.
  execFileSync(
    osmiumBin,
    [
      "tags-filter",
      "--overwrite",
      "--output",
      filteredPbf,
      config.pbfPath,
      "w/highway",
    ],
    { encoding: "utf-8", timeout: 10 * 60_000 },
  );

  // 2. osmium export — emit GeoJSONSeq. osmium follows RFC 8142 strictly,
  //    so every record is prefixed with ASCII RS (0x1E). PG's `\copy CSV`
  //    cannot ingest that prefix as part of a JSON value — see step 2b.
  execFileSync(
    osmiumBin,
    [
      "export",
      "--overwrite",
      "--output-format=geojsonseq",
      "--geometry-types=linestring",
      "--output",
      geojsonPath,
      filteredPbf,
    ],
    { encoding: "utf-8", timeout: 15 * 60_000 },
  );

  // 2b. Strip the RFC 8142 RS prefix (0x1E) in place. After this step the
  //     file is pure newline-delimited JSON — each line a single feature
  //     object that PG can ingest as one JSONB value via \copy.
  execFileSync("sed", ["-i", "s/\\x1e//g", geojsonPath], {
    encoding: "utf-8",
    timeout: 5 * 60_000,
  });

  // 3-5. Copy GeoJSONSeq into the container, then run the aggregate inside
  //      a single psql session — staging table + TEMP table + GIST + INSERT
  //      + swap + COMMIT (audit #145: no separate DROP+CREATE step). The
  //      try/finally wraps BOTH the cp and the aggregate so a mid-pipeline
  //      failure still tries to remove the (possibly partial) ~150MB file
  //      from the container (audit W5).
  try {
    execFileSync(
      "docker",
      [
        "cp",
        "--",
        geojsonPath,
        `${config.dbContainer}:${containerGeojsonPath}`,
      ],
      { encoding: "utf-8", timeout: 10 * 60_000 },
    );

    // Pipe SQL via stdin, NOT `-c`. The aggregate script is multi-statement
    // and includes the `\copy` backslash meta-command (used to ingest the
    // GeoJSONSeq into the temp loader table). `psql -c "..."` only accepts
    // a single statement OR a single backslash command, NOT both — passing
    // the whole script via `-c` fails with `syntax error at or near "\"`.
    // Stdin / `-f` accept multi-statement scripts that mix SQL and \copy.
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
        "-v",
        "ON_ERROR_STOP=1",
      ],
      {
        input: buildAggregateSql(containerGeojsonPath),
        encoding: "utf-8",
        timeout: 60 * 60_000,
      },
    );
  } finally {
    try {
      execFileSync(
        "docker",
        ["exec", config.dbContainer, "rm", "-f", containerGeojsonPath],
        { encoding: "utf-8", timeout: 30_000 },
      );
    } catch {
      // best-effort cleanup; loader success ≠ cleanup success
    }
  }

  // 6. Verify counts (single round-trip per metric).
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
      throw new Error(`loadOsmAgeb: unexpected count output "${out}"`);
    }
    return n;
  };
  const ageb_rows_loaded = cnt("SELECT COUNT(*) FROM osm_ageb_aggregates;");

  return {
    pbf_bytes: statSync(config.pbfPath).size,
    filtered_pbf_bytes: existsSync(filteredPbf)
      ? statSync(filteredPbf).size
      : 0,
    geojson_bytes: existsSync(geojsonPath) ? statSync(geojsonPath).size : 0,
    ageb_rows_loaded,
    duration_ms: Date.now() - started,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const pbfPath = getArg("pbf") ?? "./raw/osm/mexico-latest.osm.pbf";
  const workDir = getArg("workdir") ?? "./raw/osm";
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  console.log(
    `[load-osm-ageb] pbf=${pbfPath}  workdir=${workDir}  container=${dbContainer}`,
  );
  loadOsmAgeb({ pbfPath, workDir, dbContainer })
    .then((r) => {
      const mb = (n: number) => (n / 1_048_576).toFixed(1);
      console.log(
        `[load-osm-ageb] ✓ pbf=${mb(r.pbf_bytes)}MB → filtered=${mb(r.filtered_pbf_bytes)}MB → geojson=${mb(r.geojson_bytes)}MB → ${r.ageb_rows_loaded.toLocaleString()} AGEB rows en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[load-osm-ageb] ✗ ${msg}`);
      process.exit(1);
    });
}
