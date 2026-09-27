import { describe, it, expect, vi, afterEach } from "vitest";

// Every psql call made by a real handler fails, so a handler reached by
// the catalog-coverage test answers 5xx (DB down), never 400/404.
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", async () =>
  (await import("../db/psql-bridge.test-helper.js")).psqlChildProcessMock(
    mockExec,
  ),
);

import type { Hono } from "hono";
import {
  buildEndpointPath,
  buildDigest,
  dispatchEndpoint,
  ENDPOINT_PATHS,
  DIGEST_ROWS_MAX_BYTES,
} from "./dispatcher.js";
import { SAGE_ENDPOINT_CATALOG } from "./endpoint-catalog.js";
import { createServer } from "../server.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

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

describe("buildDigest — keyed endpoint bodies (audit #76/#201)", () => {
  const series = Array.from({ length: 135 }, (_, i) => ({
    ano: 2015 + Math.floor(i / 12),
    mes: (i % 12) + 1,
    robo_negocio: i,
    homicidio_doloso: 1,
    extorsion: 0,
    total: 10 + i,
  }));
  const riskTrend = {
    cve_mun: "20067",
    municipio: "Oaxaca de Juárez",
    poblacion: 270955,
    series,
  };

  it("unwraps the array under its key and keeps scalar siblings as context", () => {
    const d = buildDigest(riskTrend);
    expect(d.row_count).toBe(135);
    expect(d.columns).toEqual([
      "ano",
      "mes",
      "robo_negocio",
      "homicidio_doloso",
      "extorsion",
      "total",
    ]);
    expect(d.context).toEqual({
      cve_mun: "20067",
      municipio: "Oaxaca de Juárez",
      poblacion: 270955,
    });
    expect(d.numeric_stats?.total).toEqual({ min: 10, max: 144, mean: 77 });
    expect(d.first_n_rows.length).toBeLessThanOrEqual(20);
    expect(d.first_n_rows[0]).toEqual(series[0]);
  });

  it("picks the largest array of objects", () => {
    const d = buildDigest({
      entidad: "09",
      loaded: 10,
      top_sectors: [{ scian_id: "46", count: 3 }],
      estrato_distribution: [
        { estrato: "a", count: 1 },
        { estrato: "b", count: 2 },
      ],
    });
    expect(d.row_count).toBe(2);
    expect(d.columns).toEqual(["estrato", "count"]);
    expect(d.context).toEqual({ entidad: "09", loaded: 10 });
  });

  it("an empty keyed array is zero rows, not one", () => {
    const d = buildDigest({ cve_mun: "09015", total_returned: 0, agebs: [] });
    expect(d.row_count).toBe(0);
    expect(d.first_n_rows).toEqual([]);
  });

  it("caps first_n_rows by serialized size as well as by count", () => {
    const rows = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      nota: "x".repeat(500),
    }));
    const d = buildDigest({ municipios: rows });
    expect(d.row_count).toBe(50);
    expect(JSON.stringify(d.first_n_rows).length).toBeLessThanOrEqual(
      DIGEST_ROWS_MAX_BYTES,
    );
    expect(d.first_n_rows.length).toBeGreaterThan(0);
    expect(d.first_n_rows.length).toBeLessThan(20);
  });

  it("flattens a single-record endpoint one level instead of picking its sample arrays", () => {
    const agebDetail = {
      cvegeo: "090150001123A",
      cve_mun: "09015",
      population: 1200,
      census: { pobtot: 1200, pobfem: 600 },
      rezago_social: { grado: "Bajo" },
      top_sectors: [
        { scian: "46", count: 10 },
        { scian: "81", count: 4 },
      ],
      clues_sample: [{ clues: "X" }, { clues: "Y" }, { clues: "Z" }],
    };
    const d = buildDigest(agebDetail, 20, { singleRecord: true });
    expect(d.row_count).toBe(1);
    expect(d.columns).toContain("census.pobtot");
    expect(d.columns).toContain("rezago_social.grado");
    expect(d.columns).toContain("cvegeo");
    expect(d.context).toBeUndefined();
    const row = d.first_n_rows[0] as Record<string, unknown>;
    expect(row["census.pobtot"]).toBe(1200);
  });

  it("trims an oversized single record to the byte budget", () => {
    const layers: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) {
      layers[`layer_${i}`] = { a: "y".repeat(80), b: i };
    }
    const d = buildDigest({ cve_mun: "09015", ...layers }, 20, {
      singleRecord: true,
    });
    expect(d.row_count).toBe(1);
    expect(JSON.stringify(d.first_n_rows).length).toBeLessThanOrEqual(
      DIGEST_ROWS_MAX_BYTES,
    );
    expect((d.first_n_rows[0] as Record<string, unknown>).cve_mun).toBe(
      "09015",
    );
  });
});

