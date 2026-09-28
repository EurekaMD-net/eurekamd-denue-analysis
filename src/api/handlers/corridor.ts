/**
 * POST /analytics/corridor-density — establishments along a line.
 *
 * Counts `establecimientos` within `buffer_m` metres (geodesic) of a
 * LineString / MultiLineString: total + per km + top classes.
 * Pure PostGIS over the existing idx_estab_geom GiST index; nothing stored.
 * Plan: docs/CORRIDOR-DENSITY-PLAN-2026-09-28.md §P1.
 *
 * Request JSON:
 *   { geometry: { type: "LineString" | "MultiLineString", coordinates },
 *     buffer_m?: int 10..1000 (default 100),
 *     clase_prefix?: SCIAN prefix, 2..6 digits,
 *     top?: int 1..50 (default 10) }
 *
 * SECURITY: the SQL is built only from validated finite numbers, the
 * digit-only prefix and bounded integers; no request string reaches psql.
 *
 * COST (qa-auditor 2026-09-28: ST_Buffer on a self-crossing scribble
 * OOM-killed a backend; an envelope bbox over a long diagonal line read
 * 18x the corridor's rows and blew 15 s on a cold cache):
 *  - the count never calls ST_Buffer: candidates come from a grid of
 *    cells (about buffer_m/2 wide) that covers the line, computed here in
 *    TS, so the index work tracks the corridor, not the line's envelope;
 *    cells are disjoint and matched half-open, so no row is counted twice;
 *    exact membership is ST_DWithin on geography;
 *  - shape guards before any SQL: bbox, segment >= 1 m, length 10 m..50 km
 *    (MultiLineString gaps count), vertices <= length/5, envelope diagonal
 *    <= 60 km, covered cell area <= MAX_COVER_AREA_KM2, cell runs capped;
 *  - in SQL, candidates are read with LIMIT MAX_CANDIDATE_ROWS + 1; more
 *    than MAX_CANDIDATE_ROWS returns {error:'too_many_candidates'} (400
 *    validation.geometry.area) before any ST_DWithin work;
 *  - no GEOS anywhere: `buffer_geojson` (display only) is a MultiPolygon of
 *    the cell runs, built here in TS (a blocky superset of the buffer);
 *    null when there are more than BUFFER_GEOJSON_MAX_RUNS runs.
 *
 * `length_m` / `per_km` use the drawn length (gaps between MultiLineString
 * parts excluded); the 10 m..50 km bound includes the gaps.
 *
 * Caveat: until the operator runs ops/denue-stale-cleanup.sh, the table
 * still holds stale-CLEE rows, so counts are inflated by the same share as
 * every other analytic.
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import { runJson } from "../db/psql-runner.js";
import type { ApiServerConfig } from "../types.js";

export type CorridorLineString = {
  type: "LineString";
  coordinates: Array<[number, number]>;
};
export type CorridorMultiLineString = {
  type: "MultiLineString";
  coordinates: Array<Array<[number, number]>>;
};

export interface CorridorRequest {
  geometry: CorridorLineString | CorridorMultiLineString;
  buffer_m: number;
  clase_prefix?: string;
  top: number;
}

export interface CorridorDensityResult {
  length_m: number;
  buffer_m: number;
  total: number;
  per_km: number | null;
  by_clase: Array<{
    clase_actividad_id: string;
    clase_actividad: string;
    n: number;
  }>;
  /** Cell-run MultiPolygon (display only); null when there are > 500 runs. */
  buffer_geojson: BufferMultiPolygon | null;
}

export interface BufferMultiPolygon {
  type: "MultiPolygon";
  coordinates: Array<Array<Array<[number, number]>>>;
}

/** Per-principal limit for this route (wired in server.ts). */
export const CORRIDOR_RATE_LIMIT = { max: 20, windowMs: 60_000 } as const;

