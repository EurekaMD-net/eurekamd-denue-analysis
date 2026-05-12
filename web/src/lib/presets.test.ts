import { describe, expect, it } from "vitest";
import { LOCUST_PRESETS, validatePreset } from "./presets";

describe("LOCUST_PRESETS", () => {
  it("every preset passes catalog validation (no broken ids, no incompatible grains)", () => {
    for (const p of LOCUST_PRESETS) {
      const errors = validatePreset(p);
      expect(errors, `preset "${p.id}": ${errors.join("; ")}`).toEqual([]);
    }
  });

  it("preset ids are unique", () => {
    const ids = LOCUST_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("presets marked needsEntidad declare an exampleEntidad", () => {
    for (const p of LOCUST_PRESETS) {
      if (p.needsEntidad) {
        expect(p.exampleEntidad).toMatch(/^(0[1-9]|[12][0-9]|3[0-2])$/);
      }
    }
  });

  it("at least one preset is renderable without an entidad pre-selected", () => {
    const noEntidad = LOCUST_PRESETS.filter((p) => !p.needsEntidad);
    expect(noEntidad.length).toBeGreaterThan(0);
  });
});

describe("validatePreset", () => {
  it("rejects unknown X field", () => {
    const errors = validatePreset({
      id: "bad",
      title: "",
      description: "",
      x: "no.such.field",
      y: "denue.total_establecimientos",
    });
    expect(errors.some((e) => e.includes('X "no.such.field"'))).toBe(true);
  });

  it("rejects unreachable X (empty endpoints map)", () => {
    const errors = validatePreset({
      id: "bad",
      title: "",
      description: "",
      x: "sinba.casos_dm2_promedio", // endpoints: {} — no endpoint
      y: "coneval.pobreza_pct",
    });
    expect(errors.some((e) => e.includes("unreachable"))).toBe(true);
  });

  it("rejects Y that shares no endpoint with X", () => {
    const errors = validatePreset({
      id: "bad",
      title: "",
      description: "",
      x: "denue.entidad_nombre", // endpoint: national-treemap
      y: "clues.total", // endpoint: municipios — no overlap
    });
    expect(errors.some((e) => e.includes("shares no endpoint"))).toBe(true);
  });
});
