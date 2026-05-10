import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer } from "../server.js";
import type { ApiServerConfig } from "../types.js";
import { MAP_LAYER_REGISTRY, SAFE_LAYER_ID_RE } from "./layers-values.js";

const CONFIG: ApiServerConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "k",
  apiKey: "key",
  dbContainer: "test-db",
};
const AUTH = { "X-Api-Key": "key" };

afterEach(() => vi.restoreAllMocks());

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
