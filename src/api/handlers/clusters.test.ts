import { describe, it, expect, vi, afterEach } from "vitest";

// vi.mock is hoisted above all imports, including the const declaration.
// Use vi.hoisted to define the mock before the hoisted vi.mock factory runs.
//
// Audit C1-sec round-1 closure 2026-05-10: cluster-by-sector.ts switched
// from execSync (raw shell) to execFileSync (array-arg form). Mock now
// targets execFileSync to match.
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  execFileSync: mockExec,
  execFile: vi.fn(),
}));

// Now safe to import the server (which transitively imports the cluster runner)
import { createServer } from "../server.js";
import type { ApiServerConfig } from "../types.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};
const AUTH = { "X-Api-Key": "key" };

afterEach(() => {
  mockExec.mockReset();
  vi.restoreAllMocks();
});

describe("GET /clusters", () => {
  it("returns 200 + clusters payload on happy path", async () => {
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
    const app = createServer(CONFIG);
    const res = await app.request("/clusters?entidad=09&scian=46&k=5", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entidad: string;
      scian: string;
      k: number;
      clusters: Array<{ member_count: number }>;
    };
    expect(body.entidad).toBe("09");
    expect(body.scian).toBe("46");
    expect(body.k).toBe(5);
    expect(body.clusters).toHaveLength(1);
    expect(body.clusters[0]?.member_count).toBe(12);
  });

  it("uses default k=5 when not specified", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    const res = await app.request("/clusters?entidad=06&scian=62", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    // Audit C1-sec round-1 closure 2026-05-10: SQL is now passed as the
    // last array element to execFileSync, not as a shell-string.
    const args = mockExec.mock.calls[0]?.[1] as string[] | undefined;
    const sql = args?.[args.length - 1] ?? "";
    expect(sql).toContain("ST_ClusterKMeans(geom, 5)");
  });

  it("returns 400 on missing entidad", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/clusters?scian=46", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.entidad");
  });

  it("returns 400 on invalid scian", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/clusters?entidad=09&scian=xyz", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.scian");
  });

  it("returns 400 on k out of range", async () => {
    const app = createServer(CONFIG);
    const r1 = await app.request("/clusters?entidad=09&scian=46&k=0", {
      headers: AUTH,
    });
    expect(r1.status).toBe(400);
    const r2 = await app.request("/clusters?entidad=09&scian=46&k=200", {
      headers: AUTH,
    });
    expect(r2.status).toBe(400);
  });
});
