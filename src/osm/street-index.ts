/**
 * Street lookup over a cached per-municipio road extract (GeoJSONSeq,
 * one LineString feature per line — see osmium.ts). Pure: no DB, no
 * processes. The file is streamed line by line, never read whole
 * (a municipio extract can be tens of MB).
 *
 * Matching: the normalised query must be a substring of the normalised
 * `name`, `alt_name` or `official_name`. Normalisation = NFD, strip
 * combining marks, lower-case, collapse whitespace. Abbreviations are NOT
 * expanded ("Av." does not match "Avenida").
 *
 * Grouping: features are grouped by their exact normalised `name` (falling
 * back to the field that matched when `name` is absent). Each group becomes
 * one MultiLineString with its haversine length and the highway classes
 * seen. Groups are returned longest first, at most MAX_MATCHES, and the
 * response carries at most MAX_VERTICES vertices in total. findStreets
 * stops reading once the hits hold MAX_COLLECTED_VERTICES (a too-generic
 * query) and flags the result truncated.
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export const MAX_MATCHES = 20;
export const MAX_VERTICES = 20_000;
const NAME_FIELDS = ["name", "alt_name", "official_name"] as const;
const EARTH_RADIUS_M = 6_371_008.8;

export type Position = [number, number];

export interface RoadFeature {
  properties: Record<string, unknown>;
  coordinates: Position[];
}

export interface StreetMatch {
  name: string;
  highway: string[];
  length_m: number;
  segments: number;
  geometry: { type: "MultiLineString"; coordinates: Position[][] };
  /** Geometry clipped to fit MAX_VERTICES; length_m/segments are the full street's. */
  truncated?: true;
}

export interface StreetLookupResult {
  matches: StreetMatch[];
  /** True when groups or vertices were dropped by MAX_MATCHES / MAX_VERTICES. */
  truncated: boolean;
  /** Lines that were not a parseable LineString feature (skipped). */
  malformed: number;
}

export function normalizeName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function haversineM(a: Position, b: Position): number {
  const rad = Math.PI / 180;
  const dLat = (b[1] - a[1]) * rad;
  const dLon = (b[0] - a[0]) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLengthM(coords: Position[]): number {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    total += haversineM(coords[i - 1]!, coords[i]!);
  }
  return total;
}

function isPosition(p: unknown): p is Position {
  return (
    Array.isArray(p) &&
    p.length >= 2 &&
    Number.isFinite(p[0]) &&
    Number.isFinite(p[1])
  );
}

/** Parse one GeoJSONSeq line into a LineString feature, or null. A leading RS (0x1E) is tolerated. */
export function parseFeatureLine(line: string): RoadFeature | null {
  const text = line.replace(/^\x1e/, "").trim();
  if (text === "") return null;
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  const f = obj as {
    geometry?: { type?: unknown; coordinates?: unknown };
    properties?: unknown;
  };
  if (
    !f ||
    typeof f !== "object" ||
    f.geometry?.type !== "LineString" ||
    !Array.isArray(f.geometry.coordinates) ||
    f.geometry.coordinates.length < 2 ||
    !f.geometry.coordinates.every(isPosition)
  ) {
    return null;
  }
  const props =
    f.properties && typeof f.properties === "object"
      ? (f.properties as Record<string, unknown>)
      : {};
  return {
    properties: props,
    coordinates: (f.geometry.coordinates as Position[]).map((p) => [
      p[0],
      p[1],
    ]),
  };
}

/**
 * Stream a GeoJSONSeq file. Blank lines are ignored; lines that are not a
 * LineString feature are skipped and counted in `stats.malformed`.
 */
export async function* readFeatures(
  path: string,
  stats: { malformed: number } = { malformed: 0 },
): AsyncGenerator<RoadFeature> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.replace(/^\x1e/, "").trim() === "") continue;
    const f = parseFeatureLine(line);
    if (f === null) {
      stats.malformed++;
      continue;
    }
    yield f;
  }
}

