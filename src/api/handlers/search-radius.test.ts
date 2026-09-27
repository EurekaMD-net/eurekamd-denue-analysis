/**
 * Regression tests for audit C1 — shell injection via `q` parameter.
 *
 * These tests cover the searchWithRadius path which used to shell-interpolate
 * the SQL string into `docker exec ... -c "${sql}"`. The fix replaced
 * execSync(shell-string) with an args array; since audit P08 the shared
 * psql runner spawns docker with an args array and sends the SQL on stdin,
 * so shell metacharacters in `q` cannot escape the SQL parser into the shell.
 * The bridge mock appends the stdin SQL as the last recorded arg.
 *
 * Separate file from search.test.ts because we vi.mock("node:child_process"),
 * which can't coexist cleanly with the no-radius PostgREST tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock child_process before any module imports
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock("node:child_process", async () =>
  (await import("../db/psql-bridge.test-helper.js")).psqlChildProcessMock(
    mockExecFile,
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
  mockExecFile.mockReset();
  vi.restoreAllMocks();
});

describe("GET /search — radius path uses the shared runner (audit C1)", () => {
  it("invokes docker with an args array and the SQL on stdin, never -c", async () => {
    mockExecFile.mockReturnValue(JSON.stringify([{ clee: "06001" }]));
    const app = createServer(CONFIG);
    const res = await app.request("/search?from=19.4,-99.1&radius_km=10", {
      headers: AUTH,
    });
    expect(res.status).toBe(200);
    expect(mockExecFile).toHaveBeenCalledOnce();
    const [bin, args] = mockExecFile.mock.calls[0] as [string, string[]];
    expect(bin).toBe("docker");
    // Args is an actual array, NOT a shell string — args[0] = "exec"
    expect(Array.isArray(args)).toBe(true);
    expect(args[0]).toBe("exec");
    expect(args).toContain("test-supabase-db");
    expect(args).not.toContain("-c");
    expect(args).toContain("-f");
  });

  it("shell metacharacters in q are passed as literal SQL — never shell-expanded", async () => {
    mockExecFile.mockReturnValue("[]");
    const app = createServer(CONFIG);
    // Adversarial q: shell metacharacters that would be RCE under execSync(shell-string)
    const adversarialQ = encodeURIComponent('foo";$(whoami);echo "bar');
    const res = await app.request(
      `/search?from=19.4,-99.1&radius_km=10&q=${adversarialQ}`,
      { headers: AUTH },
    );
    expect(res.status).toBe(200);

    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    const sqlArg = args[args.length - 1]!;
    // The SQL string contains the literal q content — escaped for SQL parser only
    expect(sqlArg).toContain('foo"');
    expect(sqlArg).toContain("$(whoami)");
    // No shell would have run: spawn with an args array bypasses /bin/sh
  });

  it("ST_DWithin is composed with safe numeric interpolation", async () => {
    mockExecFile.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/search?from=19.4326,-99.1332&radius_km=15.5", {
      headers: AUTH,
    });
    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    const sql = args[args.length - 1]!;
    expect(sql).toContain("ST_DWithin");
    expect(sql).toContain("ST_MakePoint(-99.1332, 19.4326)"); // lon, lat order
    expect(sql).toContain("15500"); // 15.5 km in meters
  });

  it("statement_timeout reaches the container via docker exec -e (audit #94/#130)", async () => {
    mockExecFile.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/search?from=19,-99&radius_km=5", { headers: AUTH });
    // Old code set PGOPTIONS in the host env (never forwarded by docker
    // exec) and had no -e flag at all.
    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    const i = args.indexOf("-e");
    expect(i).toBeGreaterThan(0);
    expect(args[i + 1]).toMatch(/^PGOPTIONS=.*statement_timeout=25000/);
  });

  it("psql failure surfaces as 502 postgres.error, not 500 (audit #54)", async () => {
    mockExecFile.mockImplementation(() => {
      throw Object.assign(new Error("boom"), { stderr: "ERROR: canceling" });
    });
    const app = createServer(CONFIG);
    const res = await app.request("/search?from=19,-99&radius_km=5", {
      headers: AUTH,
    });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("postgres.error");
    expect(body.error).not.toContain("canceling");
  });

  it("rejects q containing a NUL byte with 400 (audit #54)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/search?from=19,-99&radius_km=5&q=ab%00cd",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.q");
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it("prefilters with an index-usable geometry bbox and orders nearest-first (audit #35/#97)", async () => {
    mockExecFile.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/search?from=28.2,-105.9&radius_km=1", {
      headers: AUTH,
    });
    const args = mockExecFile.mock.calls[0]?.[1] as string[];
    const sql = args[args.length - 1]!;
    const pt = "ST_SetSRID(ST_MakePoint(-105.9, 28.2), 4326)";
    expect(sql).toContain(
      `geom && ST_Expand(${pt}, 1000 / 111320.0 / cos(radians(28.2)))`,
    );
    // The bbox prefilter comes before the exact geography check.
    expect(sql.indexOf("geom && ST_Expand")).toBeLessThan(
      sql.indexOf("ST_DWithin"),
    );
    expect(sql).toContain(
      `ST_DWithin(geom::geography, ${pt}::geography, 1000)`,
    );
    expect(sql).toContain(`ORDER BY geom <-> ${pt}`);
    expect(sql).not.toContain("ORDER BY clee");
    expect(sql).toContain("AS distance_m");
  });

  it("rejects from outside Mexico, out of range or swapped with 400 validation.from_coords (audit #44)", async () => {
    const app = createServer(CONFIG);
    for (const from of ["195,-99", "-99,19", "19,-190", "40.7,-74.0", "0,0"]) {
      const res = await app.request(`/search?from=${from}&radius_km=5`, {
        headers: AUTH,
      });
      expect(res.status, from).toBe(400);
      const body = (await res.json()) as { code: string };
      expect(body.code, from).toBe("validation.from_coords");
    }
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});
