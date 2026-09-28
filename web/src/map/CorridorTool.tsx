import { useEffect, useMemo } from "react";
import type { Map as MapInstance, MapMouseEvent } from "maplibre-gl";
import { useUiStore } from "../store";
import type { CorridorResult, Position } from "../api/corridor-types";

/**
 * Corridor draw tool + its map layers (plan CORRIDOR-DENSITY P3).
 *
 * Draw mode: each map click appends a vertex, Backspace removes the last,
 * Esc leaves draw mode. The polyline (drawn vertices or a loaded street),
 * its vertices and the API's `buffer_geojson` paint as MapLibre GeoJSON
 * layers, the same mechanism as ClusterOverlay. deck.gl was the plan's
 * first pick (PathLayer + GeoJsonLayer) but nothing in the app mounts
 * deck.gl today: its PathLayer + GeoJsonLayer + MapboxOverlay minify to
 * ~735 kB (~211 kB gzip), +68 % on the MapMode chunk, for one line and
 * one polygon that MapLibre's line/fill layers draw natively.
 *
 * Renders nothing in the DOM.
 */

export const CORRIDOR_BUFFER_SOURCE_ID = "corridor-buffer";
export const CORRIDOR_LINE_SOURCE_ID = "corridor-line";
export const CORRIDOR_BUFFER_FILL_ID = "corridor-buffer-fill";
export const CORRIDOR_BUFFER_OUTLINE_ID = "corridor-buffer-outline";
export const CORRIDOR_LINE_LAYER_ID = "corridor-line";
export const CORRIDOR_VERTEX_LAYER_ID = "corridor-vertices";

/** Layer ids in paint order (bottom → top). */
export const CORRIDOR_LAYER_IDS = [
  CORRIDOR_BUFFER_FILL_ID,
  CORRIDOR_BUFFER_OUTLINE_ID,
  CORRIDOR_LINE_LAYER_ID,
  CORRIDOR_VERTEX_LAYER_ID,
] as const;

const EMPTY: GeoJSON.FeatureCollection = {
  type: "FeatureCollection",
  features: [],
};

/** Drawn vertices (LineString + Point per vertex) or a loaded street
 * (MultiLineString, no vertex dots). */
export function corridorLineGeoJSON(
  points: Position[],
  streetLines: Position[][] | null,
): GeoJSON.FeatureCollection {
  if (streetLines && streetLines.length > 0) {
    return {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "MultiLineString", coordinates: streetLines },
          properties: {},
        },
      ],
    };
  }
  const features: GeoJSON.Feature[] = points.map((p, i) => ({
    type: "Feature",
    geometry: { type: "Point", coordinates: p },
    properties: { idx: i },
  }));
  if (points.length >= 2) {
    features.unshift({
      type: "Feature",
      geometry: { type: "LineString", coordinates: points },
      properties: {},
    });
  }
  return { type: "FeatureCollection", features };
}

export function corridorBufferGeoJSON(
  result: CorridorResult | null,
): GeoJSON.FeatureCollection {
  const g = result?.buffer_geojson;
  if (!g) return EMPTY;
  return {
    type: "FeatureCollection",
    features: [
      { type: "Feature", geometry: g as unknown as GeoJSON.Geometry, properties: {} },
    ],
  };
}

/** Minimal slice of the MapLibre Map API the layer sync touches. */
type CorridorMap = Pick<
  MapInstance,
  | "style"
  | "getSource"
  | "addSource"
  | "getLayer"
  | "addLayer"
  | "moveLayer"
  | "removeLayer"
  | "removeSource"
  | "on"
  | "off"
>;

type GeoJsonSource = { setData: (d: GeoJSON.FeatureCollection) => void };

function setSourceData(
  map: CorridorMap,
  id: string,
  data: GeoJSON.FeatureCollection,
): void {
  const src = map.getSource(id) as GeoJsonSource | undefined;
  if (src) src.setData(data);
  else map.addSource(id, { type: "geojson", data });
}

/**
 * Ensures the corridor sources + layers exist and carry `line`/`buffer`.
 * No-op until the style JSON is parsed (see ClusterOverlay.styleReady).
 * Moves the layers to the top every call: MapShell re-adds its data
 * layers on a filter change.
 */
