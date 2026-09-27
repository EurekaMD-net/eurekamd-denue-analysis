import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createTransformRequest,
  extractCleeFromFeature,
  MAP_ATTRIBUTION,
  MapShell,
  snapshotView,
} from "./MapShell";

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

describe("createTransformRequest (audit #166)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads the token at request time, so a refresh needs no new map", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.test" } });
    let token: string | null = "jwt-old";
    const transform = createTransformRequest(() => token);
    const tile = "https://app.test/api/tiles/5/7/14.mvt";
    expect(transform(tile).headers).toEqual({
      Authorization: "Bearer jwt-old",
    });
    // Same transform instance (same map) picks up the refreshed token.
    token = "jwt-new";
    expect(transform(tile).headers).toEqual({
      Authorization: "Bearer jwt-new",
    });
  });

  it("never sends the token to a third-party origin", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.test" } });
    const transform = createTransformRequest(() => "jwt");
    expect(
      transform("https://basemaps.cartocdn.com/api/style.json"),
    ).toEqual({ url: "https://basemaps.cartocdn.com/api/style.json" });
  });

  it("sends no Authorization header without a session", () => {
    vi.stubGlobal("window", { location: { origin: "https://app.test" } });
    const transform = createTransformRequest(() => null);
    expect(transform("https://app.test/api/tiles/1/1/1.mvt").headers).toEqual(
      {},
    );
  });
});

describe("snapshotView (audit #166)", () => {
  it("captures center + zoom for the recreated map", () => {
    const map = {
      getCenter: () => ({ lng: -99.13, lat: 19.43 }),
      getZoom: () => 12.5,
    } as unknown as Parameters<typeof snapshotView>[0];
    expect(snapshotView(map)).toEqual({ center: [-99.13, 19.43], zoom: 12.5 });
  });
});

describe("MapShell attribution (audit #195)", () => {
  it("renders the Carto/OSM attribution as static React text", () => {
    const html = renderToStaticMarkup(
      createElement(MapShell, { basemap: "dark" }),
    );
    expect(html).toContain("© CARTO");
    expect(html).toContain("© OpenStreetMap");
    expect(MAP_ATTRIBUTION).toBe("© CARTO © OpenStreetMap");
  });
});
