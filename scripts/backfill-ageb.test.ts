import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
}));

import { buildBackfillAgebSQL, backfillAgeb } from "./backfill-ageb.js";

beforeEach(() => mockExec.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("buildBackfillAgebSQL", () => {
  it("emits a national-scope spatial-join UPDATE when entidad is omitted", () => {
    const sql = buildBackfillAgebSQL();
    expect(sql).toMatch(/UPDATE establecimientos e/);
    // CVEGEO (13-char national-unique key) — not cve_ageb (4-char,
    // only unique within a locality).
    expect(sql).toMatch(/SET ageb = a\.cvegeo/);
    expect(sql).not.toMatch(/SET ageb = a\.cve_ageb/);
    expect(sql).toMatch(/FROM ageb_polygons a/);
    expect(sql).toMatch(/ST_Contains\(a\.geom, e\.geom\)/);
    expect(sql).toMatch(/e\.ageb IS NULL/);
    expect(sql).not.toMatch(/e\.entidad =/);
  });

  it("scopes by entidad when supplied", () => {
    const sql = buildBackfillAgebSQL("09");
    expect(sql).toMatch(/e\.entidad = '09'/);
  });

  it("returns rows_updated count via WITH/RETURNING", () => {
    const sql = buildBackfillAgebSQL();
    expect(sql).toMatch(/RETURNING 1/);
    expect(sql).toMatch(/SELECT COUNT\(\*\) AS rows_updated FROM updated/);
  });

  it("validates entidad inline (defense-in-depth) and rejects bad input", () => {
    expect(() => buildBackfillAgebSQL("33")).toThrow(/entidad inválida/);
    expect(() => buildBackfillAgebSQL("9")).toThrow(/entidad inválida/);
    expect(() => buildBackfillAgebSQL("AB")).toThrow(/entidad inválida/);
    // SQL-injection attempt via interpolation — must throw, never compose
    expect(() => buildBackfillAgebSQL("09'; DROP TABLE")).toThrow(
      /entidad inválida/,
    );
  });
});

describe("backfillAgeb", () => {
  it("runs docker exec psql with the composed SQL and parses count", async () => {
    mockExec.mockReturnValue("12345\n");
    const result = await backfillAgeb({ dbContainer: "test-supabase-db" });
    expect(result.rows_updated).toBe(12345);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);

    expect(mockExec).toHaveBeenCalledOnce();
    const argList = mockExec.mock.calls[0]?.[1] as string[];
    expect(argList[0]).toBe("exec");
    expect(argList[1]).toBe("test-supabase-db");
    expect(argList).toContain("psql");
    const sql = argList[argList.length - 1] ?? "";
    expect(sql).toMatch(/ST_Contains/);
  });

  it("rejects invalid entidad without invoking psql", async () => {
    await expect(
      backfillAgeb({ dbContainer: "x", entidad: "33" }),
    ).rejects.toThrow(/entidad inválida/);
    await expect(
      backfillAgeb({ dbContainer: "x", entidad: "9" }),
    ).rejects.toThrow(/entidad inválida/);
    await expect(
      backfillAgeb({ dbContainer: "x", entidad: "AB" }),
    ).rejects.toThrow(/entidad inválida/);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("throws on non-numeric psql output", async () => {
    mockExec.mockReturnValue("oops\n");
    await expect(
      backfillAgeb({ dbContainer: "test-supabase-db" }),
    ).rejects.toThrow(/unexpected psql output/);
  });

  it("rejects malformed dbContainer (anti docker-flag injection)", async () => {
    await expect(backfillAgeb({ dbContainer: "--rm" })).rejects.toThrow(
      /dbContainer inválido/,
    );
    await expect(
      backfillAgeb({ dbContainer: "ok name with spaces" }),
    ).rejects.toThrow(/dbContainer inválido/);
    await expect(backfillAgeb({ dbContainer: "" })).rejects.toThrow(
      /dbContainer inválido/,
    );
    expect(mockExec).not.toHaveBeenCalled();
  });
});
