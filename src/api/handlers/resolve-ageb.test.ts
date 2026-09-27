import { describe, it, expect, vi, afterEach } from "vitest";

// vi.mock is hoisted above all imports — define the mock via vi.hoisted so
// the factory can reference it (same bridge as sibling handler tests).
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", async () =>
  (await import("../db/psql-bridge.test-helper.js")).psqlChildProcessMock(
    mockExec,
  ),
);

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

describe("GET /resolve/ageb", () => {
  it("resolves an urban point to cvegeo + cve_mun", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        { cvegeo: "0901500010348", ambito: "Urbana", cve_mun: "09015" },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/resolve/ageb?lat=19.4326&lon=-99.1332", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      lat: 19.4326,
      lon: -99.1332,
      cvegeo: "0901500010348",
      ambito: "Urbana",
      cve_mun: "09015",
    });
    // point goes into ST_MakePoint as (lon, lat) — pin the order
    const sql = mockExec.mock.calls[0]![1].at(-1) as string;
    expect(sql).toContain("ST_MakePoint(-99.1332, 19.4326)");
    // #71: boundary points must resolve (ST_Contains excludes the boundary)
    // and the pick between two touching AGEBs must be deterministic.
    expect(sql).toContain("ST_Intersects(geom, ST_SetSRID(ST_MakePoint(");
    expect(sql).not.toContain("ST_Contains");
    expect(sql).toMatch(/ORDER BY cvegeo\s+LIMIT 1/);
    // #26: the URL carries the caller's geocode — never shared-cacheable.
    expect(res.headers.get("Cache-Control")).toBe("private, max-age=86400");
    expect(res.headers.get("Vary")).toBe("Authorization, X-Api-Key");
  });

  it("passes rural 9-char cvegeos through and preserves ambito", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        { cvegeo: "300280017", ambito: "Rural", cve_mun: "30028" },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/resolve/ageb?lat=18.9&lon=-96.9", {
      headers: AUTH,
    });
    const body = await res.json();
    expect(body.cvegeo).toBe("300280017");
    expect(body.ambito).toBe("Rural");
  });

  it("404s when no polygon contains the point", async () => {
    mockExec.mockReturnValue(""); // psql empty tuple → runJsonQuery []
    const app = createServer(CONFIG);
    const res = await app.request("/resolve/ageb?lat=25.0&lon=-100.0", {
      headers: AUTH,
    });
    expect(res.status).toBe(404);
  });

  it("400s malformed coordinates WITHOUT touching postgres (SQL-injection contract)", async () => {
    const app = createServer(CONFIG);
    for (const q of [
      "lat=19.43;DROP%20TABLE%20x&lon=-99.1",
      "lat=19.4&lon=-99.1'--",
      "lat=&lon=-99.1",
      "lat=19.4&lon=",
      "lat=abc&lon=-99.1",
    ]) {
      const res = await app.request(`/resolve/ageb?${q}`, { headers: AUTH });
      expect(res.status).toBe(400);
    }
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("400s in-format points outside Mexico's bounding box", async () => {
    const app = createServer(CONFIG);
    const cases = [
      "lat=40.7128&lon=-74.006", // NYC
      "lat=19.43&lon=-60.0", // Atlantic
      "lat=10.0&lon=-99.1", // south of bbox
    ];
    for (const q of cases) {
      const res = await app.request(`/resolve/ageb?${q}`, { headers: AUTH });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/fuera de México/);
    }
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("401s without auth", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/resolve/ageb?lat=19.4&lon=-99.1");
    expect(res.status).toBe(401);
  });
});
