import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));
const { mockExists, mockStat } = vi.hoisted(() => ({
  mockExists: vi.fn(),
  mockStat: vi.fn(),
}));
vi.mock("node:fs", () => ({
  existsSync: mockExists,
  statSync: mockStat,
}));

import {
  loadOsmAgeb,
  CREATE_AGGREGATE_TABLE_SQL,
  buildAggregateSql,
} from "./load-osm-ageb.js";

beforeEach(() => {
  mockExec.mockReset();
  mockExists.mockReset();
  mockStat.mockReset();
  mockExists.mockReturnValue(true);
  mockStat.mockReturnValue({ size: 123 });
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Static SQL assertions — guard the shape future loaders must keep.
// ---------------------------------------------------------------------------

describe("CREATE_AGGREGATE_TABLE_SQL", () => {
  it("is idempotent (DROP+CREATE)", () => {
    expect(CREATE_AGGREGATE_TABLE_SQL).toContain(
      "DROP TABLE IF EXISTS osm_ageb_aggregates",
    );
    expect(CREATE_AGGREGATE_TABLE_SQL).toContain(
      "CREATE TABLE osm_ageb_aggregates",
    );
  });

  it("declares cvegeo as PK (no FK; ageb_polygons has PK on ogc_fid, not cvegeo)", () => {
    expect(CREATE_AGGREGATE_TABLE_SQL).toMatch(/cvegeo\s+TEXT PRIMARY KEY/);
    // Explicit non-FK: every other *_ageb consumer joins on cvegeo without
    // a formal FK, matching the warehouse convention.
    expect(CREATE_AGGREGATE_TABLE_SQL).not.toContain(
      "REFERENCES ageb_polygons",
    );
  });

  it("declares all 5 metric columns + loaded_at", () => {
    for (const col of [
      "road_length_m",
      "road_density_km_per_km2",
      "dist_to_major_road_m",
      "has_major_road_within_5km",
      "road_class_counts",
      "loaded_at",
    ]) {
      expect(CREATE_AGGREGATE_TABLE_SQL).toContain(col);
    }
  });

  it("road_class_counts uses JSONB, not TEXT", () => {
    expect(CREATE_AGGREGATE_TABLE_SQL).toMatch(/road_class_counts\s+JSONB/);
  });

  it("grants SELECT to mcp_readonly + denue_sage (idempotent, role-guarded)", () => {
    // Loader runs as 'postgres' which is outside Supabase's default-ACL
    // auto-grant. Without explicit GRANTs Jarvis (mcp_readonly) and Sage
    // (denue_sage) cannot SELECT from the new table.
    expect(CREATE_AGGREGATE_TABLE_SQL).toContain(
      "GRANT SELECT ON osm_ageb_aggregates TO mcp_readonly",
    );
    expect(CREATE_AGGREGATE_TABLE_SQL).toContain(
      "GRANT SELECT ON osm_ageb_aggregates TO denue_sage",
    );
    // Each GRANT must be role-existence-guarded so the loader works on a
    // dev box that doesn't have these roles provisioned.
    expect(CREATE_AGGREGATE_TABLE_SQL).toContain(
      "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly')",
    );
    expect(CREATE_AGGREGATE_TABLE_SQL).toContain(
      "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_sage')",
    );
  });
});

describe("buildAggregateSql", () => {
  const sql = buildAggregateSql("/tmp/osm_roads.geojsonseq");

  it("wraps the work in a single explicit transaction", () => {
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain("COMMIT;");
  });

  it("sets ON_ERROR_STOP so a mid-pipeline failure aborts the txn", () => {
    expect(sql).toContain("\\set ON_ERROR_STOP on");
  });

  it("sets a statement_timeout so a runaway plan is bounded < systemd timeout", () => {
    // Audit W6: 25min < 30min systemd TimeoutStartSec, so PG kills the
    // statement before systemd kills the wrapper.
    expect(sql).toContain("SET statement_timeout = '25min'");
  });

  it("uses TEMPORARY tables (so raw OSM never lands persistently)", () => {
    // Two temp tables: loader (raw JSONB) + staging (parsed geom).
    const tempCreates = (sql.match(/CREATE TEMPORARY TABLE/g) ?? []).length;
    expect(tempCreates).toBeGreaterThanOrEqual(2);
    // Cleanup must be automatic at COMMIT to defend against an explicit
    // DROP step being skipped (e.g. via mid-script error path).
    expect(sql).toContain("ON COMMIT DROP");
  });

  it("\\copy loads the GeoJSONSeq path provided by the caller", () => {
    expect(sql).toContain(
      "\\copy osm_roads_loader (feat) FROM '/tmp/osm_roads.geojsonseq'",
    );
  });

  it("\\copy uses control-byte DELIMITER/QUOTE (audit C1: not 0x1E which collides with RFC 8142 RS prefix)", () => {
    // 0x01 SOH, 0x02 STX — both forbidden in JSON strings by RFC 8259 §7,
    // so they cannot appear inside the feature payload.
    expect(sql).toContain("DELIMITER E'\\x01'");
    expect(sql).toContain("QUOTE E'\\x02'");
    expect(sql).not.toContain("E'\\x1e'");
  });

  it("escapes single quotes in the geojson path (defense in depth)", () => {
    const escaped = buildAggregateSql("/tmp/it's-bad.geojsonseq");
    expect(escaped).toContain("'/tmp/it''s-bad.geojsonseq'");
    expect(escaped).not.toContain("'/tmp/it's-bad.geojsonseq'");
  });

  it("builds a GIST index on staging.geom before the JOIN", () => {
    expect(sql).toContain(
      "CREATE INDEX ON osm_roads_staging USING GIST (geom)",
    );
    // GIST must come before the INSERT that joins on ST_Intersects, or the
    // 80k × 6M cross product runs sequential. Position is load-bearing.
    expect(sql.indexOf("USING GIST")).toBeLessThan(
      sql.indexOf("INSERT INTO osm_ageb_aggregates"),
    );
  });

  it("builds a partial GIST on major-road subset (audit C2)", () => {
    // Without this index, the nearest_major KNN below would fall back to
    // a filtered seq-scan over millions of segments per AGEB.
    expect(sql).toMatch(
      /CREATE INDEX ON osm_roads_staging USING GIST \(geom\)\s+WHERE highway IN \('motorway','trunk','primary'\)/,
    );
  });

  it("nearest_major orders by `geom <-> a.geom` WITHOUT ST_SetSRID wraps (audit C2)", () => {
    // ST_SetSRID-wrapped operands defeat the GIST KNN; both sides are
    // already SRID 4326 at staging-insert time.
    expect(sql).toContain("ORDER BY geom <-> a.geom");
    expect(sql).not.toMatch(/ORDER BY ST_SetSRID\(geom, 4326\) <->/);
  });

  it("uses centroid attribution + ST_Contains (NOT ST_Intersection clip)", () => {
    // Original ST_Intersection-based approach statement_timeout'd at 25min
    // on the full MX dataset. Centroid attribution scales as
    // O(roads × log(AGEBs)) via GIST(pt) instead of O(roads × intersecting
    // AGEBs × polygon-clip cost). Trade-off: long roads spanning multiple
    // AGEBs attribute fully to whichever AGEB owns the midpoint.
    expect(sql).toContain("ST_Centroid(geom)");
    expect(sql).toContain("ST_Contains(a.geom, rc.pt)");
    expect(sql).toContain(
      "CREATE INDEX ON osm_roads_centroids USING GIST (pt)",
    );
    expect(sql).toContain("ST_Length(geom::geography)");
    expect(sql).toContain("ST_Area(a.geom::geography)");
    // No polygon-clip step anywhere
    expect(sql).not.toContain("ST_Intersection(");
  });

  it("computes density km_per_km2 with explicit divide-by-zero guard", () => {
    expect(sql).toContain("WHEN ar.ageb_area_m2 > 0");
    expect(sql).toMatch(/road_density_km_per_km2/);
  });

  it("scopes major-road distance to motorway/trunk/primary only", () => {
    expect(sql).toContain("ARRAY['motorway','trunk','primary']");
  });

  it("filters NULL highway/geometry rows out of staging", () => {
    expect(sql).toContain("WHERE feat->'properties' ? 'highway'");
    expect(sql).toContain("AND feat->>'geometry' IS NOT NULL");
  });

  it("LEFT JOIN LATERAL preserves AGEBs with zero road centroids inside", () => {
    expect(sql).toContain("LEFT JOIN LATERAL");
    expect(sql).toContain("COALESCE(SUM(rc.road_len_m), 0)");
  });
});

// ---------------------------------------------------------------------------
// loadOsmAgeb orchestration — argument-safety + per-step shape.
// ---------------------------------------------------------------------------

describe("loadOsmAgeb (orchestration)", () => {
  it("rejects malformed dbContainer (anti docker-flag injection)", async () => {
    for (const bad of ["--rm", "", "-evil", "supabase db", "../etc"]) {
      await expect(
        loadOsmAgeb({
          pbfPath: "/p.pbf",
          workDir: "/w",
          dbContainer: bad,
        }),
      ).rejects.toThrow(/dbContainer inválido/);
    }
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("rejects pbfPath / workDir / osmiumBin beginning with '-'", async () => {
    await expect(
      loadOsmAgeb({
        pbfPath: "--rm",
        workDir: "/w",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/pbfPath inválido/);
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/workDir inválido/);
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
        osmiumBin: "--exec",
      }),
    ).rejects.toThrow(/osmiumBin inválido/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("runs the 8 expected execFileSync calls in order on the happy path", async () => {
    // Returns "80000\n" for the final SELECT COUNT(*).
    mockExec.mockReturnValue("80000\n");
    const r = await loadOsmAgeb({
      pbfPath: "/p.pbf",
      workDir: "/w",
      dbContainer: "supabase-db",
    });
    // Step 1: osmium tags-filter
    expect(mockExec.mock.calls[0]![0]).toBe("osmium");
    expect(mockExec.mock.calls[0]![1]).toContain("tags-filter");
    expect(mockExec.mock.calls[0]![1]).toContain("w/highway");
    // Step 2: osmium export
    expect(mockExec.mock.calls[1]![0]).toBe("osmium");
    expect(mockExec.mock.calls[1]![1]).toContain("export");
    expect(mockExec.mock.calls[1]![1]).toContain("--output-format=geojsonseq");
    expect(mockExec.mock.calls[1]![1]).toContain("--geometry-types=linestring");
    // Step 2b: sed -i to strip RFC 8142 RS prefix (audit C1)
    expect(mockExec.mock.calls[2]![0]).toBe("sed");
    expect(mockExec.mock.calls[2]![1]).toContain("-i");
    expect(mockExec.mock.calls[2]![1]).toContain("s/\\x1e//g");
    // Step 3: docker exec psql -c CREATE_AGGREGATE_TABLE_SQL
    expect(mockExec.mock.calls[3]![0]).toBe("docker");
    expect(mockExec.mock.calls[3]![1]?.join(" ")).toContain(
      "osm_ageb_aggregates",
    );
    // Step 4: docker cp
    expect(mockExec.mock.calls[4]![0]).toBe("docker");
    expect(mockExec.mock.calls[4]![1]).toContain("cp");
    expect(mockExec.mock.calls[4]![1]).toContain("--");
    // Step 5: docker exec psql with aggregate SQL via STDIN (3rd arg `input`).
    // Cannot pass via `-c` — psql's -c rejects multi-statement scripts that
    // mix SQL with the `\copy` meta-command (verified against psql 17).
    expect(mockExec.mock.calls[5]![0]).toBe("docker");
    expect(mockExec.mock.calls[5]![1]?.join(" ")).not.toContain(
      "INSERT INTO osm_ageb_aggregates",
    );
    expect(mockExec.mock.calls[5]![1]).not.toContain("-c");
    const aggregateOpts = mockExec.mock.calls[5]![2] as
      | { input?: string }
      | undefined;
    expect(aggregateOpts?.input).toContain("INSERT INTO osm_ageb_aggregates");
    expect(aggregateOpts?.input).toContain(
      "\\copy osm_roads_loader (feat) FROM",
    );
    // Step 6: docker exec rm -f (cleanup, in finally)
    expect(mockExec.mock.calls[6]![0]).toBe("docker");
    expect(mockExec.mock.calls[6]![1]).toContain("rm");
    // Step 7: docker exec psql -t -A -c COUNT
    expect(mockExec.mock.calls[7]![1]?.join(" ")).toContain(
      "SELECT COUNT(*) FROM osm_ageb_aggregates",
    );
    expect(r.ageb_rows_loaded).toBe(80000);
  });

  it("docker cp uses `--` separator before user paths (anti flag-injection)", async () => {
    mockExec.mockReturnValue("0\n");
    await loadOsmAgeb({
      pbfPath: "/p.pbf",
      workDir: "/w",
      dbContainer: "supabase-db",
    });
    const cpCall = mockExec.mock.calls.find(
      (c) => c[0] === "docker" && Array.isArray(c[1]) && c[1][0] === "cp",
    );
    expect(cpCall).toBeDefined();
    const args = cpCall![1] as string[];
    const dashIdx = args.indexOf("--");
    const srcIdx = args.findIndex((a) => a === "/w/mexico-roads.geojsonseq");
    expect(dashIdx).toBeGreaterThan(-1);
    expect(srcIdx).toBeGreaterThan(dashIdx);
  });

  it("attempts cleanup of container-side geojson even when aggregate fails (audit W5: also covers docker-cp failure)", async () => {
    mockExec
      .mockReturnValueOnce("") // 1: osmium tags-filter
      .mockReturnValueOnce("") // 2: osmium export
      .mockReturnValueOnce("") // 2b: sed strip
      .mockReturnValueOnce("") // 3: CREATE TABLE
      .mockReturnValueOnce("") // 4: docker cp
      .mockImplementationOnce(() => {
        // 5: AGGREGATE psql throws
        throw new Error("psql: aggregate failed");
      })
      .mockReturnValueOnce(""); // 6: cleanup rm (must still fire)
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/aggregate failed/);
    // Final call must be the cleanup rm -f.
    const last = mockExec.mock.calls[mockExec.mock.calls.length - 1]!;
    expect(last[0]).toBe("docker");
    expect(last[1]).toContain("rm");
  });

  it("rejects on non-numeric count output", async () => {
    mockExec.mockReturnValue("oh no\n");
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/unexpected count output/);
  });

  it("attempts cleanup even when docker cp itself fails (audit W5)", async () => {
    mockExec
      .mockReturnValueOnce("") // 1: osmium tags-filter
      .mockReturnValueOnce("") // 2: osmium export
      .mockReturnValueOnce("") // 2b: sed strip
      .mockReturnValueOnce("") // 3: CREATE TABLE
      .mockImplementationOnce(() => {
        // 4: docker cp throws BEFORE aggregate even starts
        throw new Error("docker cp: copy denied");
      })
      .mockReturnValueOnce(""); // 5: cleanup rm — must still fire
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/copy denied/);
    const last = mockExec.mock.calls[mockExec.mock.calls.length - 1]!;
    expect(last[0]).toBe("docker");
    expect(last[1]).toContain("rm");
  });

  it("honors a custom osmium binary path", async () => {
    mockExec.mockReturnValue("0\n");
    await loadOsmAgeb({
      pbfPath: "/p.pbf",
      workDir: "/w",
      dbContainer: "supabase-db",
      osmiumBin: "/opt/vendor/osmium",
    });
    expect(mockExec.mock.calls[0]![0]).toBe("/opt/vendor/osmium");
    expect(mockExec.mock.calls[1]![0]).toBe("/opt/vendor/osmium");
  });
});