// Mexico bbox (plan §P1).
const LON_MIN = -118.5;
const LON_MAX = -86.5;
const LAT_MIN = 14.3;
const LAT_MAX = 32.8;
const MIN_VERTICES = 2;
const MAX_VERTICES = 5000;
const MIN_LENGTH_M = 10;
const MAX_LENGTH_M = 50_000;
const MIN_SEGMENT_M = 1;
const METRES_PER_VERTEX = 5;
const MAX_EXTENT_M = 60_000;
// First guard, on shape: covered cell area. Cells cover ~1.3x (axis-aligned)
// to ~2.1x (diagonal) the corridor, so 15 km² allows ~35 km at 100 m,
// ~6-9 km at 500 m, ~3 km at 1000 m. It does NOT bound the rows: live
// density reaches ~10,300 rows/km² in Centro Histórico (round-2 audit
// 2026-09-28), so 15 km² there is 100-150k candidates, past the 15 s
// timeout (a cold 67k-row bbox already exceeded it). MAX_CANDIDATE_ROWS
// bounds the rows, in the statement itself.
const MAX_COVER_AREA_KM2 = 15;
/** Candidate rows (cell-cover index hits) above which the query answers too_many_candidates. */
export const MAX_CANDIDATE_ROWS = 40_000;
const MAX_CELL_RUNS = 10_000;
const MIN_CELL_M = 10;
const BUFFER_MIN = 10;
const BUFFER_MAX = 1000;
const BUFFER_DEFAULT = 100;
const TOP_MIN = 1;
const TOP_MAX = 50;
const TOP_DEFAULT = 10;
const BUFFER_GEOJSON_MAX_RUNS = 500;
const PREFIX_RE = /^\d{2,6}$/;
const MAX_BODY_BYTES = 1024 * 1024;
const QUERY_TIMEOUT_MS = 15_000;
const EARTH_RADIUS_M = 6_371_008.8;
const M_PER_DEG = 111_000;
const EXPAND_MARGIN = 1.05;
const MAX_SQL_ABS = 1e6;
const RAD = Math.PI / 180;

type Pos = [number, number];

function bad(message: string, code: string): HttpError {
  return new HttpError(message, 400, code);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** One position: exactly two finite numbers inside the Mexico bbox. */
function validatePosition(p: unknown): Pos {
  if (!Array.isArray(p) || p.length !== 2) {
    throw bad(
      "cada coordenada debe ser un par [lon, lat]",
      "validation.geometry.coordinates",
    );
  }
  const [lon, lat] = p;
  if (
    typeof lon !== "number" ||
    typeof lat !== "number" ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat)
  ) {
    throw bad(
      "cada coordenada debe ser un par de números finitos",
      "validation.geometry.coordinates",
    );
  }
  if (lon < LON_MIN || lon > LON_MAX || lat < LAT_MIN || lat > LAT_MAX) {
    throw bad(
      `coordenada fuera de México (${lon}, ${lat}) — esperado [lon, lat] con lon ${LON_MIN}..${LON_MAX}, lat ${LAT_MIN}..${LAT_MAX}`,
      "validation.geometry.bbox",
    );
  }
  return [lon, lat];
}

function validateLine(line: unknown): Pos[] {
  if (!Array.isArray(line) || line.length < MIN_VERTICES) {
    throw bad(
      `cada línea necesita al menos ${MIN_VERTICES} vértices`,
      "validation.geometry.coordinates",
    );
  }
  if (line.length > MAX_VERTICES) {
    throw bad(
      `demasiados vértices (máximo ${MAX_VERTICES})`,
      "validation.geometry.vertices",
    );
  }
  return line.map(validatePosition);
}

function haversineM(a: Pos, b: Pos): number {
  const dLat = (b[1] - a[1]) * RAD;
  const dLon = (b[0] - a[0]) * RAD;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Drawn haversine length in metres (gaps between parts excluded). */
export function lineLengthM(lines: Pos[][]): number {
  let total = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      total += haversineM(line[i - 1]!, line[i]!);
    }
  }
  return total;
}

