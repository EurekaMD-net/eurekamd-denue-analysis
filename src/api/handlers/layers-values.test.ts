import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

// Audit P08: the handler runs on the shared psql runner (async spawn, SQL
// on stdin). The bridge routes each call into mockExec and appends the SQL
// as the last recorded arg.
const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", async () =>
  (await import("../db/psql-bridge.test-helper.js")).psqlChildProcessMock(
    mockExec,
  ),
);

import { createServer } from "../server.js";
import type { ApiServerConfig } from "../types.js";
import {
  MAP_LAYER_REGISTRY,
  SAFE_LAYER_ID_RE,
  _resetLayerValuesMemo,
} from "./layers-values.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "k",
  apiKey: "key",
  dbContainer: "test-db",
};
const AUTH = { "X-Api-Key": "key" };

beforeEach(() => {
  mockExec.mockReset();
  _resetLayerValuesMemo();
});
afterEach(() => vi.restoreAllMocks());

function lastSql(): string {
  const args = mockExec.mock.calls.at(-1)?.[1] as string[];
  return args[args.length - 1] ?? "";
}

describe("MAP_LAYER_REGISTRY contract (R1 audit pins)", () => {
  it("SESNSP-backed layers exclude catch-all 99[89] rows", () => {
    // Closure audit C1-coh: mv_delitos_municipal_yearly contains
    // XX998/XX999 catch-all rows that must be filtered.
    const sesnspLayers = ["homicidio_doloso_year", "total_delitos_year"];
    for (const id of sesnspLayers) {
      const def = MAP_LAYER_REGISTRY[id];
      expect(def, `layer ${id} missing`).toBeDefined();
      expect(def?.extra_where).toContain("NOT LIKE '%999'");
      expect(def?.extra_where).toContain("NOT LIKE '%998'");
    }
  });

  it("SESNSP year-aggregate layers exclude the partial current year", () => {
    // Closure audit W1-coh: 2026 is partial; AVG across all years
    // would bias downward.
    const sesnspLayers = ["homicidio_doloso_year", "total_delitos_year"];
    for (const id of sesnspLayers) {
      const def = MAP_LAYER_REGISTRY[id];
      expect(def?.extra_where).toMatch(/ano\s*<\s*EXTRACT/i);
    }
  });

  it("farmacias_controlados has been renamed to *_endorsements_*", () => {
    // Closure audit W6-coh: the sum-of-flags layer counts endorsements,
    // not distinct pharmacies; the name must reflect that.
    expect(MAP_LAYER_REGISTRY["farmacias_controlados"]).toBeUndefined();
    expect(
      MAP_LAYER_REGISTRY["farmacias_endorsements_controlados"],
    ).toBeDefined();
  });
});

describe("MAP_LAYER_REGISTRY", () => {
  it("every layer id matches the safe regex", () => {
    for (const id of Object.keys(MAP_LAYER_REGISTRY)) {
      expect(SAFE_LAYER_ID_RE.test(id)).toBe(true);
    }
  });

  it("every layer has a known grain", () => {
    for (const def of Object.values(MAP_LAYER_REGISTRY)) {
      expect(def.grain === "muni" || def.grain === "ageb").toBe(true);
    }
  });

  it("muni-grain layers use cve_mun as the key", () => {
    const muniLayers = Object.values(MAP_LAYER_REGISTRY).filter(
      (l) => l.grain === "muni",
    );
    for (const l of muniLayers) {
      expect(l.key_col).toBe("cve_mun");
    }
  });

  it("ageb-grain layers use cvegeo or cvegeo_ageb", () => {
    const agebLayers = Object.values(MAP_LAYER_REGISTRY).filter(
      (l) => l.grain === "ageb",
    );
    for (const l of agebLayers) {
      expect(["cvegeo", "cvegeo_ageb"]).toContain(l.key_col);
    }
  });
});

describe("GET /analytics/layers/values — input validation", () => {
  it("rejects missing grain", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?layers=pobreza_pct",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown grain", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=zip&layers=pobreza_pct",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects 0-layer or 4-layer requests", async () => {
    const app = createServer(CONFIG);
    const r0 = await app.request(
      "/analytics/layers/values?grain=muni&layers=",
      { headers: AUTH },
    );
    expect(r0.status).toBe(400);
    const r4 = await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct,irs_indice,farmacias_licenciadas,pobtot_muni",
      { headers: AUTH },
    );
    expect(r4.status).toBe(400);
  });

  it("rejects layer ids that don't match the safe regex", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=evil;DROP",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects unknown layer ids", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=not_a_real_layer",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects grain mismatch (ageb layer with grain=muni)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=pct_sin_cobertura_salud",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("rejects bad entidad values", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct&entidad=99",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
  });

  it("requires X-Api-Key", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct",
    );
    expect(res.status).toBe(401);
  });
});

