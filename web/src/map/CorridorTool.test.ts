import { beforeEach, describe, expect, it, vi } from "vitest";

// Importing the store pulls in the auth client.
vi.mock("../lib/supabase", () => ({ supabase: { auth: {} } }));

import { INITIAL_CORRIDOR, useUiStore } from "../store";
import {
  attachCorridorLayers,
  corridorBufferGeoJSON,
  corridorKeyAction,
  corridorLineGeoJSON,
  isEditableTarget,
  removeCorridorLayers,
  roundPosition,
  syncCorridorLayers,
  CORRIDOR_BUFFER_FILL_ID,
  CORRIDOR_BUFFER_SOURCE_ID,
  CORRIDOR_LAYER_IDS,
  CORRIDOR_LINE_SOURCE_ID,
} from "./CorridorTool";
import type { CorridorResult, Position } from "../api/corridor-types";

const A: Position = [-99.1735, 19.4326];
const B: Position = [-99.165, 19.427];
const C: Position = [-99.16, 19.425];

/** Same in-memory MapLibre stand-in as ClusterOverlay.test: add/move
 * throw until the style JSON is parsed. */
function fakeMap(styleJsonLoaded: boolean) {
  const sources = new Map<string, { data: unknown; setData: (d: unknown) => void }>();
  const layers = new Map<string, { id: string; type: string; source: string }>();
  const listeners = new Map<string, Set<() => void>>();
  const moved: string[] = [];
  const style = { _loaded: styleJsonLoaded };
  const checkLoaded = () => {
    if (!style._loaded) throw new Error("Style is not done loading.");
  };
  const map = {
    style,
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
    },
    getLayer: (id: string) => layers.get(id),
    addLayer: (spec: { id: string; type: string; source: string }) => {
      checkLoaded();
      layers.set(spec.id, spec);
    },
    moveLayer: (id: string) => {
      checkLoaded();
      moved.push(id);
    },
    removeLayer: (id: string) => {
      checkLoaded();
      layers.delete(id);
    },
    removeSource: (id: string) => {
      checkLoaded();
      if ([...layers.values()].some((l) => l.source === id))
        throw new Error(`Source "${id}" cannot be removed while layer uses it.`);
      sources.delete(id);
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
    map,
    sources,
    layers,
    moved,
    fire: (ev: string) => listeners.get(ev)?.forEach((fn) => fn()),
    listenerCount: () =>
      [...listeners.values()].reduce((n, s) => n + s.size, 0),
    finishStyle: () => {
      style._loaded = true;
    },
  };
}

type SyncMap = Parameters<typeof syncCorridorLayers>[0];

const RESULT: CorridorResult = {
  length_m: 1000,
  buffer_m: 100,
  total: 3,
  per_km: 3,
  by_clase: [],
  buffer_geojson: {
    type: "Polygon",
    coordinates: [
      [
        [-99.17, 19.43],
        [-99.16, 19.43],
        [-99.16, 19.42],
        [-99.17, 19.43],
      ],
    ],
  },
};

describe("corridorLineGeoJSON", () => {
  it("one vertex → a dot, no line", () => {
    const fc = corridorLineGeoJSON([A], null);
    expect(fc.features.map((f) => f.geometry.type)).toEqual(["Point"]);
  });

  it("≥ 2 vertices → LineString first, then one Point per vertex", () => {
    const fc = corridorLineGeoJSON([A, B, C], null);
    expect(fc.features.map((f) => f.geometry.type)).toEqual([
      "LineString",
      "Point",
      "Point",
      "Point",
    ]);
    expect((fc.features[0]!.geometry as GeoJSON.LineString).coordinates).toEqual([
      A,
      B,
      C,
    ]);
  });

  it("a loaded street wins: one MultiLineString, no vertex dots", () => {
    const fc = corridorLineGeoJSON([A], [[A, B], [B, C]]);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]!.geometry.type).toBe("MultiLineString");
  });
});