/** Point at fraction f along the great circle a→b (angular distance d). */
function greatCircleAt(a: Pos, b: Pos, f: number, d: number): Pos {
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const [l1, p1] = [a[0] * RAD, a[1] * RAD];
  const [l2, p2] = [b[0] * RAD, b[1] * RAD];
  const x = A * Math.cos(p1) * Math.cos(l1) + B * Math.cos(p2) * Math.cos(l2);
  const y = A * Math.cos(p1) * Math.sin(l1) + B * Math.cos(p2) * Math.sin(l2);
  const z = A * Math.sin(p1) + B * Math.sin(p2);
  return [Math.atan2(y, x) / RAD, Math.atan2(z, Math.hypot(x, y)) / RAD];
}

export interface CellCover {
  /** Disjoint half-open boxes [x0, x1) × [y0, y1) in degrees. */
  runs: Array<[number, number, number, number]>;
  areaKm2: number;
}

/**
 * Grid cells (about buffer_m/2 on a side) covering every point within
 * buffer_m of the line. Each segment is split into great-circle pieces of
 * at most buffer_m, each piece's bbox is expanded by buffer_m (+5%, lon
 * scaled by the highest latitude) and the touched cells are collected.
 * Adjacent cells in a row are merged into runs.
 */
export function coverCells(lines: Pos[][], bufferM: number): CellCover {
  let maxLat = 0;
  for (const line of lines) for (const p of line) maxLat = Math.max(maxLat, Math.abs(p[1]));
  // Expansion (ey, ex) covers buffer_m; cells (gy, gx) are half that, so
  // the union hugs the corridor more tightly (min 10 m to bound the runs).
  const ey = (bufferM / M_PER_DEG) * EXPAND_MARGIN;
  const cosLat = Math.cos((maxLat + ey) * RAD);
  const ex = ey / cosLat;
  const gy = Math.max(ey / 2, MIN_CELL_M / M_PER_DEG);
  const gx = gy / cosLat;
  const rows = new Map<number, Set<number>>();
  const mark = (p: Pos, q: Pos) => {
    const i0 = Math.floor((Math.min(p[0], q[0]) - ex) / gx);
    const i1 = Math.floor((Math.max(p[0], q[0]) + ex) / gx);
    const j0 = Math.floor((Math.min(p[1], q[1]) - ey) / gy);
    const j1 = Math.floor((Math.max(p[1], q[1]) + ey) / gy);
    for (let j = j0; j <= j1; j++) {
      let row = rows.get(j);
      if (!row) rows.set(j, (row = new Set()));
      for (let i = i0; i <= i1; i++) row.add(i);
    }
  };
  for (const line of lines) {
    for (let k = 1; k < line.length; k++) {
      const a = line[k - 1]!;
      const b = line[k]!;
      const len = haversineM(a, b);
      const n = Math.max(1, Math.ceil(len / bufferM));
      const d = len / EARTH_RADIUS_M;
      let prev = a;
      for (let s = 1; s <= n; s++) {
        const next = s === n || d === 0 ? b : greatCircleAt(a, b, s / n, d);
        mark(prev, next);
        prev = next;
      }
    }
  }
  const runs: CellCover["runs"] = [];
  let cells = 0;
  for (const j of [...rows.keys()].sort((x, y) => x - y)) {
    const is = [...rows.get(j)!].sort((x, y) => x - y);
    cells += is.length;
    let start = is[0]!;
    for (let k = 1; k <= is.length; k++) {
      if (k === is.length || is[k] !== is[k - 1]! + 1) {
        runs.push([start * gx, (is[k - 1]! + 1) * gx, j * gy, (j + 1) * gy]);
        start = is[k]!;
      }
    }
  }
  const cellKm2 = ((gy * M_PER_DEG) / 1000) * ((gx * M_PER_DEG * cosLat) / 1000);
  return { runs, areaKm2: cells * cellKm2 };
}

