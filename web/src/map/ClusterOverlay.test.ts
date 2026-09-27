import { describe, it, expect } from "vitest";
import {
  attachClusterLayer,
  centroidsToGeoJSON,
  parseClustersResult,
  syncClusterLayer,
  CLUSTER_LAYER_ID,
  CLUSTER_SOURCE_ID,
} from "./ClusterOverlay";

const BODY = {
  entidad: "15",
  scian: "46",
  k: 2,
  centroids: [
    { cluster_id: 0, lon: -99.1, lat: 19.4, size: 400 },
    { cluster_id: 1, lon: -99.6, lat: 19.3, size: 100 },
  ],
};

/** In-memory stand-in for the MapLibre 5.x Map, modelled on its real
 * semantics: `style._loaded` flips when the style JSON is parsed (and
 * add/move calls throw before that), while `isStyleLoaded()` is also false
 * while any source still has tiles loading — e.g. right after MapShell's
 * 'load' handler adds its vector source, or while setTiles reloads. */
function fakeMap(styleJsonLoaded: boolean) {
  const sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  const layers = new Map<string, unknown>();
  const listeners = new Map<string, Set<() => void>>();
  const moved: string[] = [];
  const pendingTiles = new Set<string>();
  const style = { _loaded: styleJsonLoaded };
  const checkLoaded = () => {
    if (!style._loaded) throw new Error("Style is not done loading.");
  };
  const map = {
    style,
    isStyleLoaded: () => style._loaded && pendingTiles.size === 0,
    getSource: (id: string) => sources.get(id),
    addSource: (id: string, spec: { type: string; data?: unknown }) => {
      checkLoaded();
      const src = {
        data: spec.data,
        setData(d: unknown) {
          src.data = d;
        },
      };
      sources.set(id, src);
      if (spec.type === "vector") pendingTiles.add(id);
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (spec: { id: string }) => {
      checkLoaded();
      layers.set(spec.id, spec);
    },
    moveLayer: (id: string) => {
      checkLoaded();
      moved.push(id);
    },
    on: (ev: string, fn: () => void) => {
      if (!listeners.has(ev)) listeners.set(ev, new Set());
      listeners.get(ev)!.add(fn);
    },
    off: (ev: string, fn: () => void) => {
      listeners.get(ev)?.delete(fn);
    },
  };
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    map: map as any,
    sources,
    layers,
    moved,
    /** What MapShell's 'load' handler does before calling onMapLoad. */
    shellAddsVectorSource() {
      map.addSource("denue", { type: "vector" });
    },
    /** A setTiles reload / pan: tiles pending again. */
    tilesReloading() {
      pendingTiles.add("denue");
    },
    fire(ev: string) {
      // Real MapLibre: the style JSON is parsed before 'style.load' fires,
      // but sources are still loading tiles, so isStyleLoaded() is false.
      if (ev === "style.load") {
        style._loaded = true;
        sources.clear();
        layers.clear();
        pendingTiles.add("denue");
      }
      for (const fn of listeners.get(ev) ?? []) fn();
    },
    listenerCount: () =>
      [...listeners.values()].reduce((n, s) => n + s.size, 0),
  };
}

function drawnFeatures(f: ReturnType<typeof fakeMap>) {
  const data = f.sources.get(CLUSTER_SOURCE_ID)?.data as
    | GeoJSON.FeatureCollection
    | undefined;
  return data?.features ?? null;
}

describe("parseClustersResult (audit #101 contract)", () => {
  it("accepts the backend contract {entidad, scian, k, centroids:[{cluster_id, lon, lat, size}]}", () => {
    const r = parseClustersResult(BODY);
    expect(r.centroids).toHaveLength(2);
    expect(r.centroids[0]).toEqual({
      cluster_id: 0,
      lon: -99.1,
      lat: 19.4,
      size: 400,
    });
  });

  it("rejects the old clusters/member_clees shape", () => {
    expect(() =>
      parseClustersResult({
        entidad: "15",
        scian: "46",
        k: 2,
        clusters: [{ cluster_id: 0, member_clees: ["X"] }],
      }),
    ).toThrow();
  });
});

