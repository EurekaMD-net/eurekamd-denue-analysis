import { describe, it, expect } from "vitest";
import { extractCleeFromFeature } from "./MapShell";

describe("extractCleeFromFeature (audit S1)", () => {
  it("returns the CLEE when feature is well-formed", () => {
    const f = {
      properties: {
        clee: "06001114119000013102000000U6",
        nombre: "Farmacia",
      },
    };
    expect(extractCleeFromFeature(f)).toBe("06001114119000013102000000U6");
  });

  it("returns null for undefined feature (e.g. e.features[0] miss)", () => {
    expect(extractCleeFromFeature(undefined)).toBeNull();
  });

  it("returns null for null feature", () => {
    expect(extractCleeFromFeature(null)).toBeNull();
  });

  it("returns null when properties is missing", () => {
    expect(extractCleeFromFeature({})).toBeNull();
  });

  it("returns null when properties is null", () => {
    expect(extractCleeFromFeature({ properties: null })).toBeNull();
  });

  it("returns null when clee is non-string (numeric, object)", () => {
    expect(extractCleeFromFeature({ properties: { clee: 12345 } })).toBeNull();
    expect(
      extractCleeFromFeature({ properties: { clee: { x: 1 } } }),
    ).toBeNull();
  });

  it("returns null when clee is empty string", () => {
    expect(extractCleeFromFeature({ properties: { clee: "" } })).toBeNull();
  });

  it("ignores other properties + only reads clee", () => {
    const f = {
      properties: {
        clee: "ABC123",
        nombre: "garbage",
        latitud: 19.4,
      },
    };
    expect(extractCleeFromFeature(f)).toBe("ABC123");
  });

  it("returns null for non-object feature (string / number)", () => {
    expect(extractCleeFromFeature("not a feature")).toBeNull();
    expect(extractCleeFromFeature(42)).toBeNull();
  });
});