function checkCover(cover: CellCover): void {
  if (cover.areaKm2 > MAX_COVER_AREA_KM2 || cover.runs.length > MAX_CELL_RUNS) {
    throw bad(
      `corredor demasiado grande (~${cover.areaKm2.toFixed(1)} km² de área cubierta, máximo ${MAX_COVER_AREA_KM2}); reduce buffer_m o la longitud`,
      "validation.geometry.area",
    );
  }
}

function boundedInt(
  raw: unknown,
  def: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined || raw === null) return def;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < min || raw > max) {
    throw bad(
      `${field} debe ser un entero entre ${min} y ${max}`,
      `validation.${field}`,
    );
  }
  return raw;
}

/**
 * Validate a parsed request body. Returns a NEW object built only from
 * validated numbers / the digit-only prefix; nothing from the input is
 * passed through by reference.
 */
export function validateCorridorRequest(body: unknown): CorridorRequest {
  if (!isObject(body)) {
    throw bad("el cuerpo debe ser un objeto JSON", "validation.body");
  }
  const geom = body.geometry;
  if (!isObject(geom)) {
    throw bad("geometry es requerido", "validation.geometry");
  }
  if (geom.type !== "LineString" && geom.type !== "MultiLineString") {
    throw bad(
      "geometry.type debe ser LineString o MultiLineString",
      "validation.geometry.type",
    );
  }

  let lines: Pos[][];
  if (geom.type === "LineString") {
    lines = [validateLine(geom.coordinates)];
  } else {
    const parts = geom.coordinates;
    if (!Array.isArray(parts) || parts.length < 1) {
      throw bad(
        "MultiLineString necesita al menos una línea",
        "validation.geometry.coordinates",
      );
    }
    if (parts.length > MAX_VERTICES / MIN_VERTICES) {
      throw bad(
        `demasiados vértices (máximo ${MAX_VERTICES})`,
        "validation.geometry.vertices",
      );
    }
    lines = parts.map(validateLine);
  }
  const vertices = lines.reduce((n, l) => n + l.length, 0);
  if (vertices > MAX_VERTICES) {
    throw bad(
      `demasiados vértices (${vertices} > ${MAX_VERTICES})`,
      "validation.geometry.vertices",
    );
  }

  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      if (haversineM(line[i - 1]!, line[i]!) < MIN_SEGMENT_M) {
        throw bad(
          `cada segmento debe medir al menos ${MIN_SEGMENT_M} m (vértices repetidos o casi repetidos)`,
          "validation.geometry.segment",
        );
      }
    }
  }

  let minLon = Infinity, minLat = Infinity, maxLon = -Infinity, maxLat = -Infinity;
  for (const line of lines) {
    for (const [lon, lat] of line) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
  }
  const extentM = haversineM([minLon, minLat], [maxLon, maxLat]);
  if (extentM > MAX_EXTENT_M) {
    throw bad(
      `extensión de la geometría ${Math.round(extentM / 1000)} km excede ${MAX_EXTENT_M / 1000} km`,
      "validation.geometry.extent",
    );
  }

  // Gaps between consecutive MultiLineString parts count toward the bound.
  let lengthM = lineLengthM(lines);
  for (let i = 1; i < lines.length; i++) {
    lengthM += haversineM(lines[i - 1]!.at(-1)!, lines[i]![0]!);
  }
  if (!(lengthM >= MIN_LENGTH_M && lengthM <= MAX_LENGTH_M)) {
    throw bad(
      `longitud de la línea ${Math.round(lengthM)} m fuera de rango (${MIN_LENGTH_M} m..${MAX_LENGTH_M / 1000} km)`,
      "validation.geometry.length",
    );
  }
  const maxVertices = Math.max(MIN_VERTICES, Math.floor(lengthM / METRES_PER_VERTEX));
  if (vertices > maxVertices) {
    throw bad(
      `demasiados vértices para la longitud (${vertices} > ${maxVertices}, un vértice cada ${METRES_PER_VERTEX} m)`,
      "validation.geometry.vertices",
    );
  }

  const buffer_m = boundedInt(
    body.buffer_m,
    BUFFER_DEFAULT,
    BUFFER_MIN,
    BUFFER_MAX,
    "buffer_m",
  );
  const top = boundedInt(body.top, TOP_DEFAULT, TOP_MIN, TOP_MAX, "top");

  let clase_prefix: string | undefined;
  if (body.clase_prefix !== undefined && body.clase_prefix !== null) {
    if (
      typeof body.clase_prefix !== "string" ||
      !PREFIX_RE.test(body.clase_prefix)
    ) {
      throw bad(
        "clase_prefix debe ser un prefijo SCIAN de 2 a 6 dígitos",
        "validation.clase_prefix",
      );
    }
    clase_prefix = body.clase_prefix;
  }

  checkCover(coverCells(lines, buffer_m));

  const geometry: CorridorRequest["geometry"] =
    geom.type === "LineString"
      ? { type: "LineString", coordinates: lines[0]! }
      : { type: "MultiLineString", coordinates: lines };
  return {
    geometry,
    buffer_m,
    top,
    ...(clase_prefix !== undefined ? { clase_prefix } : {}),
  };
}

