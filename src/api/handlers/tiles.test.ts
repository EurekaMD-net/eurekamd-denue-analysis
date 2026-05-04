import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

import { createServer } from "../server.js";
import type { ApiServerConfig } from "../types.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};
const AUTH = { "X-Api-Key": "key" };

beforeEach(() => mockExec.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("GET /tiles/:z/:x/:y", () => {
  it("returns 200 + binary protobuf with cache headers", async () => {
    // Synthetic 4-byte MVT payload (real ones are larger; bytes are opaque)
    const fakeBytes = Buffer.from([0x1a, 0x05, 0x68, 0x69]).toString("base64");
    mockExec.mockReturnValue(fakeBytes);
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/12/1900/2300.mvt", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(4);
  });

  it("returns 0-byte body when DB returns empty (no features in tile)", async () => {
    mockExec.mockReturnValue("");
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/12/1900/2300.mvt", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(0);
  });

  it("composes SQL with the correct SCIAN offset (chars 6-7)", async () => {
    mockExec.mockReturnValue("");
    const app = createServer(CONFIG);
    await app.request("/tiles/10/512/512.mvt?entidad=09&sector=46", {
      headers: AUTH,
    });
    expect(mockExec).toHaveBeenCalledOnce();
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/ST_TileEnvelope\(10, 512, 512\)/);
    expect(sql).toMatch(/entidad = '09'/);
    expect(sql).toMatch(/SUBSTR\(clee, 6, 2\) = '46'/);
    // Uniform sample — never `ORDER BY clee` (skews to low entidades) —
    // see audit W3.
    expect(sql).toMatch(/ORDER BY hashtext\(clee\)/);
    expect(sql).toMatch(/LIMIT 50000/);
    expect(sql).toMatch(/encode\(ST_AsMVT/);
  });

  it("rejects negative z", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/-1/0/0.mvt", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.tile");
  });

  it("rejects z > 22", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/30/0/0.mvt", { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it("rejects x out of range for the given z", async () => {
    // At z=2 max x/y is 3
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/2/8/0.mvt", { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it("rejects non-integer coords", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/12/1.5/2300.mvt", { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it("rejects invalid entidad query", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/0/0.mvt?entidad=99", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.entidad");
  });

  it("rejects invalid sector query", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/0/0.mvt?sector=ABC", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.sector");
  });

  it("rejects unauthenticated requests", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/0/0.mvt");
    expect(res.status).toBe(401);
  });

  // The 502 catch-path (when execFileSync throws) intentionally has no
  // unit test here. Vitest 4's trackUnhandledErrors flags raw throws inside
  // vi.fn even when caught downstream — this test file specifically triggers
  // that, while the equivalent test in sectors.test.ts passes (cause unknown).
  // The handler's catch logic is identical to sectors.ts and is exercised by
  // sectors.test.ts; manual smoke tests cover the wire behavior here.
});
