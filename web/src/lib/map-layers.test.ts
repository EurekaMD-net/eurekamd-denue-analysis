import { describe, it, expect } from "vitest";
import { MAP_LAYERS, findLayer, layersForGrain } from "./map-layers";

describe("MAP_LAYERS (frontend mirror of backend registry)", () => {
  it("has unique ids", () => {
    const ids = MAP_LAYERS.map((l) => l.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("layersForGrain filters cleanly", () => {
    const muniLayers = layersForGrain("muni");
    expect(muniLayers.length).toBeGreaterThan(0);
    for (const l of muniLayers) {
      expect(l.grain).toBe("muni");
    }
  });

  it("findLayer is symmetric with MAP_LAYERS", () => {
    for (const l of MAP_LAYERS) {
      expect(findLayer(l.id)).toEqual(l);
    }
  });

  it("R1 audit pin — farmacias_controlados renamed to *_endorsements_*", () => {
    expect(findLayer("farmacias_controlados")).toBeUndefined();
    expect(findLayer("farmacias_endorsements_controlados")).toBeDefined();
  });
});
