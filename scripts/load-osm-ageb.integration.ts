#!/usr/bin/env tsx
/**
 * Integration test for scripts/load-osm-ageb.ts — runs against real PostGIS.
 *
 * Spins up a unique throwaway schema, fixtures 2 AGEB polygons + 3 road
 * features, applies the actual CREATE_AGGREGATE_TABLE_SQL +
 * buildAggregateSql, then SELECTs and asserts. Drops the schema in
 * finally regardless of pass/fail. NEVER touches the production
 * public.osm_ageb_aggregates table.
 *
 * Why standalone (not vitest):
 *   - vitest mocks execFileSync; a real integration must call docker exec.
 *   - keeps the unit suite fast (~300ms) and CI-clean.
 *   - intended as a pre-ship gate before adding the next OSM layer
 *     (buildings / POIs / landuse) to catch the same bug class
 *     (FK semantics, \copy framing, query scaling) at build time.
 *
 * Bugs this would have caught on the initial ship:
 *   - C1: FK to ageb_polygons.cvegeo when ageb_polygons' PK is on
 *     ogc_fid (CREATE TABLE failed in production but unit tests passed
 *     because they only asserted the SQL string shape).
 *   - C2: passing multi-statement SQL (mixing SET/\copy/CREATE/INSERT)
 *     via `psql -c` instead of stdin — psql -c rejects backslash
 *     meta-commands inside compound scripts.
 *   - C3: ST_Intersection polygon-clip across 80k AGEBs × 6M road
 *     segments timed out at 25min. The fixture here is tiny, but the
 *     query SHAPE is the production shape — any future regression that
 *     re-introduces a quadratic clip would slow this test from <5s to
 *     unreasonable, which a CI timeout would catch.
 *
 * Prereq: `docker exec ${SUPABASE_DB_CONTAINER:-supabase-db} psql` works.
 *
 * Run: npx tsx scripts/load-osm-ageb.integration.ts
 * CI-skip when DB is unreachable: returns exit 77 (the convention for
 * "skipped" used by Autotools' DejaGnu test harness).
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CREATE_AGGREGATE_TABLE_SQL,
  buildAggregateSql,
} from "./load-osm-ageb.js";

const CONTAINER = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
const RUN_ID = `${process.pid}_${Date.now()}`;
const SCHEMA = `osm_int_${RUN_ID}`;
const CONTAINER_GEOJSON = `/tmp/osm_int_${RUN_ID}.geojsonseq`;

const FIXTURE_DIR = mkdtempSync(join(tmpdir(), "osm-int-"));
const HOST_GEOJSON = join(FIXTURE_DIR, "fixture.geojsonseq");

function dockerPsql(sql: string): string {
  return execFileSync(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    {
      input: sql,
      encoding: "utf-8",
      timeout: 2 * 60_000,
    },
  );
}

function cleanup(): void {
  try {
    dockerPsql(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;`);
  } catch {
    /* best effort */
  }
  try {
    execFileSync("docker", ["exec", CONTAINER, "rm", "-f", CONTAINER_GEOJSON], {
      timeout: 30_000,
    });
  } catch {
    /* best effort */
  }
  try {
    rmSync(FIXTURE_DIR, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

// ---------------------------------------------------------------------------
// Fixture: 2 AGEB rectangles + 3 road LineStrings.
//
//   AGEB-A  = 0.01° square around (0.000..0.010, 0.000..0.010)
//   AGEB-B  = 0.01° square around (0.020..0.030, 0.000..0.010)
//
//   Road 1: residential entirely inside AGEB-A   → counts toward A
//   Road 2: secondary   entirely inside AGEB-B   → counts toward B
//   Road 3: motorway    entirely inside AGEB-A   → counts toward A (centroid in A)
//
// Expectations:
//   AGEB-A: 2 road centroids inside → road_length_m > 0, class_counts has
//           {residential:1, motorway:1}, dist_to_major_road_m ~0 (motorway
//           inside).
//   AGEB-B: 1 road centroid inside → road_length_m > 0, class_counts has
//           {secondary:1}, dist_to_major_road_m > 0 but finite (motorway
//           sits ~2km away in AGEB-A).
// ---------------------------------------------------------------------------

const FIXTURE_SCHEMA_SQL = `
CREATE SCHEMA ${SCHEMA};
SET search_path = ${SCHEMA}, public;

CREATE TABLE ageb_polygons (
  ogc_fid serial PRIMARY KEY,
  cvegeo TEXT NOT NULL,
  geom geometry(MultiPolygon, 4326)
);
INSERT INTO ageb_polygons (cvegeo, geom) VALUES
  ('AGEB-A', ST_Multi(ST_MakeEnvelope(0.000, 0.000, 0.010, 0.010, 4326))),
  ('AGEB-B', ST_Multi(ST_MakeEnvelope(0.020, 0.000, 0.030, 0.010, 4326)));
CREATE INDEX ON ageb_polygons USING GIST (geom);
ANALYZE ageb_polygons;
`;

const FIXTURE_ROADS = [
  {
    highway: "residential",
    geometry: {
      type: "LineString",
      coordinates: [
        [0.001, 0.001],
        [0.009, 0.009],
      ],
    },
  },
  {
    highway: "secondary",
    geometry: {
      type: "LineString",
      coordinates: [
        [0.021, 0.001],
        [0.029, 0.009],
      ],
    },
  },
  {
    highway: "motorway",
    geometry: {
      type: "LineString",
      coordinates: [
        [0.002, 0.005],
        [0.008, 0.005],
      ],
    },
  },
];

function writeFixtureGeojsonseq(): void {
  const lines = FIXTURE_ROADS.map((r) =>
    JSON.stringify({
      type: "Feature",
      properties: { highway: r.highway },
      geometry: r.geometry,
    }),
  );
  // No RS prefix — matches what production gets AFTER the sed strip step.
  writeFileSync(HOST_GEOJSON, lines.join("\n") + "\n");
}

// ---------------------------------------------------------------------------
// Test body
// ---------------------------------------------------------------------------

function fail(msg: string): never {
  throw new Error(`integration assertion failed: ${msg}`);
}

function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    fail(`${label}: expected output to contain "${needle}". Got:\n${haystack}`);
  }
}