function num(n: number): string {
  // Defence in depth: the builder is exported, so re-check even though
  // validateCorridorRequest already guaranteed bounded finite numbers.
  if (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) >= MAX_SQL_ABS) {
    throw new Error("unsafe number in corridor SQL");
  }
  return String(n);
}

function linesOf(g: CorridorRequest["geometry"]): Pos[][] {
  if (g.type === "LineString") return [g.coordinates];
  if (g.type === "MultiLineString") return g.coordinates;
  throw new Error("unsupported geometry type in corridor SQL");
}

function serialiseGeometry(g: CorridorRequest["geometry"]): string {
  const pos = (p: Pos) => `[${num(p[0])},${num(p[1])}]`;
  const line = (l: Pos[]) => `[${l.map(pos).join(",")}]`;
  if (g.type === "LineString") {
    return `{"type":"LineString","coordinates":${line(g.coordinates)}}`;
  }
  return `{"type":"MultiLineString","coordinates":[${linesOf(g).map(line).join(",")}]}`;
}

/**
 * Display polygon from the cell runs: one closed lon/lat rectangle ring
 * (counter-clockwise) per run, 6 decimals (~0.1 m). Runs are disjoint, so
 * the rings only share edges. null above BUFFER_GEOJSON_MAX_RUNS runs.
 */
export function bufferGeojsonFromRuns(
  runs: CellCover["runs"],
): BufferMultiPolygon | null {
  if (runs.length > BUFFER_GEOJSON_MAX_RUNS) return null;
  const r6 = (n: number) => Math.round(n * 1e6) / 1e6;
  return {
    type: "MultiPolygon",
    coordinates: runs.map(([x0, x1, y0, y1]) => {
      const [a, b, c, d] = [r6(x0), r6(x1), r6(y0), r6(y1)];
      return [
        [
          [a, c],
          [b, c],
          [b, d],
          [a, d],
          [a, c],
        ],
      ];
    }),
  };
}

/** Build the single read-only statement. Input must come from validateCorridorRequest. */
export function buildCorridorSql(req: CorridorRequest): string {
  return buildCorridorQuery(req).sql;
}

