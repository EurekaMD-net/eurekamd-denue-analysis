import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
// clusterBySector imported dynamically per-test below so vi.doMock("node:child_process")
// applies fresh mocks to each invocation; static-imported binding bypasses doMock.
import { formatClusters } from "./cluster-by-sector.js";

const BASE_CONFIG = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-key",
  dbContainer: "test-supabase-db",
};

let mockExec: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockExec = vi.fn();
  // Audit C1-sec round-1 closure 2026-05-10: cluster-by-sector.ts switched
  // from execSync (raw shell) to execFileSync (array-arg form).
  vi.doMock("node:child_process", () => ({
    execSync: vi.fn(),
    execFileSync: mockExec,
  }));
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
          centroid_lat: 19.4326,
          centroid_lon: -99.1332,
          member_count: 12,
          member_clees: ["09001", "09002"],
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
    // execFileSync(file, args, opts): file is "docker", args[1] is the
    // container, args[-1] is the SQL string.
    const file = mockExec.mock.calls[0]?.[0] as string;
    const args = mockExec.mock.calls[0]?.[1] as string[];
    expect(file).toBe("docker");
    expect(args[0]).toBe("exec");
    expect(args[1]).toBe("test-supabase-db");
    expect(args).toContain("psql");
    const sql = args[args.length - 1] ?? "";
    expect(sql).toContain("ST_ClusterKMeans");
    expect(sql).toContain("entidad = '09'");
    expect(sql).toContain("sector_actividad_id = '46'");
    expect(sql).not.toContain("SUBSTR(clee");

    expect(result).toHaveLength(1);
    expect(result[0]?.member_count).toBe(12);
    expect(result[0]?.centroid_lat).toBe(19.4326);
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
    expect(args[1]).toBe("supabase-db");
  });
});

describe("formatClusters", () => {
  it("renders header + rows with padded centroids", () => {
    const out = formatClusters([
      {
        cluster_id: 0,
        centroid_lat: 19.123456,
        centroid_lon: -99.654321,
        member_count: 42,
        member_clees: [],
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