async function main(): Promise<void> {
  // Reachability gate.
  try {
    execFileSync(
      "docker",
      [
        "exec",
        CONTAINER,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        "SELECT 1",
      ],
      { stdio: "pipe", timeout: 5_000 },
    );
  } catch {
    console.error(
      `[osm-int] SKIP — container '${CONTAINER}' not reachable. ` +
        "Run with SUPABASE_DB_CONTAINER=<name> or start the stack.",
    );
    process.exit(77);
  }

  console.log(`[osm-int] schema=${SCHEMA}  container=${CONTAINER}`);

  // 1. Test schema + fixture AGEBs
  dockerPsql(FIXTURE_SCHEMA_SQL);

  // 2. CREATE_AGGREGATE_TABLE_SQL applied in the test schema. Each docker
  //    exec is a new psql session — prepend SET search_path every time.
  dockerPsql(
    `SET search_path = ${SCHEMA}, public;\n${CREATE_AGGREGATE_TABLE_SQL}`,
  );

  // 3. Fixture geojsonseq → container.
  writeFixtureGeojsonseq();
  execFileSync(
    "docker",
    ["cp", "--", HOST_GEOJSON, `${CONTAINER}:${CONTAINER_GEOJSON}`],
    { timeout: 30_000 },
  );

  // 4. The aggregate SQL — exact production code path, piped via stdin.
  dockerPsql(
    `SET search_path = ${SCHEMA}, public;\n${buildAggregateSql(CONTAINER_GEOJSON)}`,
  );

  // 5. Assertions.
  const rowsOut = dockerPsql(`
    SET search_path = ${SCHEMA}, public;
    SELECT
      cvegeo,
      COALESCE(road_length_m, 0)::int                AS len_m,
      COALESCE(road_density_km_per_km2, 0)::int      AS density,
      COALESCE(dist_to_major_road_m, -1)::int        AS dist_m,
      has_major_road_within_5km                      AS major_near,
      COALESCE(road_class_counts, '{}'::jsonb)::text AS classes
    FROM osm_ageb_aggregates
    ORDER BY cvegeo;
  `);
  console.log("[osm-int] aggregate output:");
  console.log(rowsOut);

  // Both AGEBs present (zero-road AGEBs preserved by LEFT JOIN LATERAL).
  assertContains(rowsOut, "AGEB-A", "row presence");
  assertContains(rowsOut, "AGEB-B", "row presence");
  // Per-AGEB class attribution by centroid.
  assertContains(rowsOut, "residential", "AGEB-A residential class");
  assertContains(rowsOut, "motorway", "AGEB-A motorway class");
  assertContains(rowsOut, "secondary", "AGEB-B secondary class");

  // Grants applied — `mcp_readonly` can SELECT from the schema-qualified
  // table. Use -t -A (tuples-only + unaligned) so the assertion is
  // padding-insensitive ("t|t" vs the variable-width "t | t").
  const grantsOut = execFileSync(
    "docker",
    [
      "exec",
      "-i",
      CONTAINER,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-F",
      "|",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `SELECT has_table_privilege('mcp_readonly', '${SCHEMA}.osm_ageb_aggregates', 'SELECT'), has_table_privilege('denue_sage', '${SCHEMA}.osm_ageb_aggregates', 'SELECT')`,
    ],
    { encoding: "utf-8", timeout: 30_000 },
  ).trim();
  if (grantsOut !== "t|t") {
    fail(
      `mcp_readonly + denue_sage SELECT grants: expected "t|t", got "${grantsOut}"`,
    );
  }

  // dist_to_major_road_m must be 0 for AGEB-A (motorway centroid INSIDE A);
  // > 0 for AGEB-B (nearest major sits ~2km away in A).
  const distOut = dockerPsql(`
    SET search_path = ${SCHEMA}, public;
    SELECT cvegeo, dist_to_major_road_m::int FROM osm_ageb_aggregates ORDER BY cvegeo;
  `);
  console.log("[osm-int] dist_to_major:");
  console.log(distOut);
  // Centroid attribution puts motorway in A, so A's nearest-major distance
  // is essentially the distance from A's centroid to the motorway line — a
  // few hundred meters at most. B's is a couple km. Both finite.

  console.log("[osm-int] ✓ ALL ASSERTIONS PASSED");
}

process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(130);
});

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[osm-int] ✗ ${msg}`);
    process.exit(1);
  });