describe("GET /analytics/layers/values — query execution (audit P05/P08)", () => {
  it("inlines the validated entidad literal; no :'var' and no -v entidad (#22/#33)", async () => {
    mockExec.mockReturnValue('{"09002":{"pobreza_pct":25.4}}');
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct&entidad=09",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const sql = lastSql();
    // psql never expands :'entidad' inside -c — the old SQL was a syntax
    // error on every entidad-scoped request.
    expect(sql).not.toContain(":'");
    expect(sql).toContain("LEFT(cve_mun, 2) = '09'");
    expect(args.slice(0, -1).some((a) => a.startsWith("entidad="))).toBe(
      false,
    );
    expect(args).not.toContain("-c");
  });

  it("statement_timeout reaches the container via docker exec -e (#94)", async () => {
    mockExec.mockReturnValue("{}");
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct",
      { headers: AUTH },
    );
    const args = mockExec.mock.calls[0]?.[1] as string[];
    const i = args.indexOf("-e");
    // X-Api-Key is the priority tier: 2x the 25 s default (psql-runner.ts).
    expect(args[i + 1]).toMatch(/^PGOPTIONS=.*statement_timeout=50000/);
  });

  it("requires entidad for grain=ageb (#25)", async () => {
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=ageb&layers=pobtot_ageb",
      { headers: AUTH },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("param.entidad_required_for_ageb");
    expect(mockExec).not.toHaveBeenCalled();
  });

  // EIC recon §3: the muni key universe decides which municipios can carry
  // values. censo_municipios dropped the 9 post-2020 keys (24059 Villa de
  // Pozos, ...). A revert to censo_municipios fails the exact-relation match.
  it("sources the muni key universe from municipios_2025, never censo_municipios", async () => {
    mockExec.mockReturnValue("{}");
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct&entidad=24",
      { headers: AUTH },
    );
    expect(lastSql()).toContain(
      "keys AS (SELECT DISTINCT cve_mun AS k FROM municipios_2025 WHERE LEFT(cve_mun, 2) = '24')",
    );
    expect(lastSql()).not.toMatch(/\bcenso_municipios\b/);
    mockExec.mockClear();
    await app.request(
      "/analytics/layers/values?grain=muni&layers=irs_indice",
      { headers: AUTH },
    );
    expect(lastSql()).toContain(
      "keys AS (SELECT DISTINCT cve_mun AS k FROM municipios_2025)",
    );
    expect(lastSql()).not.toMatch(/\bcenso_municipios\b/);
  });

  it("sources the AGEB key universe from cve_ent, no DISTINCT scan (#102)", async () => {
    mockExec.mockReturnValue("{}");
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=ageb&layers=pobtot_ageb&entidad=14",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    const sql = lastSql();
    expect(sql).toContain(
      "keys AS (SELECT cvegeo AS k FROM ageb_polygons WHERE cve_ent = '14')",
    );
    expect(sql).not.toContain("SELECT DISTINCT cvegeo");
  });

  it("returns the psql JSON as-is inside {grain, layers, values} (#102)", async () => {
    mockExec.mockReturnValue('{"09002":{"pobreza_pct":25.4,"irs_indice":null}}\n');
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct,irs_indice&entidad=09",
      { headers: AUTH },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    // #26: auth-gated payload must not be stored by a shared cache.
    expect(res.headers.get("vary")).toBe("Authorization, X-Api-Key");
    expect(await res.json()).toEqual({
      grain: "muni",
      layers: ["pobreza_pct", "irs_indice"],
      values: { "09002": { pobreza_pct: 25.4, irs_indice: null } },
    });
  });

  it("empty psql output yields values {}", async () => {
    mockExec.mockReturnValue("");
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct",
      { headers: AUTH },
    );
    expect(((await res.json()) as { values: unknown }).values).toEqual({});
  });

  it("memoizes per (grain, sorted layers, entidad) (#102)", async () => {
    mockExec.mockReturnValue('{"09002":{"pobreza_pct":1,"irs_indice":2}}');
    const app = createServer(CONFIG);
    const r1 = await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct,irs_indice&entidad=09",
      { headers: AUTH },
    );
    const r2 = await app.request(
      "/analytics/layers/values?grain=muni&layers=irs_indice,pobreza_pct&entidad=09",
      { headers: AUTH },
    );
    expect(mockExec).toHaveBeenCalledOnce();
    const b1 = (await r1.json()) as { layers: string[]; values: unknown };
    const b2 = (await r2.json()) as { layers: string[]; values: unknown };
    expect(b2.values).toEqual(b1.values);
    // The echoed layer list follows each request, not the cached one.
    expect(b2.layers).toEqual(["irs_indice", "pobreza_pct"]);
    // A different entidad is a different key.
    await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct,irs_indice&entidad=14",
      { headers: AUTH },
    );
    expect(mockExec).toHaveBeenCalledTimes(2);
  });

  it("psql failure → 502 postgres.error without psql text (#24)", async () => {
    mockExec.mockImplementation(() => {
      throw Object.assign(new Error("boom"), {
        stderr: 'ERROR:  syntax error at or near ":"\nLINE 1: ...FROM censo_municipios',
      });
    });
    const app = createServer(CONFIG);
    const res = await app.request(
      "/analytics/layers/values?grain=muni&layers=pobreza_pct&entidad=09",
      { headers: AUTH },
    );
    expect(res.status).toBe(502);
    const body = (await res.json()) as { code: string; error: string };
    expect(body.code).toBe("postgres.error");
    expect(body.error).not.toMatch(/syntax|LINE|censo/);
  });

  it("defunciones_total follows config.currentMortalityAno (#45)", async () => {
    mockExec.mockReturnValue("{}");
    const app = createServer({ ...CONFIG, currentMortalityAno: 2025 });
    await app.request(
      "/analytics/layers/values?grain=muni&layers=defunciones_total",
      { headers: AUTH },
    );
    expect(lastSql()).toContain("ano = 2025");
    expect(lastSql()).not.toContain("ano = 2024");
  });

  it("defunciones_total falls back to MORTALITY_DEFAULT_CURRENT_ANO (#45)", async () => {
    mockExec.mockReturnValue("{}");
    const app = createServer(CONFIG);
    await app.request(
      "/analytics/layers/values?grain=muni&layers=defunciones_total",
      { headers: AUTH },
    );
    expect(lastSql()).toContain("ano = 2024");
  });
});
