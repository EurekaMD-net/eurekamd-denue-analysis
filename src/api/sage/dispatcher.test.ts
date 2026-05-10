import { describe, it, expect } from "vitest";
import { buildEndpointPath, buildDigest } from "./dispatcher.js";

describe("buildEndpointPath", () => {
  it("handles a no-param endpoint", () => {
    const r = buildEndpointPath("entidades", {});
    expect(r).toEqual({ ok: true, path: "/entidades" });
  });

  it("substitutes placeholders + URL-encodes the value", () => {
    const r = buildEndpointPath("summary-entidad", { clave: "19" });
    expect(r).toEqual({
      ok: true,
      path: "/summary/entidad/19",
    });
  });

  it("appends remaining params as query string", () => {
    const r = buildEndpointPath("top-sectors", { entidad: "09", limit: 5 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path.startsWith("/analytics/top-sectors?")).toBe(true);
      expect(r.path).toContain("entidad=09");
      expect(r.path).toContain("limit=5");
    }
  });

  it("rejects unknown endpoint names", () => {
    const r = buildEndpointPath("definitely-not-a-route", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toMatch(/^endpoint:/);
  });

  it("flags missing placeholder params", () => {
    const r = buildEndpointPath("summary-entidad", {});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toBe("clave");
  });

  it("ignores null/undefined query params", () => {
    const r = buildEndpointPath("top-sectors", {
      entidad: "09",
      limit: undefined as unknown as number,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.path).toContain("entidad=09");
      expect(r.path).not.toContain("limit=");
    }
  });
});

describe("buildDigest", () => {
  it("computes columns, count, sample, and numeric stats", () => {
    const rows = [
      { cve_mun: "01001", pct: 10 },
      { cve_mun: "01002", pct: 20 },
      { cve_mun: "01003", pct: 30 },
    ];
    const d = buildDigest(rows, 10);
    expect(d.columns.sort()).toEqual(["cve_mun", "pct"]);
    expect(d.row_count).toBe(3);
    expect(d.first_n_rows).toEqual(rows);
    expect(d.numeric_stats?.pct).toEqual({ min: 10, max: 30, mean: 20 });
  });

  it("handles array bodies wrapped in {rows:[...]}", () => {
    const d = buildDigest({ rows: [{ a: 1 }] });
    expect(d.row_count).toBe(1);
    expect(d.columns).toEqual(["a"]);
  });

  it("handles single-object bodies", () => {
    const d = buildDigest({ x: 5, name: "test" });
    expect(d.row_count).toBe(1);
    expect(d.columns.sort()).toEqual(["name", "x"]);
  });

  it("excludes numeric_stats when there's only 1 row", () => {
    const d = buildDigest([{ x: 5 }]);
    expect(d.numeric_stats).toBeUndefined();
  });
});