function buildCorridorQuery(req: CorridorRequest): { sql: string; cover: CellCover } {
  const lines = linesOf(req.geometry);
  const geojson = serialiseGeometry(req.geometry);
  const buffer = num(req.buffer_m);
  const top = num(req.top);
  if (req.clase_prefix !== undefined && !PREFIX_RE.test(req.clase_prefix)) {
    throw new Error("unsafe clase_prefix in corridor SQL");
  }
  const cover = coverCells(lines, req.buffer_m);
  checkCover(cover);
  const cells = cover.runs
    .map(
      ([x0, x1, y0, y1], k) =>
        k === 0
          ? `(${num(x0)}::float8,${num(x1)}::float8,${num(y0)}::float8,${num(y1)}::float8)`
          : `(${num(x0)},${num(x1)},${num(y0)},${num(y1)})`,
    )
    .join(",");
  const prefixFilter =
    req.clase_prefix !== undefined
      ? ` AND e.clase_actividad_id LIKE '${req.clase_prefix}%'`
      : "";
  // cand is referenced twice, so Postgres materialises it once; its LIMIT
  // stops the per-run index scans one row past the cap. The prefix filter
  // stays on hits: it does not save heap reads, so the cap counts them all.
  const sql = `
WITH line AS (SELECT g, g::geography AS gg
              FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON('${geojson}'),4326) AS g) s),
     cells(x0, x1, y0, y1) AS (VALUES ${cells}),
     cand AS (SELECT e.geom, e.clase_actividad_id, e.clase_actividad
              FROM cells c
              JOIN establecimientos e
                ON e.geom && ST_MakeEnvelope(c.x0, c.y0, c.x1, c.y1, 4326)
               AND ST_X(e.geom) >= c.x0 AND ST_X(e.geom) < c.x1
               AND ST_Y(e.geom) >= c.y0 AND ST_Y(e.geom) < c.y1
              LIMIT ${num(MAX_CANDIDATE_ROWS + 1)}),
     hits AS (SELECT e.clase_actividad_id, e.clase_actividad
              FROM cand e
              CROSS JOIN line
              WHERE ST_DWithin(e.geom::geography, line.gg, ${buffer})${prefixFilter}),
     len AS (SELECT ST_Length(gg) AS len_m FROM line)
SELECT CASE WHEN (SELECT count(*) FROM cand) > ${num(MAX_CANDIDATE_ROWS)}
  THEN json_build_object('error', 'too_many_candidates')
  ELSE json_build_object(
  'length_m', (SELECT len_m FROM len),
  'buffer_m', ${buffer},
  'total', (SELECT count(*) FROM hits),
  'per_km', (SELECT count(*) FROM hits) / NULLIF((SELECT len_m FROM len)/1000.0,0),
  'by_clase', (SELECT coalesce(json_agg(t),'[]') FROM (
       SELECT clase_actividad_id, clase_actividad, count(*) AS n
       FROM hits GROUP BY 1,2 ORDER BY n DESC LIMIT ${top}) t))
  END;
`.trim();
  return { sql, cover };
}

export async function corridorDensityHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  // server.ts also caps this route with bodyLimit; the handler keeps its
  // own bound so it is safe wherever it is mounted.
  const declared = c.req.raw.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
    throw new HttpError("Payload too large", 413, "payload_too_large");
  }
  let text: string;
  try {
    text = await c.req.text();
  } catch {
    throw bad("no se pudo leer el cuerpo", "validation.body");
  }
  if (Buffer.byteLength(text, "utf-8") > MAX_BODY_BYTES) {
    throw new HttpError("Payload too large", 413, "payload_too_large");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad("el cuerpo debe ser JSON válido", "validation.body");
  }

  const req = validateCorridorRequest(body);
  const { sql, cover } = buildCorridorQuery(req);
  const result = await runJson<
    Omit<CorridorDensityResult, "buffer_geojson"> | { error: string }
  >(sql, {
    container: config.dbContainer,
    readOnly: true,
    timeoutMs: QUERY_TIMEOUT_MS,
  });
  if ("error" in result) {
    if (result.error === "too_many_candidates") {
      throw bad(
        `el corredor cubre demasiados establecimientos (más de ${MAX_CANDIDATE_ROWS} candidatos)`,
        "validation.geometry.area",
      );
    }
    throw new Error(`unexpected corridor SQL error: ${result.error}`);
  }
  const out: CorridorDensityResult = {
    ...result,
    buffer_geojson: bufferGeojsonFromRuns(cover.runs),
  };
  return c.json(out);
}
