import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
// Audit P08: the handler runs on the shared psql runner (async spawn, SQL
// on stdin). The bridge routes it into mockExec and appends the SQL as the
// last recorded arg.
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

// Block body on purpose: an expression arrow returns the mock itself, and
// vitest runs a function returned from beforeEach as teardown — that is
// what used to call a throwing mock after the test ("Error: boom").
beforeEach(() => {
  mockExec.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("GET /summary/sector/:scian", () => {
  it("returns 200 + national total + top 10 entidades", async () => {
    // 32 synthetic entries: count = 100 * (idx+1), so total = 100 * (32*33/2) = 52,800
    const rows = Array.from({ length: 32 }, (_, i) => ({
      entidad: String(i + 1).padStart(2, "0"),
      count: 100 * (i + 1),
    }));
    mockExec.mockReturnValue(JSON.stringify(rows));

    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/46", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      scian: string;
      total_national: number;
      top_entidades: Array<{ entidad: string; count: number }>;
    };
    expect(body.scian).toBe("46");
    expect(body.total_national).toBe(52800);
    expect(body.top_entidades).toHaveLength(10);
    expect(body.top_entidades[0]?.count).toBe(3200);
    expect(body.top_entidades[0]?.entidad).toBe("32");
    expect(body.top_entidades[9]?.count).toBe(2300);
  });

  it("composes SQL with the correct SCIAN offset (chars 6-7)", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/summary/sector/46", { headers: AUTH });
    expect(mockExec).toHaveBeenCalledOnce();
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const sql = argList[argList.length - 1] ?? "";
    // Hits the backfilled sector_actividad_id column (idx_estab_sector btree)
    // — much faster than a SUBSTR scan, and the buggy chars 3-4 offset can
    // never come back via this path.
    expect(sql).toMatch(/sector_actividad_id = '46'/);
    expect(sql).not.toMatch(/SUBSTR\(clee/);
  });

  it("returns 400 on invalid SCIAN (not 2 digits)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/4", { headers: AUTH });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("validation.scian");
  });

  it("returns 400 on non-numeric SCIAN", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/AB", { headers: AUTH });
    expect(res.status).toBe(400);
  });

  it("returns empty body when DB returns null", async () => {
    mockExec.mockReturnValue("null");
    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/46", { headers: AUTH });
    const body = (await res.json()) as {
      total_national: number;
      top_entidades: unknown[];
    };
    expect(body.total_national).toBe(0);
    expect(body.top_entidades).toEqual([]);
  });

  it("statement_timeout reaches the container via docker exec -e (audit #94/#130)", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/summary/sector/46", { headers: AUTH });
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const i = argList.indexOf("-e");
    expect(i).toBeGreaterThan(0);
    expect(argList[i + 1]).toMatch(/^PGOPTIONS=.*statement_timeout=25000/);
  });

  it("returns 502 postgres.error without psql text when psql fails", async () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error("boom"), { stderr: "ERROR: relation x" });
    });
    const app = createServer(CONFIG);
    const res = await app.request("/summary/sector/46", { headers: AUTH });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("postgres.error");
    expect(body.error).not.toContain("relation");
  });
});
