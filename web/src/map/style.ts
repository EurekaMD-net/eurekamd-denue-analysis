/**
 * Carto basemap style URLs (free, no API key, attribution required).
 *
 * Per analyzer-plan-v1.md sealed decision #4 — Carto Positron (light) +
 * Carto Dark Matter (dark). Both ship as MapLibre-style spec JSON, so
 * we point MapLibre at the URL directly.
 */

export type BasemapStyle = "positron" | "dark";

export const BASEMAP_STYLES: Record<BasemapStyle, string> = {
  positron: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
  dark: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
};

export const DEFAULT_BASEMAP: BasemapStyle = "dark";

export const MEXICO_CENTER = { lon: -102.0, lat: 23.6, zoom: 5 };
export const MEXICO_BOUNDS: [number, number, number, number] = [
  -118.5, 14.5, -86.5, 33.0,
];

/**
 * Default filter the Map mode forces on first visit so the canvas never
 * paints unfiltered tiles (50k features × ~25 tiles at zoom 5 ≈ 1.25M
 * heatmap points — visibly slow even though it doesn't crash).
 *
 * "09" is Ciudad de México (densest urban data, recognizable for QA).
 * "62" is SCIAN sector "Servicios de salud y de asistencia social" —
 * on-brand for the EurekaMD use case.
 *
 * Users can still pick "Nacional" or different sectors after the initial
 * load; this only seeds the empty case.
 */
export const DEFAULT_MAP_ENTIDAD = "09";
export const DEFAULT_MAP_SECTOR = "62";

/**
 * Builds the MVT tile source URL template for MapLibre.
 *
 * MUST return an absolute URL. MapLibre internally calls
 * `new Request(url)` to load tiles, and `Request`'s constructor rejects
 * relative paths with "Failed to parse URL from ...". A previous
 * version of this function returned `/api/tiles/...` (relative) which
 * silently broke every tile fetch in production — the dev server's
 * Vite proxy happened to mask the problem because requests were
 * constructed against the page's origin somewhere upstream of MapLibre,
 * but production via Caddy hit the real Request-constructor path and
 * threw on every tile.
 *
 * Filters are encoded as query string. {z}/{x}/{y} stay as MapLibre
 * placeholders that the renderer expands per-tile. The X-Api-Key
 * header is NOT in the URL — it's injected via MapLibre's
 * `transformRequest` callback (see MapShell). That callback fires on
 * every tile fetch and is the standard way to add auth headers without
 * leaking the key in browser history or server access logs.
 *
 * Backend route: /tiles/:z/:x/:y (no .mvt suffix; response is
 * application/x-protobuf). Vite dev proxy rewrites /api/* → :3030.
 */
export function tileSourceUrl(filters: {
  entidad?: string | null;
  sector?: string | null;
}): string {
  const params = new URLSearchParams();
  if (filters.entidad) params.set("entidad", filters.entidad);
  if (filters.sector) params.set("sector", filters.sector);
  const qs = params.toString();
  // typeof window check keeps SSR/test environments from blowing up;
  // in tests we fall back to a localhost origin which is fine for
  // string-shape assertions (no real fetch happens).
  const origin =
    typeof window !== "undefined" && window.location
      ? window.location.origin
      : "http://localhost";
  return `${origin}/api/tiles/{z}/{x}/{y}${qs ? `?${qs}` : ""}`;
}