describe("centroidsToGeoJSON", () => {
  it("emits [lon, lat] points with size normalised to the largest cluster", () => {
    const fc = centroidsToGeoJSON(parseClustersResult(BODY).centroids);
    expect(fc.features.map((f) => f.geometry.coordinates)).toEqual([
      [-99.1, 19.4],
      [-99.6, 19.3],
    ]);
    expect(fc.features.map((f) => f.properties?.size_norm)).toEqual([1, 0.25]);
  });

  it("returns an empty collection for no centroids", () => {
    expect(centroidsToGeoJSON([]).features).toEqual([]);
  });
});

describe("syncClusterLayer", () => {
  it("adds a geojson source + circle layer once, then updates via setData", () => {
    const f = fakeMap(true);
    const cs = parseClustersResult(BODY).centroids;
    syncClusterLayer(f.map, cs);
    expect(f.layers.has(CLUSTER_LAYER_ID)).toBe(true);
    expect(drawnFeatures(f)).toHaveLength(2);
    syncClusterLayer(f.map, cs.slice(0, 1));
    expect(drawnFeatures(f)).toHaveLength(1);
    expect(f.layers.size).toBe(1);
  });

  it("keeps the cluster layer on top when it already exists", () => {
    const f = fakeMap(true);
    const cs = parseClustersResult(BODY).centroids;
    syncClusterLayer(f.map, cs);
    syncClusterLayer(f.map, cs);
    expect(f.moved).toEqual([CLUSTER_LAYER_ID]);
  });

  it("does nothing (and does not throw) while the style JSON is not loaded", () => {
    const f = fakeMap(false);
    syncClusterLayer(f.map, parseClustersResult(BODY).centroids);
    expect(f.sources.size).toBe(0);
  });

  it("updates to the new centroids while tiles are still reloading (sector change)", () => {
    const f = fakeMap(true);
    const cs = parseClustersResult(BODY).centroids;
    syncClusterLayer(f.map, cs);
    expect(drawnFeatures(f)).toHaveLength(2);
    f.tilesReloading();
    expect(f.map.isStyleLoaded()).toBe(false);
    syncClusterLayer(f.map, cs.slice(1));
    expect(drawnFeatures(f)).toHaveLength(1);
    expect(drawnFeatures(f)?.[0]?.properties?.cluster_id).toBe(1);
  });
});

describe("attachClusterLayer (audit #167)", () => {
  it("draws on the map MapShell hands over, while its vector source is still loading", () => {
    // MapShell's 'load' handler: addDataLayers (vector source) → onMapLoad.
    // 'load' has already fired and fires once, so nothing retries later.
    const f = fakeMap(true);
    f.shellAddsVectorSource();
    expect(f.map.isStyleLoaded()).toBe(false);
    attachClusterLayer(f.map, parseClustersResult(BODY).centroids);
    expect(f.layers.has(CLUSTER_LAYER_ID)).toBe(true);
    expect(drawnFeatures(f)).toHaveLength(2);
  });

  it("draws once the style JSON loads if attached before it", () => {
    const f = fakeMap(false);
    attachClusterLayer(f.map, parseClustersResult(BODY).centroids);
    expect(drawnFeatures(f)).toBeNull();
    f.fire("style.load");
    expect(f.map.isStyleLoaded()).toBe(false);
    expect(drawnFeatures(f)).toHaveLength(2);
  });

  it("redraws the unchanged centroids after a style swap wipes the layer", () => {
    const f = fakeMap(true);
    attachClusterLayer(f.map, parseClustersResult(BODY).centroids);
    expect(drawnFeatures(f)).toHaveLength(2);
    f.fire("style.load");
    expect(f.layers.has(CLUSTER_LAYER_ID)).toBe(true);
    expect(drawnFeatures(f)).toHaveLength(2);
  });

  it("cleanup removes its listeners", () => {
    const f = fakeMap(true);
    const off = attachClusterLayer(f.map, []);
    expect(f.listenerCount()).toBe(2);
    off();
    expect(f.listenerCount()).toBe(0);
  });
});
