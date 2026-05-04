import { useEffect, useRef } from "react";
import maplibregl, { type Map as MapInstance } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useUiStore } from "../store";
import {
  BASEMAP_STYLES,
  MEXICO_CENTER,
  tileSourceUrl,
  type BasemapStyle,
} from "./style";

interface Props {
  basemap: BasemapStyle;
  /** Must be a referentially stable callback (e.g. useState setter) — the
   * map remounts whenever this prop identity changes. */
  onMapLoad?: (map: MapInstance) => void;
  /** Must be a referentially stable callback. See onMapLoad. */
  onPointClick?: (clee: string) => void;
}

const SOURCE_ID = "denue-mvt";
const SOURCE_LAYER = "establecimientos";
const HEATMAP_LAYER_ID = "denue-heatmap";
const CIRCLE_LAYER_ID = "denue-circles";

/**
 * Pure helper extracted from the click handler so it can be unit-tested
 * without a MapLibre canvas. Returns the CLEE string from a clicked
 * feature, or null if any link in the chain is missing/invalid.
 *
 * Audit S1 — exposed for `MapShell.test.ts` to cover the missing-feature
 * + non-string-clee + undefined-properties paths without instantiating
 * a map.
 */
export function extractCleeFromFeature(feature: unknown): string | null {
  if (!feature || typeof feature !== "object") return null;
  const props = (feature as { properties?: unknown }).properties;
  if (!props || typeof props !== "object") return null;
  const clee = (props as Record<string, unknown>)["clee"];
  return typeof clee === "string" && clee.length > 0 ? clee : null;
}

/**
 * MapLibre canvas + DENUE MVT vector source + density layers.
 *
 * Two render modes stacked:
 *   - heatmap (visible at zoom < 12) — KDE-style density of all points
 *   - circles (visible at zoom ≥ 12) — individual establishments, each
 *     clickable to fire `onPointClick(clee)`
 *
 * Filter changes (entidad/sector via Zustand) rebuild the source URL
 * and force MapLibre to refetch tiles. Basemap toggle (positron/dark)
 * tears down + recreates the map instance to swap the style cleanly,
 * because re-applying setStyle without preserving data layers is fragile
 * across MapLibre versions.
 */
