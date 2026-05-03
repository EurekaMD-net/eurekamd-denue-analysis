/**
 * Regression tests for audit C1 — shell injection via `q` parameter.
 *
 * These tests cover the searchWithRadius path which used to shell-interpolate
 * the SQL string into `docker exec ... -c "${sql}"`. The fix replaced
 * execSync(shell-string) with execFileSync(args-array), so shell
 * metacharacters in `q` cannot escape the SQL parser into the shell.
 *
 * Separate file from search.test.ts because we vi.mock("node:child_process"),
 * which can't coexist cleanly with the no-radius PostgREST tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock child_process before any module imports
const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: mockExecFile }));

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

describe("GET /search — radius path uses execFileSync (audit C1)", () => {
  it("invokes execFileSync with args array, never shell-string execSync", async () => {
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
    expect(args).toContain("-c");
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
    // No shell would have run: execFileSync bypasses /bin/sh entirely
    // (we can't directly assert "no shell" but we CAN assert execSync was not called)
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

  it("radius path applies execFileSync timeout (no hung handlers)", async () => {
    mockExecFile.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/search?from=19,-99&radius_km=5", { headers: AUTH });
    const opts = mockExecFile.mock.calls[0]?.[2] as { timeout: number };
    expect(opts.timeout).toBeGreaterThanOrEqual(1000);
    expect(opts.timeout).toBeLessThanOrEqual(60_000);
  });
});
