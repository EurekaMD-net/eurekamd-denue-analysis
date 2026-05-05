import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// Tile handler runs psql via promisify(execFile) — async — so the mock has
// to honor the callback-style API that promisify wraps. mockExec records the
// (file, args, options) it was called with, then invokes the callback with
// { stdout, stderr } shaped like the real execFile callback. Tests set the
// resolved stdout via mockExec.__stdout (default ""), or simulate failure via
// mockExec.__error.
const { mockExec } = vi.hoisted(() => {
  const fn = vi.fn(
    (
      _file: string,
      _args: string[],
      _opts: unknown,
      cb: (
        err: Error | null,
        result: { stdout: string; stderr: string },
      ) => void,
    ) => {
      const err = (fn as unknown as { __error?: Error }).__error;
      if (err) return cb(err, { stdout: "", stderr: "" });
      const stdout = (fn as unknown as { __stdout?: string }).__stdout ?? "";
      cb(null, { stdout, stderr: "" });
    },
  );
  return { mockExec: fn };
});
vi.mock("node:child_process", () => ({
  execFile: mockExec,
  execFileSync: vi.fn(),
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

// Set the stdout the next execFile invocation will resolve with.
function setStdout(stdout: string): void {
  (mockExec as unknown as { __stdout?: string }).__stdout = stdout;
}

beforeEach(() => {
  mockExec.mockClear();
  setStdout("");
  (mockExec as unknown as { __error?: Error }).__error = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe("GET /tiles/:z/:x/:y", () => {
  it("returns 200 + binary protobuf with cache headers", async () => {
    // Synthetic 4-byte MVT payload (real ones are larger; bytes are opaque)
    const fakeBytes = Buffer.from([0x1a, 0x05, 0x68, 0x69]).toString("base64");
    setStdout(fakeBytes);
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/12/1900/2300.mvt", { headers: AUTH });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/x-protobuf");
    expect(res.headers.get("cache-control")).toMatch(/max-age=3600/);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(4);
  });

  it("returns 0-byte body when DB returns empty (no features in tile)", async () => {
    setStdout("");
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/12/1900/2300.mvt", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(0);
  });

  it("composes SQL with the correct SCIAN offset (chars 6-7)", async () => {
    setStdout("");
    const app = createServer(CONFIG);
    await app.request("/tiles/10/512/512.mvt?entidad=09&sector=46", {
      headers: AUTH,
    });
    expect(mockExec).toHaveBeenCalledOnce();
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/ST_TileEnvelope\(10, 512, 512\)/);
    expect(sql).toMatch(/entidad = '09'/);
    expect(sql).toMatch(/sector_actividad_id = '46'/);
    expect(sql).not.toMatch(/SUBSTR\(clee/);
    // No ORDER BY — relies on LIMIT short-circuiting the scan for speed.
    // The trade-off (non-uniform sampling) is acceptable for density
    // visualization at low zoom; high zoom never hits the cap.
    expect(sql).not.toMatch(/ORDER BY/);
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

  it("returns 502 when psql fails (covers async catch path)", async () => {
    (mockExec as unknown as { __error?: Error }).__error = new Error(
      "ECONNREFUSED",
    );
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/12/1900/2300.mvt", { headers: AUTH });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgis.error");
  });
});