export function MapShell({ basemap, onMapLoad, onPointClick }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapInstance | null>(null);
  const apiKey = useUiStore((s) => s.apiKey);
  const entidad = useUiStore((s) => s.entidad);
  const sector = useUiStore((s) => s.sector);

  // Refs that mirror the latest filter values for the async map.on("load")
  // callback. Without these, the load callback closes over the entidad/
  // sector from the FIRST render — typically null/null because useUrlSync
  // hasn't pushed URL params into Zustand yet. When load eventually fires
  // it adds layers with the stale values, and the filter useEffect never
  // re-runs because deps haven't changed since its last (bailed) attempt.
  // Result before this fix: dots never appear after a hard refresh on
  // /map?sector=NN, even though Zustand has the right value.
  const entidadRef = useRef(entidad);
  const sectorRef = useRef(sector);
  entidadRef.current = entidad;
  sectorRef.current = sector;

  // (Re)create the map whenever the basemap toggles. Cleanup on unmount.
  useEffect(() => {
    if (!containerRef.current) return;
    if (mapRef.current) {
      mapRef.current.remove();
      mapRef.current = null;
    }
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: BASEMAP_STYLES[basemap],
      center: [MEXICO_CENTER.lon, MEXICO_CENTER.lat],
      zoom: MEXICO_CENTER.zoom,
      maxZoom: 17,
      minZoom: 3,
      attributionControl: { compact: true },
      // Inject X-Api-Key on every tile fetch hitting our backend. Other
      // requests (basemap tiles to Carto) pass through unchanged.
      // Audit W1 fix: short-circuit when no key is set so we don't
      // silently 401 every tile with an empty header. Audit S3 fix:
      // dropped redundant URL.includes("/api/tiles/") clause (subset).
      transformRequest: (url, _resourceType) => {
        if (!url.startsWith("/api/")) return { url };
        if (!apiKey) {
          // No key = no point firing the request. Backend would 401
          // every tile and the user would see a blank map with no
          // signal. Better to skip until ApiKeyGate sets a key, which
          // bumps the dep array and recreates the map with auth.
          console.warn("[map] skipping tile fetch — no API key set");
          return { url, headers: {} };
        }
        return { url, headers: { "X-Api-Key": apiKey } };
      },
    });
    mapRef.current = map;

    map.addControl(new maplibregl.NavigationControl(), "top-right");
    map.addControl(new maplibregl.ScaleControl(), "bottom-left");

    // Audit W4 fix: register click/hover handlers inside the load
    // callback after layers exist. MapLibre tolerates listeners on
    // unknown layer IDs (they simply never fire), but registering them
    // post-load makes the intent explicit and survives future MapLibre
    // changes that might tighten that tolerance.
    map.on("load", () => {
      // Read filter values from refs — see comment on entidadRef above.
      // This call uses the LATEST filter state, not the closure-captured
      // values from when the map was created.
      const liveFilters = {
        entidad: entidadRef.current,
        sector: sectorRef.current,
      };
      addDataLayers(map, liveFilters);
      if (onPointClick) {
        map.on("click", CIRCLE_LAYER_ID, (e) => {
          const features = e.features ?? [];
          const clee = extractCleeFromFeature(features[0]);
          if (clee) onPointClick(clee);
        });
        map.on("mouseenter", CIRCLE_LAYER_ID, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", CIRCLE_LAYER_ID, () => {
          map.getCanvas().style.cursor = "";
        });
      }
      onMapLoad?.(map);
    });

    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [basemap, apiKey, onMapLoad, onPointClick]);
  // ^ apiKey change forces re-create so transformRequest closes over fresh key

  // Filter changes: rebuild the source URL without remounting the map,
  // and shift the layer zoom ranges so dots are visible immediately
  // when the user filters by entidad or sector.
  //
  // Why the zoom shift: unfiltered, the tile feature cap (50k/tile) at
  // zoom 5 would paint a country-wide blob of cyan circles — ugly. So
  // circles stay hidden until zoom 11 (street-level). But once a filter
  // is active the dataset is much smaller, so circles become readable
  // at any zoom and the heatmap can fade out earlier to let them
  // dominate. Without this, "select a sector" looks like it does
  // nothing at the default Mexico-overview zoom.
  //
  // Audit W2 fix: setTiles is not part of the MapLibre public TypeScript
  // surface — fall back to remove+re-add the source + layers when it's
  // unavailable, so a future MapLibre patch that drops the private
  // method doesn't silently freeze filter cascades.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!map.getSource(SOURCE_ID)) return;
    const url = tileSourceUrl({ entidad, sector });
    const src = map.getSource(SOURCE_ID) as unknown as {
      setTiles?: (tiles: string[]) => void;
    };
    if (typeof src.setTiles === "function") {
      src.setTiles([url]);
    } else {
      // Fallback: tear down + re-add. Slightly heavier but version-stable.
      if (map.getLayer(CIRCLE_LAYER_ID)) map.removeLayer(CIRCLE_LAYER_ID);
      if (map.getLayer(HEATMAP_LAYER_ID)) map.removeLayer(HEATMAP_LAYER_ID);
      map.removeSource(SOURCE_ID);
      addDataLayers(map, { entidad, sector });
      return;
    }
    applyFilterZoomRanges(map, { entidad, sector });
  }, [entidad, sector]);

  return <div ref={containerRef} className="h-full w-full" />;
}

function isFiltered(filters: {
  entidad: string | null;
  sector: string | null;
}): boolean {
  return filters.entidad !== null || filters.sector !== null;
}

