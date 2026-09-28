import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));
const { mockExists, mockStat, mockRm, mockWrite, mockMarker } = vi.hoisted(
  () => ({
    mockExists: vi.fn(),
    mockStat: vi.fn(),
    mockRm: vi.fn(),
    mockWrite: vi.fn(),
    // Contents of `<geojsonseq>.done`; every other read stays real.
    mockMarker: { value: "" },
  }),
);
// Keep the real readFileSync: _psql-tx reads sage-role.sql for the grants.
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    existsSync: mockExists,
    statSync: mockStat,
    rmSync: mockRm,
    writeFileSync: mockWrite,
    readFileSync: ((p: string, ...rest: unknown[]) =>
      String(p).endsWith(".done")
        ? mockMarker.value
        : (real.readFileSync as (...a: unknown[]) => unknown)(
            p,
            ...rest,
          )) as typeof real.readFileSync,
  };
});

import {
  loadOsmAgeb,
  aggregateTableDdl,
  buildAggregateSql,
} from "./load-osm-ageb.js";

// The May 24 PBF's real identity: 625,715,444 B, mtime 2026-05-24 18:20:56.272 UTC.
const PBF_STAT = { size: 625715444, mtimeMs: 1779646856272.0781 };
const PBF_MARKER = "size=625715444 mtimeMs=1779646856272";

