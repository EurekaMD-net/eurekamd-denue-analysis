// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { Map as MapInstance } from "maplibre-gl";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Importing the store pulls in the auth client.
vi.mock("../lib/supabase", () => ({ supabase: { auth: {} } }));

import { useUiStore } from "../store";
import {
  CorridorTool,
  CORRIDOR_LAYER_IDS,
  CORRIDOR_LINE_SOURCE_ID,
  DRAW_CURSOR_CLASS,
} from "./CorridorTool";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Map stand-in recording listener, double-click-zoom and layer calls. */
function fakeMap() {
  const canvas = document.createElement("canvas");
  const clicks = new Set<(e: unknown) => void>();
  const layers = new Set<string>();
  const sources = new Set<string>();
  let dblEnabled = true;
  const map = {
    style: { _loaded: true },
    getCanvas: () => canvas,
    doubleClickZoom: {
      isEnabled: () => dblEnabled,
      disable: vi.fn(() => {
        dblEnabled = false;
      }),
      enable: vi.fn(() => {
        dblEnabled = true;
      }),
    },
    on: vi.fn((ev: string, fn: (e: unknown) => void) => {
      if (ev === "click") clicks.add(fn);
    }),
    off: vi.fn((ev: string, fn: (e: unknown) => void) => {
      if (ev === "click") clicks.delete(fn);
    }),
    getSource: (id: string) =>
      sources.has(id) ? { setData: () => undefined } : undefined,
    addSource: (id: string) => sources.add(id),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: (spec: { id: string }) => layers.add(spec.id),
    moveLayer: () => undefined,
    removeLayer: (id: string) => layers.delete(id),
    removeSource: (id: string) => sources.delete(id),
  };
  return {
    map,
    canvas,
    layers,
    sources,
    click: (lng: number, lat: number) =>
      clicks.forEach((fn) => fn({ lngLat: { lng, lat } })),
    clickCount: () => clicks.size,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  useUiStore.getState().resetCorridor();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key, ...init }));
  });

describe("CorridorTool draw-mode lifecycle", () => {
  it("wires click/keys/cursor/dblclick on draw and tears every one down on exit", () => {
    const f = fakeMap();
    const addSpy = vi.spyOn(window, "addEventListener");
    const removeSpy = vi.spyOn(window, "removeEventListener");
    act(() => root.render(<CorridorTool map={f.map as unknown as MapInstance} />));
    act(() => useUiStore.getState().patchCorridor({ open: true, drawing: true }));

    expect(f.clickCount()).toBe(1);
    expect(f.map.doubleClickZoom.disable).toHaveBeenCalledTimes(1);
    expect(f.canvas.classList.contains(DRAW_CURSOR_CLASS)).toBe(true);
    const keyHandler = addSpy.mock.calls.find((c) => c[0] === "keydown")?.[1];
    expect(keyHandler).toBeTypeOf("function");

    f.click(-99.1234567, 19.4);
    f.click(-99.2, 19.5);
    expect(useUiStore.getState().corridor.points).toEqual([
      [-99.123457, 19.4],
      [-99.2, 19.5],
    ]);
    press("Backspace", { ctrlKey: true });
    expect(useUiStore.getState().corridor.points).toHaveLength(2);
    press("Backspace");
    expect(useUiStore.getState().corridor.points).toHaveLength(1);

    press("Escape");
    expect(useUiStore.getState().corridor.drawing).toBe(false);
    expect(f.map.off).toHaveBeenCalledWith("click", expect.any(Function));
    expect(f.clickCount()).toBe(0);
    expect(f.map.doubleClickZoom.enable).toHaveBeenCalledTimes(1);
    expect(f.canvas.classList.contains(DRAW_CURSOR_CLASS)).toBe(false);
    expect(removeSpy).toHaveBeenCalledWith("keydown", keyHandler);

    // Out of draw mode, keys and clicks no longer edit the corridor.
    press("Backspace");
    f.click(-99.3, 19.6);
    expect(useUiStore.getState().corridor.points).toHaveLength(1);
  });

  it("does not re-enable double-click zoom it did not disable", () => {
    const f = fakeMap();
    f.map.doubleClickZoom.disable();
    f.map.doubleClickZoom.disable.mockClear();
    act(() => root.render(<CorridorTool map={f.map as unknown as MapInstance} />));
    act(() => useUiStore.getState().patchCorridor({ open: true, drawing: true }));
    act(() => useUiStore.getState().patchCorridor({ drawing: false }));
    expect(f.map.doubleClickZoom.enable).not.toHaveBeenCalled();
  });

  it("adds layers only while open and removes them on close", () => {
    const f = fakeMap();
    act(() => root.render(<CorridorTool map={f.map as unknown as MapInstance} />));
    expect(f.layers.size).toBe(0);
    expect(f.sources.size).toBe(0);
    act(() => useUiStore.getState().patchCorridor({ open: true }));
    expect([...f.layers]).toEqual([...CORRIDOR_LAYER_IDS]);
    expect(f.sources.has(CORRIDOR_LINE_SOURCE_ID)).toBe(true);
    act(() => useUiStore.getState().resetCorridor());
    expect(f.layers.size).toBe(0);
    expect(f.sources.size).toBe(0);
  });
});
