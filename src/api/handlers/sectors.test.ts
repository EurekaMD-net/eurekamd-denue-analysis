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
import type { ApiServerConfig, SectorsResult } from "../types.js";
import { _resetScianCache } from "./sectors.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-jwt",
  apiKey: "key",
  dbContainer: "test-supabase-db",
};
const AUTH = { "X-Api-Key": "key" };

beforeEach(() => {
  mockExec.mockReset();
  _resetScianCache();
});

afterEach(() => vi.restoreAllMocks());

describe("GET /sectors", () => {
  it("returns named sectors sorted by national_count DESC", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        { scian: "11", count: 25639 },
        { scian: "46", count: 2531841 },
        { scian: "62", count: 269902 },
        { scian: "72", count: 794232 },
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/sectors", { headers: AUTH });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SectorsResult;
    expect(body.sectors).toHaveLength(4);
    // Sorted DESC by count
    expect(body.sectors[0]?.scian).toBe("46");
    expect(body.sectors[0]?.national_count).toBe(2531841);
    expect(body.sectors[0]?.name).toMatch(/Comercio al por menor/);
    expect(body.sectors[3]?.scian).toBe("11");
  });

  it("emits placeholder name for SCIAN values not in catalog", async () => {
    mockExec.mockReturnValue(
      JSON.stringify([
        { scian: "46", count: 2500000 },
        { scian: "29", count: 1 }, // anomaly — not in catalog
      ]),
    );
    const app = createServer(CONFIG);
    const res = await app.request("/sectors", { headers: AUTH });
    const body = (await res.json()) as SectorsResult;
    const anomaly = body.sectors.find((s) => s.scian === "29");
    expect(anomaly?.name).toMatch(/sin etiqueta/);
    expect(anomaly?.national_count).toBe(1);
  });

  it("uses an args array with the SQL on stdin (no shell injection surface)", async () => {
    mockExec.mockReturnValue(JSON.stringify([{ scian: "46", count: 100 }]));
    const app = createServer(CONFIG);
    await app.request("/sectors", { headers: AUTH });
    expect(mockExec).toHaveBeenCalledOnce();
    const args = mockExec.mock.calls[0];
    expect(args?.[0]).toBe("docker");
    const argList = args?.[1] as string[];
    expect(argList).toContain("exec");
    expect(argList).toContain("test-supabase-db");
    expect(argList).toContain("psql");
    // Last arg is the SQL — must hit the indexed sector_actividad_id column
    // (backfilled from CLEE chars 6-7). Never re-scan via SUBSTR.
    const sql = argList[argList.length - 1];
    expect(sql).toMatch(/sector_actividad_id/);
    expect(sql).not.toMatch(/SUBSTR\(clee/);
  });

  it("statement_timeout reaches the container via docker exec -e (audit #94/#130)", async () => {
    mockExec.mockReturnValue("[]");
    const app = createServer(CONFIG);
    await app.request("/sectors", { headers: AUTH });
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    const i = argList.indexOf("-e");
    expect(i).toBeGreaterThan(0);
    expect(argList[i + 1]).toMatch(/^PGOPTIONS=.*statement_timeout=25000/);
  });

  it("returns empty array when DB returns null", async () => {
    mockExec.mockReturnValue("null");
    const app = createServer(CONFIG);
    const res = await app.request("/sectors", { headers: AUTH });
    const body = (await res.json()) as SectorsResult;
    expect(body.sectors).toEqual([]);
  });

  it("returns 502 when psql fails", async () => {
    mockExec.mockImplementation(() => {
      throw new Error("connection refused");
    });
    const app = createServer(CONFIG);
    const res = await app.request("/sectors", { headers: AUTH });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("postgres.error");
  });

  it("rejects unauthenticated requests", async () => {
    const app = createServer(CONFIG);
    const res = await app.request("/sectors");
    expect(res.status).toBe(401);
  });
});
