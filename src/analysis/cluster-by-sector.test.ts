import {
  describe,
  it,
  expect,
  vi,
  afterEach,
  beforeEach,
  type Mock,
} from "vitest";
// clusterBySector imported dynamically per-test below so vi.doMock("node:child_process")
// applies fresh mocks to each invocation; static-imported binding bypasses doMock.
import { formatClusters } from "./cluster-by-sector.js";

const BASE_CONFIG = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-key",
  dbContainer: "test-supabase-db",
};

let mockExec: Mock;

beforeEach(() => {
  mockExec = vi.fn();
  // Audit P08: cluster-by-sector.ts runs on the shared psql runner (async
  // spawn, SQL on stdin). The bridge routes each call into mockExec with the
  // SQL appended as the last recorded arg.
  vi.doMock("node:child_process", async () =>
    (await import("../api/db/psql-bridge.test-helper.js")).psqlChildProcessMock(
      mockExec,
    ),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("clusterBySector — input validation", () => {
  it("throws on invalid entidad (not 2 digits 01-32)", async () => {
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");
    await expect(
      cbs(BASE_CONFIG, { entidad: "33", scianPrefix: "46", k: 5 }),
    ).rejects.toThrow(/entidad inválida/);
    await expect(
      cbs(BASE_CONFIG, { entidad: "9", scianPrefix: "46", k: 5 }),
    ).rejects.toThrow(/entidad inválida/);
    await expect(
      cbs(BASE_CONFIG, { entidad: "AB", scianPrefix: "46", k: 5 }),
    ).rejects.toThrow(/entidad inválida/);
  });

  it("throws on invalid scianPrefix (not 2 digits)", async () => {
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");
    await expect(
      cbs(BASE_CONFIG, { entidad: "09", scianPrefix: "4", k: 5 }),
    ).rejects.toThrow(/scianPrefix inválido/);
    await expect(
      cbs(BASE_CONFIG, { entidad: "09", scianPrefix: "ab", k: 5 }),
    ).rejects.toThrow(/scianPrefix inválido/);
  });

  it("throws on invalid k (zero, negative, non-integer, >100)", async () => {
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");
    await expect(
      cbs(BASE_CONFIG, { entidad: "09", scianPrefix: "46", k: 0 }),
    ).rejects.toThrow(/k inválido/);
    await expect(
      cbs(BASE_CONFIG, { entidad: "09", scianPrefix: "46", k: 1.5 }),
    ).rejects.toThrow(/k inválido/);
    await expect(
      cbs(BASE_CONFIG, { entidad: "09", scianPrefix: "46", k: 101 }),
    ).rejects.toThrow(/k inválido/);
  });
});

describe("clusterBySector — psql interaction", () => {
  it("invokes docker exec with the configured container, parses JSON output", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        {
          cluster_id: 0,
          lon: -99.1332,
          lat: 19.4326,
          size: 12,
        },
      ]),
    );
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");

    const result = await cbs(BASE_CONFIG, {
      entidad: "09",
      scianPrefix: "46",
      k: 5,
    });

    expect(mockExec).toHaveBeenCalledOnce();
    // spawn(file, args): file is "docker", args carries the container,
    // args[-1] is the stdin SQL (appended by the bridge).
    const file = mockExec.mock.calls[0]?.[0] as string;
    const args = mockExec.mock.calls[0]?.[1] as string[];
    expect(file).toBe("docker");
    expect(args[0]).toBe("exec");
    expect(args).toContain("test-supabase-db");
    expect(args).toContain("psql");
    const sql = args[args.length - 1] ?? "";
    expect(sql).toContain("ST_ClusterKMeans");
    expect(sql).toContain("entidad = '09'");
    expect(sql).toContain("sector_actividad_id = '46'");
    expect(sql).not.toContain("SUBSTR(clee");

    expect(result).toHaveLength(1);
    expect(result[0]?.size).toBe(12);
    expect(result[0]?.lat).toBe(19.4326);
    expect(result[0]?.lon).toBe(-99.1332);
  });

  it("returns centroids + size only, clustered on EPSG:6372 (audit #34/#101/#56)", async () => {
    mockExec.mockReturnValue("[]");
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");
    await cbs(BASE_CONFIG, { entidad: "15", scianPrefix: "46", k: 10 });
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const sql = args[args.length - 1] ?? "";
    // Old SQL: ST_ClusterKMeans(geom, k) on raw degrees + ARRAY_AGG of
    // every member CLEE (12 MB for entidad=15/sector=46).
    expect(sql).toContain("ST_ClusterKMeans(ST_Transform(geom, 6372), 10)");
    expect(sql).not.toMatch(/ARRAY_AGG/i);
    expect(sql).not.toContain("member_clees");
    expect(sql).toContain("ST_Centroid(ST_Collect(geom))");
    expect(sql).toMatch(/AS lon\b/);
    expect(sql).toMatch(/AS lat\b/);
    expect(sql).toMatch(/COUNT\(\*\)::int AS size\b/);
  });

  it("returns [] when psql returns empty / null (no records match)", async () => {
    mockExec.mockReturnValue("");
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");
    expect(
      await cbs(BASE_CONFIG, { entidad: "06", scianPrefix: "62", k: 3 }),
    ).toEqual([]);

    mockExec.mockReturnValue("null");
    expect(
      await cbs(BASE_CONFIG, { entidad: "06", scianPrefix: "62", k: 3 }),
    ).toEqual([]);
  });

  it("uses default container 'supabase-db' when none configured", async () => {
    mockExec.mockReturnValue("[]");
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");
    await cbs(
      { supabaseUrl: "http://localhost:8100", serviceRoleKey: "k" },
      { entidad: "06", scianPrefix: "62", k: 3 },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[];
    expect(args).toContain("supabase-db");
  });

  it("statement_timeout=50s reaches the container via docker exec -e (audit #94/#130)", async () => {
    mockExec.mockReturnValue("[]");
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");
    await cbs(BASE_CONFIG, { entidad: "06", scianPrefix: "62", k: 3 });
    // Old code set PGOPTIONS in the host env (never forwarded by docker
    // exec) and had no -e flag.
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const i = args.indexOf("-e");
    expect(i).toBeGreaterThan(0);
    expect(args[i + 1]).toMatch(/^PGOPTIONS=.*statement_timeout=50000/);
  });

  it("psql failure rejects with a 502 postgres.error HttpError (audit #54)", async () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error("boom"), { stderr: "ERROR: canceling" });
    });
    const { clusterBySector: cbs } = await import("./cluster-by-sector.js");
    await expect(
      cbs(BASE_CONFIG, { entidad: "06", scianPrefix: "62", k: 3 }),
    ).rejects.toMatchObject({ status: 502, code: "postgres.error" });
  });
});

describe("formatClusters", () => {
  it("renders header + rows with padded centroids", () => {
    const out = formatClusters([
      {
        cluster_id: 0,
        lon: -99.654321,
        lat: 19.123456,
        size: 42,
      },
    ]);
    expect(out).toContain("Members");
    expect(out).toContain("19.123456");
    expect(out).toContain("-99.654321");
    expect(out).toContain("42");
  });

  it("returns explanatory message when given empty cluster list", () => {
    const out = formatClusters([]);
    expect(out).toContain("sin clusters");
  });
});