describe("corridorBufferGeoJSON", () => {
  it("empty without a result or a buffer", () => {
    expect(corridorBufferGeoJSON(null).features).toHaveLength(0);
    expect(
      corridorBufferGeoJSON({ ...RESULT, buffer_geojson: null }).features,
    ).toHaveLength(0);
  });

  it("wraps the API polygon as a feature", () => {
    const fc = corridorBufferGeoJSON(RESULT);
    expect(fc.features[0]!.geometry.type).toBe("Polygon");
  });
});

describe("syncCorridorLayers / attachCorridorLayers", () => {
  it("no-ops before the style JSON is parsed", () => {
    const f = fakeMap(false);
    expect(() =>
      syncCorridorLayers(
        f.map as unknown as SyncMap,
        corridorLineGeoJSON([A, B], null),
        corridorBufferGeoJSON(RESULT),
      ),
    ).not.toThrow();
    expect(f.sources.size).toBe(0);
  });

  it("adds 2 sources + 4 layers once, then updates data and keeps them on top", () => {
    const f = fakeMap(true);
    const m = f.map as unknown as SyncMap;
    syncCorridorLayers(m, corridorLineGeoJSON([A, B], null), corridorBufferGeoJSON(null));
    expect([...f.sources.keys()].sort()).toEqual(
      [CORRIDOR_BUFFER_SOURCE_ID, CORRIDOR_LINE_SOURCE_ID].sort(),
    );
    expect([...f.layers.keys()]).toEqual([...CORRIDOR_LAYER_IDS]);
    expect(f.layers.get(CORRIDOR_BUFFER_FILL_ID)?.type).toBe("fill");

    syncCorridorLayers(m, corridorLineGeoJSON([A, B, C], null), corridorBufferGeoJSON(RESULT));
    expect(f.layers.size).toBe(4);
    expect(f.moved).toEqual([...CORRIDOR_LAYER_IDS]);
    const buf = f.sources.get(CORRIDOR_BUFFER_SOURCE_ID)!.data as GeoJSON.FeatureCollection;
    expect(buf.features).toHaveLength(1);
  });

  it("a null buffer (> 500 vertices) paints no fill: the buffer source is emptied", () => {
    const f = fakeMap(true);
    const m = f.map as unknown as SyncMap;
    syncCorridorLayers(m, corridorLineGeoJSON([A, B], null), corridorBufferGeoJSON(RESULT));
    syncCorridorLayers(
      m,
      corridorLineGeoJSON([A, B], null),
      corridorBufferGeoJSON({ ...RESULT, buffer_geojson: null }),
    );
    const buf = f.sources.get(CORRIDOR_BUFFER_SOURCE_ID)!.data as GeoJSON.FeatureCollection;
    expect(buf.features).toHaveLength(0);
  });

  it("removeCorridorLayers drops all 4 layers + 2 sources, idempotently", () => {
    const f = fakeMap(true);
    const m = f.map as unknown as SyncMap;
    syncCorridorLayers(m, corridorLineGeoJSON([A, B], null), corridorBufferGeoJSON(RESULT));
    removeCorridorLayers(m);
    expect(f.layers.size).toBe(0);
    expect(f.sources.size).toBe(0);
    expect(() => removeCorridorLayers(m)).not.toThrow();
    expect(() => removeCorridorLayers(fakeMap(false).map as unknown as SyncMap)).not.toThrow();
  });

  it("draws once the style loads and detaches its listeners", () => {
    const f = fakeMap(false);
    const detach = attachCorridorLayers(
      f.map as unknown as SyncMap,
      corridorLineGeoJSON([A, B], null),
      corridorBufferGeoJSON(null),
    );
    expect(f.layers.size).toBe(0);
    f.finishStyle();
    f.fire("style.load");
    expect(f.layers.size).toBe(4);
    detach();
    expect(f.listenerCount()).toBe(0);
  });
});

