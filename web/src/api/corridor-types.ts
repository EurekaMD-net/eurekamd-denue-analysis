/**
 * Contracts for the corridor-density tool (plan
 * docs/CORRIDOR-DENSITY-PLAN-2026-09-28.md, P1 + P2):
 *
 *   POST /analytics/corridor-density   — buffer a line, count DENUE units
 *   GET  /analytics/street-geometry    — street name + municipio → geometry
 *
 * Zod schemas validate every response body before the UI reads it (same
 * defense-in-depth as api/types.ts). Extra fields are tolerated.
 */

import { z } from "zod";

/** [lon, lat] in WGS84. */
export type Position = [number, number];

export type CorridorGeometry =
  | { type: "LineString"; coordinates: Position[] }
  | { type: "MultiLineString"; coordinates: Position[][] };

export const BUFFER_MIN_M = 10;
export const BUFFER_MAX_M = 1000;
export const BUFFER_DEFAULT_M = 100;
/** API cap on total vertices (P1 validation). */
export const MAX_VERTICES = 5000;
/** SCIAN prefix accepted by P1 (`clase_actividad_id LIKE 'prefix%'`). */
export const CLASE_PREFIX_RE = /^\d{2,6}$/;
export const FARMACIAS_PREFIX = "4641";
export const CVE_MUN_RE = /^\d{5}$/;
/** P2 bounds on the street query, after trim. */
export const STREET_Q_MIN = 4;
export const STREET_Q_MAX = 80;

export interface CorridorRequest {
  geometry: CorridorGeometry;
  buffer_m: number;
  clase_prefix?: string;
  top?: number;
}

const POSITION = z.tuple([z.number(), z.number()]).rest(z.number());

export const CORRIDOR_CLASE_ROW = z
  .object({
    clase_actividad_id: z.string(),
    clase_actividad: z.string().nullable(),
    n: z.number(),
  })
  .passthrough();

export const CORRIDOR_RESULT = z
  .object({
    length_m: z.number(),
    buffer_m: z.number(),
    total: z.number(),
    // NULLIF(length,0) in the SQL can yield null.
    per_km: z.number().nullable(),
    by_clase: z.array(CORRIDOR_CLASE_ROW),
    // MultiPolygon of the grid-cell runs the count scanned (a blocky
    // superset of the buffer, built in TS, no GEOS). null when there are
    // > 500 runs: the count is still exact, only the drawing is skipped.
    buffer_geojson: z
      .object({
        type: z.enum(["Polygon", "MultiPolygon"]),
        coordinates: z.array(z.unknown()),
      })
      .passthrough()
      .nullable(),
  })
  .passthrough();

export const STREET_MATCH = z
  .object({
    name: z.string(),
    highway: z.array(z.string()),
    length_m: z.number(),
    segments: z.number(),
    geometry: z.object({
      type: z.literal("MultiLineString"),
      coordinates: z.array(z.array(POSITION)),
    }),
    // P2 drops segments past the per-match vertex cap and flags it.
    truncated: z.literal(true).optional(),
  })
  .passthrough();

export const STREET_OK = z
  .object({
    cve_mun: z.string(),
    q: z.string(),
    status: z.literal("ok"),
    matches: z.array(STREET_MATCH),
    truncated: z.boolean().optional(),
  })
  .passthrough();

export const STREET_EXTRACTING = z
  .object({
    status: z.literal("extracting"),
    cve_mun: z.string(),
    retry_after_s: z.number().optional(),
  })
  .passthrough();

/** GET /resolve/ageb — point → AGEB (+ its municipio). */
export const RESOLVE_AGEB_RESULT = z
  .object({
    cvegeo: z.string(),
    cve_mun: z.string(),
  })
  .passthrough();

export type CorridorClaseRow = z.infer<typeof CORRIDOR_CLASE_ROW>;
export type CorridorResult = z.infer<typeof CORRIDOR_RESULT>;
export type StreetMatch = z.infer<typeof STREET_MATCH>;
export type StreetOk = z.infer<typeof STREET_OK>;
export type StreetGeometryResponse =
  | StreetOk
  | { status: "extracting"; cve_mun: string; retry_after_s: number };

export type CorridorStatus = "idle" | "loading" | "ok" | "error";
export type StreetStatus =
  | "idle"
  | "resolving"
  | "loading"
  | "extracting"
  | "ok"
  | "error";

/**
 * Store slice `corridor` (initial value: INITIAL_CORRIDOR in store.ts, kept
 * there so the index chunk never imports these zod schemas). Ephemeral:
 * never URL-synced, reset on close and on sign-out. The corridor geometry
 * is EITHER the drawn `points` (LineString) OR a street match's
 * `streetLines` (MultiLineString).
 */
export interface CorridorState {
  /** Panel visible + layers painted. */
  open: boolean;
  /** Map clicks append vertices. */
  drawing: boolean;
  points: Position[];
  streetLines: Position[][] | null;
  /** Name of the street loaded into `streetLines`, for the panel. */
  streetName: string | null;
  bufferM: number;
  clasePrefix: string;
  result: CorridorResult | null;
  status: CorridorStatus;
  error: string | null;
  streetQuery: string;
  streetMatches: StreetMatch[];
  /** Top-level `truncated`: more matches than the API returns (20). */
  streetTruncated: boolean;
  streetStatus: StreetStatus;
  streetMessage: string | null;
}

/** The geometry the density query runs on, or null when there is none
 * yet (fewer than 2 drawn vertices and no street loaded). */
export function corridorGeometry(
  c: Pick<CorridorState, "points" | "streetLines">,
): CorridorGeometry | null {
  if (c.streetLines && c.streetLines.length > 0) {
    return { type: "MultiLineString", coordinates: c.streetLines };
  }
  if (c.points.length >= 2) {
    return { type: "LineString", coordinates: c.points };
  }
  return null;
}

/** Request body for the current slice, or null when it must not run
 * (no geometry yet, or a prefix the API would 400 on). An empty prefix
 * means "all classes". */
export function buildCorridorRequest(
  c: Pick<CorridorState, "points" | "streetLines" | "bufferM" | "clasePrefix">,
): CorridorRequest | null {
  const geometry = corridorGeometry(c);
  if (!geometry) return null;
  const prefix = c.clasePrefix.trim();
  if (prefix !== "" && !CLASE_PREFIX_RE.test(prefix)) return null;
  const buffer_m = Math.round(
    Math.min(BUFFER_MAX_M, Math.max(BUFFER_MIN_M, c.bufferM)),
  );
  return prefix === ""
    ? { geometry, buffer_m }
    : { geometry, buffer_m, clase_prefix: prefix };
}