/** Normalised group key when the feature matches `normQ`, else null. */
export function matchKey(f: RoadFeature, normQ: string): string | null {
  let matchedField: string | null = null;
  for (const field of NAME_FIELDS) {
    const v = f.properties[field];
    if (typeof v !== "string") continue;
    // OSM alt_name may hold several names separated by ";".
    const hit = v
      .split(";")
      .map(normalizeName)
      .find((part) => part.includes(normQ));
    if (hit !== undefined) {
      matchedField = hit;
      break;
    }
  }
  if (matchedField === null) return null;
  const name = f.properties["name"];
  return typeof name === "string" && name.trim() !== ""
    ? normalizeName(name)
    : matchedField;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

interface Group {
  name: string;
  highway: Set<string>;
  length: number;
  lines: Position[][];
}

export interface KeyedFeature {
  key: string;
  f: RoadFeature;
}

/** Group matching features and apply the MAX_MATCHES / MAX_VERTICES caps. */
export function groupMatches(
  features: Iterable<RoadFeature>,
  q: string,
): { matches: StreetMatch[]; truncated: boolean } {
  const normQ = normalizeName(q);
  if (normQ === "") return { matches: [], truncated: false };
  const hits: KeyedFeature[] = [];
  for (const f of features) {
    const key = matchKey(f, normQ);
    if (key !== null) hits.push({ key, f });
  }
  return groupKeyed(hits);
}

/** Group already-matched features by key (see matchKey) and apply the caps. */
export function groupKeyed(hits: Iterable<KeyedFeature>): {
  matches: StreetMatch[];
  truncated: boolean;
} {
  const groups = new Map<string, Group>();
  for (const { key, f } of hits) {
    let g = groups.get(key);
    if (!g) {
      const display =
        typeof f.properties["name"] === "string" && f.properties["name"] !== ""
          ? (f.properties["name"] as string)
          : key;
      g = { name: display, highway: new Set(), length: 0, lines: [] };
      groups.set(key, g);
    }
    const hw = f.properties["highway"];
    if (typeof hw === "string") g.highway.add(hw);
    g.length += lineLengthM(f.coordinates);
    g.lines.push(f.coordinates.map((p) => [round6(p[0]), round6(p[1])]));
  }

  const sorted = [...groups.values()].sort((a, b) => b.length - a.length);
  let truncated = sorted.length > MAX_MATCHES;
  const matches: StreetMatch[] = [];
  let budget = MAX_VERTICES;
  for (const g of sorted.slice(0, MAX_MATCHES)) {
    const vertices = g.lines.reduce((n, l) => n + l.length, 0);
    const base = {
      name: g.name,
      highway: [...g.highway].sort(),
      length_m: Math.round(g.length),
      segments: g.lines.length,
    };
    if (vertices <= budget) {
      budget -= vertices;
      matches.push({
        ...base,
        geometry: { type: "MultiLineString", coordinates: g.lines },
      });
      continue;
    }
    truncated = true;
    // Only the first (longest) street is clipped to fit; any later match
    // that does not fit is dropped along with everything after it.
    if (matches.length === 0) {
      const kept: Position[][] = [];
      for (const l of g.lines) {
        if (l.length > budget) break;
        kept.push(l);
        budget -= l.length;
      }
      if (kept.length > 0) {
        matches.push({
          ...base,
          geometry: { type: "MultiLineString", coordinates: kept },
          truncated: true,
        });
      }
    }
    break;
  }
  return { matches, truncated };
}

/** Collection stops (and the result is truncated) once hits exceed this many vertices. */
export const MAX_COLLECTED_VERTICES = 4 * MAX_VERTICES;

/** Stream `path` and return the street groups matching `q`. */
export async function findStreets(
  path: string,
  q: string,
): Promise<StreetLookupResult> {
  const normQ = normalizeName(q);
  const stats = { malformed: 0 };
  const hits: KeyedFeature[] = [];
  if (normQ === "") return { matches: [], truncated: false, malformed: 0 };
  let vertices = 0;
  let cut = false;
  for await (const f of readFeatures(path, stats)) {
    const key = matchKey(f, normQ);
    if (key === null) continue;
    hits.push({ key, f });
    vertices += f.coordinates.length;
    if (vertices > MAX_COLLECTED_VERTICES) {
      cut = true;
      break;
    }
  }
  const { matches, truncated } = groupKeyed(hits);
  return { matches, truncated: truncated || cut, malformed: stats.malformed };
}