describe("draw-mode keymap", () => {
  const div = { tagName: "DIV", isContentEditable: false } as unknown as EventTarget;
  const input = { tagName: "INPUT", isContentEditable: false } as unknown as EventTarget;
  const editable = { tagName: "DIV", isContentEditable: true } as unknown as EventTarget;
  const ev = (key: string, target: EventTarget | null = div, mods: Partial<KeyboardEvent> = {}) => ({
    key,
    target,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...mods,
  });

  it("Backspace pops, Escape exits, other keys ignored", () => {
    expect(corridorKeyAction(ev("Backspace"), true)).toBe("pop");
    expect(corridorKeyAction(ev("Escape"), true)).toBe("exit");
    expect(corridorKeyAction(ev("Enter"), true)).toBeNull();
  });

  it("does nothing outside draw mode", () => {
    expect(corridorKeyAction(ev("Backspace"), false)).toBeNull();
    expect(corridorKeyAction(ev("Escape", null), false)).toBeNull();
  });

  it("ignores Backspace with a modifier", () => {
    expect(corridorKeyAction(ev("Backspace", div, { ctrlKey: true }), true)).toBeNull();
    expect(corridorKeyAction(ev("Backspace", div, { metaKey: true }), true)).toBeNull();
    expect(corridorKeyAction(ev("Backspace", div, { altKey: true }), true)).toBeNull();
  });

  it("leaves keys typed into form controls alone", () => {
    expect(isEditableTarget(input)).toBe(true);
    expect(isEditableTarget(editable)).toBe(true);
    expect(isEditableTarget(div)).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(corridorKeyAction(ev("Backspace", input), true)).toBeNull();
  });
});

describe("roundPosition", () => {
  it("rounds to 6 decimals", () => {
    expect(roundPosition(-99.123456789, 19.987654321)).toEqual([-99.123457, 19.987654]);
  });
});

describe("store slice `corridor`", () => {
  beforeEach(() => useUiStore.getState().resetCorridor());

  it("appends and pops vertices", () => {
    const s = useUiStore.getState();
    s.addCorridorPoint(A);
    s.addCorridorPoint(B);
    expect(useUiStore.getState().corridor.points).toEqual([A, B]);
    s.popCorridorPoint();
    s.popCorridorPoint();
    s.popCorridorPoint(); // no-op on empty
    expect(useUiStore.getState().corridor.points).toEqual([]);
  });

  it("caps drawn vertices at the API limit (5000)", () => {
    const pts = Array.from({ length: 5000 }, (_, i): Position => [-99 + i * 1e-5, 19.4]);
    useUiStore.getState().patchCorridor({ points: pts });
    useUiStore.getState().addCorridorPoint(A);
    expect(useUiStore.getState().corridor.points).toHaveLength(5000);
  });

  it("a street replaces the drawn line and leaves draw mode; a new click starts over", () => {
    const s = useUiStore.getState();
    s.patchCorridor({ drawing: true });
    s.addCorridorPoint(A);
    s.setCorridorStreet("Paseo de la Reforma", [[A, B]]);
    let c = useUiStore.getState().corridor;
    expect(c.points).toEqual([]);
    expect(c.streetLines).toEqual([[A, B]]);
    expect(c.drawing).toBe(false);
    s.addCorridorPoint(C);
    c = useUiStore.getState().corridor;
    expect(c.streetLines).toBeNull();
    expect(c.streetName).toBeNull();
    expect(c.points).toEqual([C]);
  });

  it("clear drops geometry + result but keeps buffer/prefix; sign-out resets all", async () => {
    const s = useUiStore.getState();
    s.patchCorridor({ open: true, bufferM: 250, clasePrefix: "46", result: RESULT, status: "ok" });
    s.addCorridorPoint(A);
    s.clearCorridor();
    const c = useUiStore.getState().corridor;
    expect(c.points).toEqual([]);
    expect(c.result).toBeNull();
    expect(c.status).toBe("idle");
    expect(c.bufferM).toBe(250);
    expect(c.clasePrefix).toBe("46");
    expect(c.open).toBe(true);

    s.patchCorridor({ result: RESULT });
    await useUiStore.getState().cleanupLocal();
    expect(useUiStore.getState().corridor).toEqual(INITIAL_CORRIDOR);
  });
});