export function syncCorridorLayers(
  map: CorridorMap,
  line: GeoJSON.FeatureCollection,
  buffer: GeoJSON.FeatureCollection,
): void {
  if (map.style?._loaded !== true) return;
  setSourceData(map, CORRIDOR_BUFFER_SOURCE_ID, buffer);
  setSourceData(map, CORRIDOR_LINE_SOURCE_ID, line);
  if (!map.getLayer(CORRIDOR_BUFFER_FILL_ID)) {
    map.addLayer({
      id: CORRIDOR_BUFFER_FILL_ID,
      type: "fill",
      source: CORRIDOR_BUFFER_SOURCE_ID,
      paint: { "fill-color": "#f59e0b", "fill-opacity": 0.18 }, // amber-500
    });
    map.addLayer({
      id: CORRIDOR_BUFFER_OUTLINE_ID,
      type: "line",
      source: CORRIDOR_BUFFER_SOURCE_ID,
      paint: { "line-color": "#fbbf24", "line-width": 1, "line-opacity": 0.7 },
    });
    map.addLayer({
      id: CORRIDOR_LINE_LAYER_ID,
      type: "line",
      source: CORRIDOR_LINE_SOURCE_ID,
      filter: ["!=", ["geometry-type"], "Point"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#fde047", "line-width": 3 }, // yellow-300
    });
    map.addLayer({
      id: CORRIDOR_VERTEX_LAYER_ID,
      type: "circle",
      source: CORRIDOR_LINE_SOURCE_ID,
      filter: ["==", ["geometry-type"], "Point"],
      paint: {
        "circle-radius": 4,
        "circle-color": "#0f172a",
        "circle-stroke-color": "#fde047",
        "circle-stroke-width": 2,
      },
    });
  } else {
    for (const id of CORRIDOR_LAYER_IDS) map.moveLayer(id);
  }
}

/** Removes the corridor layers + sources (tool closed). Idempotent. */
export function removeCorridorLayers(map: CorridorMap): void {
  if (map.style?._loaded !== true) return;
  for (const id of [...CORRIDOR_LAYER_IDS].reverse()) {
    if (map.getLayer(id)) map.removeLayer(id);
  }
  for (const id of [CORRIDOR_LINE_SOURCE_ID, CORRIDOR_BUFFER_SOURCE_ID]) {
    if (map.getSource(id)) map.removeSource(id);
  }
}

/** Sync now and on every 'load' / 'style.load' (basemap swap recreates
 * the map; data may land before the style). Returns the cleanup. */
export function attachCorridorLayers(
  map: CorridorMap,
  line: GeoJSON.FeatureCollection,
  buffer: GeoJSON.FeatureCollection,
): () => void {
  const apply = () => syncCorridorLayers(map, line, buffer);
  apply();
  map.on("load", apply);
  map.on("style.load", apply);
  return () => {
    map.off("load", apply);
    map.off("style.load", apply);
  };
}

/** Keys typed into a form control belong to that control, not the tool. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!t || typeof (t as HTMLElement).tagName !== "string") return false;
  const el = t as HTMLElement;
  return (
    el.isContentEditable === true ||
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

export type CorridorKeyAction = "pop" | "exit" | null;

export type CorridorKeyEvent = Pick<
  KeyboardEvent,
  "key" | "target" | "ctrlKey" | "metaKey" | "altKey"
>;

/** Draw-mode keymap: Backspace → drop last vertex, Escape → leave draw
 * mode. Ignored outside draw mode, inside form controls, and for
 * Backspace with a modifier (browser/OS shortcuts). */
export function corridorKeyAction(
  e: CorridorKeyEvent,
  drawing: boolean,
): CorridorKeyAction {
  if (!drawing || isEditableTarget(e.target)) return null;
  if (e.key === "Backspace")
    return e.ctrlKey || e.metaKey || e.altKey ? null : "pop";
  if (e.key === "Escape") return "exit";
  return null;
}

/** `!important` beats the inline cursor MapShell's circle-layer
 * mouseenter/mouseleave handlers write, so the crosshair survives
 * hovering a point while drawing. */
export const DRAW_CURSOR_CLASS = "!cursor-crosshair";

/** 6 dp (~0.1 m): what the API rounds to anyway, and keeps bodies small. */
export function roundPosition(lng: number, lat: number): Position {
  return [Math.round(lng * 1e6) / 1e6, Math.round(lat * 1e6) / 1e6];
}

export function CorridorTool({ map }: { map: MapInstance | null }) {
  const open = useUiStore((s) => s.corridor.open);
  const drawing = useUiStore((s) => s.corridor.drawing);
  const points = useUiStore((s) => s.corridor.points);
  const streetLines = useUiStore((s) => s.corridor.streetLines);
  const result = useUiStore((s) => s.corridor.result);

  const line = useMemo(
    () => corridorLineGeoJSON(points, streetLines),
    [points, streetLines],
  );
  const buffer = useMemo(() => corridorBufferGeoJSON(result), [result]);

  // Layers exist only while the tool is open; closing removes them.
  useEffect(() => {
    if (!map) return;
    if (!open) {
      removeCorridorLayers(map);
      return;
    }
    return attachCorridorLayers(map, line, buffer);
  }, [map, open, line, buffer]);

  // Draw mode: clicks append vertices; double-click zoom off so a quick
  // double click does not zoom as well; crosshair cursor.
  useEffect(() => {
    if (!map || !drawing) return;
    const onClick = (e: MapMouseEvent) => {
      useUiStore
        .getState()
        .addCorridorPoint(roundPosition(e.lngLat.lng, e.lngLat.lat));
    };
    const canvas = map.getCanvas();
    canvas.classList.add(DRAW_CURSOR_CLASS);
    const dblZoom = map.doubleClickZoom.isEnabled();
    map.doubleClickZoom.disable();
    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
      canvas.classList.remove(DRAW_CURSOR_CLASS);
      if (dblZoom) map.doubleClickZoom.enable();
    };
  }, [map, drawing]);

  useEffect(() => {
    if (!drawing) return;
    const onKey = (e: KeyboardEvent) => {
      const action = corridorKeyAction(e, true);
      if (!action) return;
      e.preventDefault();
      const st = useUiStore.getState();
      if (action === "pop") st.popCorridorPoint();
      else st.patchCorridor({ drawing: false });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawing]);

  return null;
}
