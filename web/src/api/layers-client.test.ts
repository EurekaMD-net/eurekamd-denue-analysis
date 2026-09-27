import { describe, expect, it } from "vitest";
import { layerValuesEnabled } from "./layers-client";

describe("layerValuesEnabled (audit #173)", () => {
  it("does not fire an ageb request without an entidad", () => {
    expect(layerValuesEnabled("tok", "ageb", ["pobtot_ageb"], null)).toBe(false);
  });

  it("fires an ageb request once an entidad is selected", () => {
    expect(layerValuesEnabled("tok", "ageb", ["pobtot_ageb"], "09")).toBe(true);
  });

  it("fires a muni request with or without an entidad", () => {
    expect(layerValuesEnabled("tok", "muni", ["a"], null)).toBe(true);
    expect(layerValuesEnabled("tok", "muni", ["a"], "09")).toBe(true);
  });

  it("keeps the token and 1-3 layer bounds", () => {
    expect(layerValuesEnabled(null, "muni", ["a"], "09")).toBe(false);
    expect(layerValuesEnabled("tok", "muni", [], "09")).toBe(false);
    expect(layerValuesEnabled("tok", "muni", ["a", "b", "c", "d"], "09")).toBe(false);
  });
});