describe("buildDigest — numeric coercion (audit #81)", () => {
  // Shape of parseCsv output on the SQL path: every value a string,
  // NULL as null.
  const sqlRows = [
    { cve_ent: "02", nom_ent: "Baja California", ranking: "1", total: "100", codigo: "007" },
    { cve_ent: "17", nom_ent: "Morelos", ranking: "2", total: null, codigo: "010" },
    { cve_ent: "09", nom_ent: "CDMX", ranking: "3", total: "100", codigo: "003" },
  ];

  it("never computes stats for ID-like columns", () => {
    const d = buildDigest(sqlRows);
    expect(d.numeric_stats?.cve_ent).toBeUndefined();
    expect(d.numeric_stats?.ranking).toBeUndefined();
  });

  it("skips NULLs instead of counting them as 0", () => {
    const d = buildDigest(sqlRows);
    expect(d.numeric_stats?.total).toEqual({ min: 100, max: 100, mean: 100 });
  });

  it("treats zero-padded strings as codes, not numbers", () => {
    const d = buildDigest(sqlRows);
    expect(d.numeric_stats?.codigo).toBeUndefined();
  });
});

describe("dispatchEndpoint — required params (audit #86)", () => {
  it("returns ENDPOINT_PARAM_MISSING for a missing required query param before app.fetch", async () => {
    const fetch = vi.fn();
    const r = await dispatchEndpoint({ fetch } as unknown as Hono, "key", {
      kind: "endpoint",
      endpoint_name: "opportunity-by-ageb",
      params: { cve_mun: "09015" },
      reasoning: "",
      confidence: 1,
    } as Parameters<typeof dispatchEndpoint>[2]);
    expect(r).toEqual({
      ok: false,
      code: "ENDPOINT_PARAM_MISSING",
      message: "Missing required param: target_scian",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("catalog ↔ server routes (audit #77)", () => {
  const CONFIG = {
    supabaseUrl: "http://localhost:8100",
    serviceRoleKey: "k",
    apiKey: "key",
    dbContainer: "test-db",
  };
  // A valid value for every param any catalog entry marks required.
  const SAMPLE: Record<string, string> = {
    clave: "09",
    scian: "46",
    entidad: "09",
    cve_ent: "09",
    cve_mun: "09015",
    cvegeo: "090150001123A",
    cve_loc: "090150001",
    target_scian: "46",
  };
  // GET routes Sage deliberately cannot call.
  const EXCLUDED_ROUTES = new Set([
    "/health", // liveness no-op
    "/search", // free text; Sage composes answers itself
    "/establishment/:clee", // single-row follow-up
    "/tiles/:z/:x/:y", // binary vector tiles
    "/clusters", // map viewport clustering
    "/analytics/locust-muni", // Locust map layer feeds
    "/analytics/locust-ageb",
    "/analytics/locust-estado",
    "/analytics/layers/values", // map choropleth values
    "/resolve/ageb", // lat/lon point lookup for address validation
    "/sage/health",
    "/sage/thread/:id",
  ]);

  it("every catalog entry has a path and every path a catalog entry", () => {
    const names = SAGE_ENDPOINT_CATALOG.map((e) => e.name).sort();
    expect(Object.keys(ENDPOINT_PATHS).sort()).toEqual(names);
  });

  it("every server GET route is in the catalog or explicitly excluded", () => {
    const app = createServer(CONFIG);
    const catalogPaths = new Set(
      Object.values(ENDPOINT_PATHS).map((p) =>
        p.replace(/\{([^}]+)\}/g, ":$1"),
      ),
    );
    const uncovered = app.routes
      .filter((r) => r.method === "GET")
      .map((r) => r.path)
      .filter((p) => !catalogPaths.has(p) && !EXCLUDED_ROUTES.has(p));
    expect(uncovered).toEqual([]);
  });

  it("every catalog entry, called with its required params, reaches its handler (no 400/404)", async () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error("db down"), { stderr: "db down" });
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const app = createServer(CONFIG);
    const bad: string[] = [];
    for (const ep of SAGE_ENDPOINT_CATALOG) {
      const params: Record<string, string> = {};
      for (const k of ep.params_schema.required ?? []) {
        expect(SAMPLE[k], `sample value for ${k}`).toBeDefined();
        params[k] = SAMPLE[k]!;
      }
      const built = buildEndpointPath(ep.name, params);
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      const res = await app.request(built.path, {
        headers: { "X-Api-Key": "key" },
      });
      if (res.status === 400 || res.status === 404) {
        bad.push(`${ep.name} ${built.path} -> ${res.status}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
