import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { buildSectorFilter, parseSectorParam } from "./tiles.js";

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
    // RH-5: 2-digit `sector=46` now uses the IN-list shape (single-elem).
    expect(sql).toMatch(/sector_actividad_id IN \('46'\)/);
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

  // RH-5: multi-SCIAN bundle filter on /tiles.
  it("accepts a single 4-digit SCIAN code (rama)", async () => {
    setStdout("");
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/512/512.mvt?sector=4641", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/rama_actividad_id IN \('4641'\)/);
    expect(sql).not.toMatch(/sector_actividad_id IN/);
  });

  it("accepts a comma-separated multi-SCIAN list at uniform depth", async () => {
    setStdout("");
    const app = createServer(CONFIG);
    const res = await app.request(
      "/tiles/10/512/512.mvt?sector=4641,4671,4673",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/rama_actividad_id IN \('4641', '4671', '4673'\)/);
  });

  it("accepts mixed-depth codes and ORs across grain-matched columns", async () => {
    setStdout("");
    const app = createServer(CONFIG);
    // 4641 (rama) + 46451 (subrama) + 46411 (subrama)
    const res = await app.request(
      "/tiles/10/512/512.mvt?sector=4641,46451,46411",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    // Multi-group → wrapped in parens, columns ORd
    expect(sql).toMatch(
      /AND \((rama_actividad_id IN \('4641'\) OR subrama_actividad_id IN \('46451', '46411'\)|subrama_actividad_id IN \('46451', '46411'\) OR rama_actividad_id IN \('4641'\))\)/,
    );
  });

  it("backward-compat: single 2-digit code still hits sector_actividad_id", async () => {
    setStdout("");
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/512/512.mvt?sector=46", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    // Should be IN-list form (single element), still on the 2-digit column.
    expect(sql).toMatch(/sector_actividad_id IN \('46'\)/);
  });

  it("rejects 1-digit SCIAN code (below allowed depth)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/0/0.mvt?sector=4", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      "validation.sector",
    );
  });

  it("rejects 7-digit SCIAN code (above allowed depth)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/0/0.mvt?sector=1234567", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("rejects mixed valid + invalid codes (fails the whole request)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/0/0.mvt?sector=4641,bogus", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("rejects empty token inside the comma list", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/tiles/10/0/0.mvt?sector=4641,,4671", {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });

  it("rejects more than MAX_SCIAN_CODES codes (DoS defense)", async () => {
    const app = createServer(CONFIG);
    // 17 codes — exceeds the 16-code cap.
    const codes = Array.from({ length: 17 }, (_, i) =>
      String(4641 + i).padStart(4, "0"),
    ).join(",");
    const res = await app.request(`/tiles/10/0/0.mvt?sector=${codes}`, {
      headers: AUTH,
    });
    expect(res.status).toBe(400);
  });
});

// ----------- Pure helper tests (no server, no mock) -----------
describe("parseSectorParam (RH-5)", () => {
  it("returns null for undefined / empty", () => {
    expect(parseSectorParam(undefined)).toBeNull();
    expect(parseSectorParam("")).toBeNull();
  });

  it("accepts single 2..6 digit codes", () => {
    for (const code of ["46", "464", "4641", "46451", "464111"]) {
      expect(parseSectorParam(code)).toEqual([code]);
    }
  });

  it("accepts comma-separated list, trimming whitespace", () => {
    expect(parseSectorParam("4641, 4671 ,4673")).toEqual([
      "4641",
      "4671",
      "4673",
    ]);
  });

  it("rejects non-numeric tokens", () => {
    expect(parseSectorParam("46AB")).toBeNull();
    expect(parseSectorParam("4641,bogus")).toBeNull();
  });

  it("rejects too-short / too-long codes", () => {
    expect(parseSectorParam("4")).toBeNull();
    expect(parseSectorParam("1234567")).toBeNull();
  });

  it("rejects empty tokens", () => {
    expect(parseSectorParam(",")).toBeNull();
    expect(parseSectorParam("4641,,4671")).toBeNull();
  });

  it("rejects more than 16 codes (DoS defense)", () => {
    const list = Array.from({ length: 17 }, () => "46").join(",");
    expect(parseSectorParam(list)).toBeNull();
  });
});

describe("buildSectorFilter (RH-5)", () => {
  it("returns empty string for empty input", () => {
    expect(buildSectorFilter([])).toBe("");
  });

  it("uniform-depth list dispatches to single column", () => {
    expect(buildSectorFilter(["46"])).toBe("AND sector_actividad_id IN ('46')");
    expect(buildSectorFilter(["4641", "4671"])).toBe(
      "AND rama_actividad_id IN ('4641', '4671')",
    );
  });

  it("mixed-depth list groups by length then ORs", () => {
    const out = buildSectorFilter(["4641", "46451"]);
    // Either group order is fine — we only assert structural shape.
    expect(out).toContain("rama_actividad_id IN ('4641')");
    expect(out).toContain("subrama_actividad_id IN ('46451')");
    expect(out).toMatch(/^AND \(.* OR .*\)$/);
  });

  it("dispatches each of the 5 SCIAN depths to its indexed column", () => {
    expect(buildSectorFilter(["46"])).toContain("sector_actividad_id");
    expect(buildSectorFilter(["464"])).toContain("subsector_actividad_id");
    expect(buildSectorFilter(["4641"])).toContain("rama_actividad_id");
    expect(buildSectorFilter(["46451"])).toContain("subrama_actividad_id");
    expect(buildSectorFilter(["464111"])).toContain("clase_actividad_id");
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