beforeEach(() => {
  mockExec.mockReset();
  mockExists.mockReset();
  mockStat.mockReset();
  mockRm.mockReset();
  mockWrite.mockReset();
  mockMarker.value = "";
  mockExists.mockReturnValue(true);
  mockStat.mockReturnValue({ size: 123 });
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// Static SQL assertions — guard the shape future loaders must keep.
// ---------------------------------------------------------------------------

describe("aggregateTableDdl", () => {
  const liveDdl = aggregateTableDdl("public", "osm_ageb_aggregates");

  it("is exactly the staging DDL buildAggregateSql embeds", () => {
    expect(buildAggregateSql("/tmp/x.geojsonseq")).toContain(
      aggregateTableDdl("public", "osm_ageb_aggregates_staging"),
    );
  });

  it("is idempotent (DROP+CREATE)", () => {
    expect(liveDdl).toContain(
      "DROP TABLE IF EXISTS public.osm_ageb_aggregates",
    );
    expect(liveDdl).toContain("CREATE TABLE public.osm_ageb_aggregates");
  });

  it("declares cvegeo as PK (no FK; ageb_polygons has PK on ogc_fid, not cvegeo)", () => {
    expect(liveDdl).toMatch(/cvegeo\s+TEXT PRIMARY KEY/);
    // Explicit non-FK: every other *_ageb consumer joins on cvegeo without
    // a formal FK, matching the warehouse convention.
    expect(liveDdl).not.toContain("REFERENCES ageb_polygons");
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
      expect(liveDdl).toContain(col);
    }
  });

  it("road_class_counts uses JSONB, not TEXT", () => {
    expect(liveDdl).toMatch(/road_class_counts\s+JSONB/);
  });

  it("grants SELECT to mcp_readonly + denue_sage (idempotent, role-guarded)", () => {
    // Loader runs as 'postgres' which is outside Supabase's default-ACL
    // auto-grant. Without explicit GRANTs Jarvis (mcp_readonly) and Sage
    // (denue_sage) cannot SELECT from the new table.
    expect(liveDdl).toContain(
      "GRANT SELECT ON public.osm_ageb_aggregates TO mcp_readonly",
    );
    expect(liveDdl).toContain(
      "GRANT SELECT ON public.osm_ageb_aggregates TO denue_sage",
    );
    // Each GRANT must be role-existence-guarded so the loader works on a
    // dev box that doesn't have these roles provisioned.
    expect(liveDdl).toContain(
      "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mcp_readonly')",
    );
    expect(liveDdl).toContain(
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

  it("builds into a staging table and swaps it in before COMMIT (audit #145)", () => {
    const begin = sql.indexOf("BEGIN;");
    const createStaging = sql.indexOf("CREATE TABLE public.osm_ageb_aggregates_staging (");
    const insert = sql.indexOf(
      "INSERT INTO public.osm_ageb_aggregates_staging (",
    );
    const dropLive = sql.indexOf(
      "DROP TABLE IF EXISTS public.osm_ageb_aggregates;",
    );
    const rename = sql.indexOf(
      "ALTER TABLE public.osm_ageb_aggregates_staging RENAME TO osm_ageb_aggregates;",
    );
    const pkey = sql.indexOf(
      "ALTER INDEX public.osm_ageb_aggregates_staging_pkey RENAME TO osm_ageb_aggregates_pkey;",
    );
    const grants = sql.indexOf(
      "REVOKE ALL ON public.osm_ageb_aggregates FROM anon, authenticated, trustr_app;",
    );
    const commit = sql.lastIndexOf("COMMIT;");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(createStaging);
    expect(createStaging).toBeLessThan(insert);
    expect(insert).toBeLessThan(dropLive);
    expect(dropLive).toBeLessThan(rename);
    expect(rename).toBeLessThan(pkey);
    expect(pkey).toBeLessThan(grants);
    expect(grants).toBeLessThan(commit);
    // The live table is never emptied before the new rows exist.
    expect(sql).not.toMatch(/INSERT INTO (public\.)?osm_ageb_aggregates \(/);
    // Staging carries the same role-guarded consumer grants (they follow the
    // table through the RENAME).
    expect(sql).toContain(
      "GRANT SELECT ON public.osm_ageb_aggregates_staging TO mcp_readonly",
    );
    expect(sql).toContain(
      "GRANT SELECT ON public.osm_ageb_aggregates TO denue_sage;",
    );
  });

  it("qualifies every persistent relation with the given schema (search_path cannot redirect a DROP)", () => {
    const scratch = buildAggregateSql("/tmp/x.geojsonseq", "osm_int_1");
    // Every DROP / CREATE TABLE / ALTER / INSERT / GRANT / REVOKE / COMMENT
    // and every FROM ageb_polygons names the scratch schema explicitly.
    const stmts = scratch.match(
      /^\s*(DROP TABLE|CREATE TABLE|ALTER TABLE|ALTER INDEX|INSERT INTO|REVOKE ALL ON|GRANT SELECT ON|COMMENT ON TABLE|COMMENT ON COLUMN)\s+(IF EXISTS\s+)?\S+/gm,
    )!;
    expect(stmts.length).toBeGreaterThanOrEqual(10);
    for (const st of stmts) expect(st).toMatch(/\sosm_int_1\./);
    expect(scratch).toContain(
      "DROP TABLE IF EXISTS osm_int_1.osm_ageb_aggregates;",
    );
    expect(scratch).toContain(
      "ALTER TABLE osm_int_1.osm_ageb_aggregates_staging RENAME TO osm_ageb_aggregates;",
    );
    expect(scratch).toContain(
      "ALTER INDEX osm_int_1.osm_ageb_aggregates_staging_pkey RENAME TO osm_ageb_aggregates_pkey;",
    );
    expect(scratch).not.toContain("public.");
    expect(scratch).not.toMatch(/FROM ageb_polygons/);
    // The only unqualified CREATEs are session-scoped TEMPORARY tables.
    expect(scratch.match(/CREATE (TEMPORARY )?TABLE \w+ /g) ?? []).toEqual([
      "CREATE TEMPORARY TABLE osm_roads_loader ",
      "CREATE TEMPORARY TABLE osm_roads_staging ",
      "CREATE TEMPORARY TABLE osm_roads_centroids ",
    ]);
    expect(() => buildAggregateSql("/tmp/x", "public; DROP")).toThrow(
      /schema inválido/,
    );
  });

  it("sets ON_ERROR_STOP so a mid-pipeline failure aborts the txn", () => {
    expect(sql).toContain("\\set ON_ERROR_STOP on");
  });

  it("sets a statement_timeout so a runaway plan is bounded < systemd timeout", () => {
    // Audit W6: 25min < 30min systemd TimeoutStartSec, so PG kills the
    // statement before systemd kills the wrapper.
    expect(sql).toContain("SET statement_timeout = '25min'");
  });

  it("disables parallel query + parallel index builds before BEGIN (64 MB /dev/shm)", () => {
    const begin = sql.indexOf("BEGIN;");
    expect(
      sql.indexOf("SET max_parallel_workers_per_gather = 0;"),
    ).toBeGreaterThan(-1);
    expect(
      sql.indexOf("SET max_parallel_workers_per_gather = 0;"),
    ).toBeLessThan(begin);
    expect(
      sql.indexOf("SET max_parallel_maintenance_workers = 0;"),
    ).toBeGreaterThan(-1);
    expect(
      sql.indexOf("SET max_parallel_maintenance_workers = 0;"),
    ).toBeLessThan(begin);
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
      sql.indexOf("INSERT INTO public.osm_ageb_aggregates"),
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

  it("runs the 7 expected execFileSync calls in order on the happy path", async () => {
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
    // Audit #145: no separate DROP+CREATE session — the table DDL lives in
    // the aggregate's own transaction.
    expect(
      mockExec.mock.calls.some((c) =>
        (c[1] as string[]).some((a) => a.includes("CREATE TABLE")),
      ),
    ).toBe(false);
    // Step 3: docker cp
    expect(mockExec.mock.calls[3]![0]).toBe("docker");
    expect(mockExec.mock.calls[3]![1]).toContain("cp");
    expect(mockExec.mock.calls[3]![1]).toContain("--");
    // Step 4: docker exec psql with aggregate SQL via STDIN (3rd arg `input`).
    // Cannot pass via `-c` — psql's -c rejects multi-statement scripts that
    // mix SQL with the `\copy` meta-command (verified against psql 17).
    expect(mockExec.mock.calls[4]![0]).toBe("docker");
    expect(mockExec.mock.calls[4]![1]?.join(" ")).not.toContain(
      "INSERT INTO osm_ageb_aggregates",
    );
    expect(mockExec.mock.calls[4]![1]).not.toContain("-c");
    const aggregateOpts = mockExec.mock.calls[4]![2] as
      | { input?: string }
      | undefined;
    expect(aggregateOpts?.input).toBe(
      buildAggregateSql("/tmp/osm_roads.geojsonseq"),
    );
    expect(aggregateOpts?.input).toContain(
      "\\copy osm_roads_loader (feat) FROM",
    );
    // Step 5: docker exec rm -f (cleanup, in finally)
    expect(mockExec.mock.calls[5]![0]).toBe("docker");
    expect(mockExec.mock.calls[5]![1]).toContain("rm");
    // Step 6: docker exec psql -t -A -c COUNT
    expect(mockExec.mock.calls[6]![1]?.join(" ")).toContain(
      "SELECT COUNT(*) FROM public.osm_ageb_aggregates;",
    );
    expect(r.ageb_rows_loaded).toBe(80000);
    // Audit #151: sizes are measured first, then the ~2.2 GB of host-side
    // intermediates are deleted after the successful load.
    expect(r.geojson_bytes).toBe(123);
    // Marker: a stale one is dropped before the export, a fresh one written
    // after it; the successful load then removes it with the intermediates.
    expect(mockRm.mock.calls.map((c) => c[0])).toEqual([
      "/w/mexico-roads.geojsonseq.done",
      "/w/mexico-roads.osm.pbf",
      "/w/mexico-roads.geojsonseq",
      "/w/mexico-roads.geojsonseq.done",
    ]);
  });

  it("writes the export marker with the PBF identity only after osmium export returns", async () => {
    mockStat.mockReturnValue(PBF_STAT);
    const order: string[] = [];
    mockExec.mockImplementation((bin: string, args: string[]) => {
      order.push(`${bin} ${args[0]}`);
      return "80000\n";
    });
    mockWrite.mockImplementation((p: string) => order.push(`write ${p}`));
    await loadOsmAgeb({
      pbfPath: "/p.pbf",
      workDir: "/w",
      dbContainer: "supabase-db",
    });
    expect(mockWrite).toHaveBeenCalledWith(
      "/w/mexico-roads.geojsonseq.done",
      `${PBF_MARKER}\n`,
    );
    expect(order.slice(0, 4)).toEqual([
      "osmium tags-filter",
      "osmium export",
      "write /w/mexico-roads.geojsonseq.done",
      "sed -i",
    ]);
  });

  it("leaves no marker when osmium export fails", async () => {
    mockExec
      .mockReturnValueOnce("") // tags-filter
      .mockImplementationOnce(() => {
        throw new Error("osmium export: killed");
      });
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/killed/);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockRm.mock.calls.map((c) => c[0])).toEqual([
      "/w/mexico-roads.geojsonseq.done",
    ]);
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
      .mockReturnValueOnce("") // 3: docker cp
      .mockImplementationOnce(() => {
        // 4: AGGREGATE psql throws
        throw new Error("psql: aggregate failed");
      })
      .mockReturnValueOnce(""); // 5: cleanup rm (must still fire)
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
      }),
    ).rejects.toThrow(/aggregate failed/);
    // A failed load keeps the host intermediates (and the fresh export
    // marker) for debugging; only the pre-export stale-marker drop ran.
    expect(mockRm.mock.calls.map((c) => c[0])).toEqual([
      "/w/mexico-roads.geojsonseq.done",
    ]);
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
      .mockImplementationOnce(() => {
        // 3: docker cp throws BEFORE aggregate even starts
        throw new Error("docker cp: copy denied");
      })
      .mockReturnValueOnce(""); // 4: cleanup rm — must still fire
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

  it("--reuse-export skips osmium and loads the existing GeoJSONSeq when the marker matches the PBF", async () => {
    mockStat.mockReturnValue(PBF_STAT);
    mockMarker.value = `${PBF_MARKER}\n`;
    mockExec.mockReturnValue("80000\n");
    const r = await loadOsmAgeb({
      pbfPath: "/p.pbf",
      workDir: "/w",
      dbContainer: "supabase-db",
      reuseExport: true,
    });
    expect(mockExec.mock.calls.some((c) => c[0] === "osmium")).toBe(false);
    expect(mockWrite).not.toHaveBeenCalled();
    // sed strip still runs first (idempotent), then docker cp of the reused file.
    expect(mockExec.mock.calls[0]![0]).toBe("sed");
    expect(mockExec.mock.calls[0]![1]).toContain("/w/mexico-roads.geojsonseq");
    expect(mockExec.mock.calls[1]![1]).toContain("cp");
    expect(mockExec.mock.calls[1]![1]).toContain("/w/mexico-roads.geojsonseq");
    expect(r.ageb_rows_loaded).toBe(80000);
  });

  it("--reuse-export dies naming the marker when it is absent", async () => {
    mockStat.mockReturnValue(PBF_STAT);
    mockExists.mockImplementation((p: string) => !p.endsWith(".done"));
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
        reuseExport: true,
      }),
    ).rejects.toThrow(/mexico-roads\.geojsonseq\.done.*marcador=ausente/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("--reuse-export dies naming the marker when it records a different PBF", async () => {
    mockStat.mockReturnValue(PBF_STAT);
    mockMarker.value = "size=625715444 mtimeMs=1779646856000\n";
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
        reuseExport: true,
      }),
    ).rejects.toThrow(
      /mexico-roads\.geojsonseq\.done.*marcador="size=625715444 mtimeMs=1779646856000"/,
    );
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("--reuse-export dies when the marker matches but the GeoJSONSeq is gone", async () => {
    mockStat.mockReturnValue(PBF_STAT);
    mockMarker.value = PBF_MARKER;
    mockExists.mockImplementation((p: string) => p.endsWith(".done"));
    await expect(
      loadOsmAgeb({
        pbfPath: "/p.pbf",
        workDir: "/w",
        dbContainer: "supabase-db",
        reuseExport: true,
      }),
    ).rejects.toThrow(/--reuse-export requiere/);
    expect(mockExec).not.toHaveBeenCalled();
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
