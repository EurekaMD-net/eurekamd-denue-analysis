import { afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BivariateLegend,
  LEGEND_SCOPE_NOTE,
  layerDomain,
} from "./BivariateLegend";
import { quantileBreaks } from "../lib/quantiles";
import type { MapLayerSpec } from "../lib/map-layers";

const layer = (id: string): MapLayerSpec => ({
  id,
  label: `L-${id}`,
  grain: "muni",
  description: id,
});

const values: Record<string, Record<string, number | null>> = {
  "01001": { a: 5, b: 10, c: null },
  "01002": { a: 1, b: 30, c: 2 },
  "01003": { a: 9, b: 20, c: 4 },
  "01004": { a: null, b: 40, c: 8 },
  "01005": { a: 3, b: NaN, c: 6 },
};

describe("BivariateLegend copy (audit #174)", () => {
  it("makes no per-point RGB claim for three layers", () => {
    const html = renderToStaticMarkup(
      createElement(BivariateLegend, {
        layers: [layer("a"), layer("b"), layer("c")],
        values,
      }),
    );
    expect(html).not.toContain("RGB");
    expect(html).not.toContain("R: ");
    expect(html).toContain(LEGEND_SCOPE_NOTE);
  });

  it("says the map is not coloured for one and two layers too", () => {
    for (const layers of [[layer("a")], [layer("a"), layer("b")]]) {
      const html = renderToStaticMarkup(
        createElement(BivariateLegend, { layers, values }),
      );
      expect(html).toContain("no colorea el mapa");
    }
  });
});

describe("layerDomain (audit #175)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches quantileBreaks tertiles and min/max/n", () => {
    const d = layerDomain(values, "a");
    const expected = quantileBreaks(
      Object.values(values).map((p) => p["a"] ?? null),
      3,
    );
    expect(d.breaks).toEqual(expected);
    expect(d.min).toBe(1);
    expect(d.max).toBe(9);
    expect(d.n).toBe(4);
  });

  it("sorts the layer sample once, not twice", () => {
    const sort = vi.spyOn(Array.prototype, "sort");
    layerDomain(values, "b");
    expect(sort).toHaveBeenCalledTimes(1);
  });

  it("empty payload yields NaN breaks and n=0", () => {
    const d = layerDomain(undefined, "a");
    expect(d.n).toBe(0);
    expect(d.breaks.every((b) => Number.isNaN(b))).toBe(true);
  });
});
