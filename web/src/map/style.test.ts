import { describe, it, expect } from "vitest";
import {
  BASEMAP_STYLES,
  DEFAULT_BASEMAP,
  MEXICO_BOUNDS,
  MEXICO_CENTER,
  tileSourceUrl,
} from "./style";

describe("map/style", () => {
  it("exposes Carto Positron + Dark Matter URLs (no API key)", () => {
    expect(BASEMAP_STYLES.positron).toMatch(
      /^https:\/\/basemaps\.cartocdn\.com.*positron-gl-style.*style\.json$/,
    );
    expect(BASEMAP_STYLES.dark).toMatch(
      /^https:\/\/basemaps\.cartocdn\.com.*dark-matter-gl-style.*style\.json$/,
    );
    // No API key tokens in the URL — Carto's basemaps are key-free
    expect(BASEMAP_STYLES.positron).not.toMatch(/api[_-]?key/i);
    expect(BASEMAP_STYLES.dark).not.toMatch(/api[_-]?key/i);
  });

  it("default basemap is one of the registered styles", () => {
    expect(Object.keys(BASEMAP_STYLES)).toContain(DEFAULT_BASEMAP);
  });

  it("Mexico center is roughly correct (lat 19-25, lon -110 to -95)", () => {
    expect(MEXICO_CENTER.lat).toBeGreaterThan(19);
    expect(MEXICO_CENTER.lat).toBeLessThan(25);
    expect(MEXICO_CENTER.lon).toBeGreaterThan(-110);
    expect(MEXICO_CENTER.lon).toBeLessThan(-95);
    expect(MEXICO_CENTER.zoom).toBeGreaterThanOrEqual(4);
    expect(MEXICO_CENTER.zoom).toBeLessThanOrEqual(7);
  });

  it("Mexico bounds enclose CDMX (-99.13, 19.43)", () => {
    const [w, s, e, n] = MEXICO_BOUNDS;
    expect(w).toBeLessThan(-99.13);
    expect(e).toBeGreaterThan(-99.13);
    expect(s).toBeLessThan(19.43);
    expect(n).toBeGreaterThan(19.43);
  });

  describe("tileSourceUrl", () => {
    it("emits {z}/{x}/{y} placeholders for MapLibre to expand", () => {
      const url = tileSourceUrl({});
      expect(url).toBe("/api/tiles/{z}/{x}/{y}");
    });

    it("never URL-encodes the {z}/{x}/{y} placeholders", () => {
      const url = tileSourceUrl({ entidad: "09", sector: "46" });
      expect(url).toContain("{z}/{x}/{y}");
      expect(url).not.toContain("%7B");
      expect(url).not.toContain("%7D");
    });

    it("appends entidad and sector when set", () => {
      const url = tileSourceUrl({ entidad: "09", sector: "46" });
      expect(url).toMatch(/[?&]entidad=09(&|$)/);
      expect(url).toMatch(/[?&]sector=46(&|$)/);
    });

    it("omits filters that are null or empty string", () => {
      const url = tileSourceUrl({ entidad: null, sector: "" });
      expect(url).toBe("/api/tiles/{z}/{x}/{y}");
    });

    it("URL-encodes filter values defensively", () => {
      // ENTIDAD_RE is exact-match on the backend, so this never reaches
      // SQL — but the URL builder should still encode rather than emit
      // raw special chars that would confuse the parser.
      const url = tileSourceUrl({ entidad: "09 OR 1=1", sector: null });
      expect(url).toContain("entidad=09+OR+1%3D1");
    });

    it("does not emit api_key in the URL (header-injected separately)", () => {
      const url = tileSourceUrl({ entidad: "09", sector: "46" });
      expect(url).not.toMatch(/api[_-]?key/i);
    });
  });
});
