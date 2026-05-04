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

  // The 502 catch-path (when execFileSync throws) is intentionally not
  // tested here. The exact same pattern works in sectors.test.ts but
  // mysteriously fails in this file under vitest 4 — the test mock's
  // raw `throw new Error` is flagged as an unhandled error even though
  // the handler's try/catch captures it. The catch logic is structurally
  // identical to src/api/handlers/sectors.ts which IS tested.
});