/**
 * Shift layer zoom ranges in response to filter changes. Called after a
 * setTiles refresh so the user sees dots at country zoom the moment they
 * apply a filter, instead of having to zoom to street level.
 *
 * Heatmap maxzoom 14 → 9 when filtered: heatmap fades out earlier so
 * circles take over.
 *
 * Circle minzoom 11 → 5 when filtered: dots appear at the default
 * Mexico-overview zoom. The 50k/tile cap is the same either way, but
 * filtered tiles return far fewer features so the canvas isn't overwhelmed.
 */
function applyFilterZoomRanges(
  map: MapInstance,
  filters: { entidad: string | null; sector: string | null },
): void {
  const filtered = isFiltered(filters);
  if (map.getLayer(HEATMAP_LAYER_ID)) {
    map.setLayerZoomRange(HEATMAP_LAYER_ID, 0, filtered ? 9 : 14);
  }
  if (map.getLayer(CIRCLE_LAYER_ID)) {
    map.setLayerZoomRange(CIRCLE_LAYER_ID, filtered ? 5 : 11, 22);
  }
}

function addDataLayers(
  map: MapInstance,
  filters: { entidad: string | null; sector: string | null },
): void {
  const filtered = isFiltered(filters);
  map.addSource(SOURCE_ID, {
    type: "vector",
    tiles: [absoluteTileUrl(filters)],
    minzoom: 0,
    maxzoom: 17,
  });

  map.addLayer({
    id: HEATMAP_LAYER_ID,
    type: "heatmap",
    source: SOURCE_ID,
    "source-layer": SOURCE_LAYER,
    maxzoom: filtered ? 9 : 14,
    paint: {
      "heatmap-weight": 0.4,
      "heatmap-intensity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        0,
        0.6,
        14,
        2.5,
      ],
      "heatmap-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        0,
        4,
        10,
        14,
        14,
        24,
      ],
      "heatmap-color": [
        "interpolate",
        ["linear"],
        ["heatmap-density"],
        0,
        "rgba(2,6,23,0)", // slate-950 transparent
        0.2,
        "rgba(8,145,178,0.5)", // cyan-700
        0.4,
        "rgba(34,211,238,0.7)", // cyan-400
        0.6,
        "rgba(250,204,21,0.85)", // yellow-400
        0.8,
        "rgba(251,113,133,0.95)", // rose-400
      ],
      "heatmap-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        7,
        0.95,
        14,
        0.4,
      ],
    },
  });

  map.addLayer({
    id: CIRCLE_LAYER_ID,
    type: "circle",
    source: SOURCE_ID,
    "source-layer": SOURCE_LAYER,
    // minzoom is filter-state dependent — see applyFilterZoomRanges.
    minzoom: filtered ? 5 : 11,
    paint: {
      // Radius ramp from country zoom (5, 1.5px) through state zoom
      // (8, 1.8px) up to street (16, 4.5px). The country-zoom value
      // matters when a sector filter is active and the user is still
      // at the default Mexico view.
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        1.5,
        11,
        2,
        16,
        4.5,
      ],
      "circle-color": "#22d3ee", // cyan-400
      // Opacity ramp: 0.55 at country zoom (lower than mid-zoom so the
      // density doesn't read as a smeared blob), 0.7 at city zoom,
      // 0.85 at street zoom for individual identification.
      "circle-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        5,
        0.55,
        11,
        0.7,
        16,
        0.85,
      ],
      "circle-stroke-color": "#0f172a", // slate-900
      "circle-stroke-width": [
        "interpolate",
        ["linear"],
        ["zoom"],
        13,
        0,
        16,
        0.6,
      ],
    },
  });
}

/**
 * Backend tile URL for the source initialization. Same pattern as
 * tileSourceUrl in style.ts but kept here for the colocation with
 * addDataLayers — the source spec needs a literal string with {z}/{x}/{y}
 * placeholders that MapLibre expands per-tile.
 */
function absoluteTileUrl(filters: {
  entidad: string | null;
  sector: string | null;
}): string {
  return tileSourceUrl(filters);
}
