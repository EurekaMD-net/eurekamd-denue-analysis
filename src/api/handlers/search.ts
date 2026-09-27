/**
 * GET /search — paginated establishment search.
 *
 * Query params:
 *   q          — substring on `nombre` (ILIKE, trigram-indexed), >= 3 chars
 *   entidad    — 2-digit clave 01-32
 *   from       — "lat,lon" anchor for radius filter (inside Mexico's bbox)
 *   radius_km  — distance threshold (requires `from`)
 *   page       — 1-based page number (default 1)
 *   limit      — page size (default 50, max 1000)
 *
 * Two execution paths:
 *   1. With radius: shells to psql for ST_DWithin (PostgREST can't express it cleanly)
 *   2. Without radius: PostgREST REST query with `or=` and `eq.` filters
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import { runJson } from "../db/psql-runner.js";
import {
  ENTIDAD_RE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  type ApiServerConfig,
  type SearchResult,
} from "../types.js";
import { assertSafeContainer } from "./_safe-container.js";

const FROM_RE = /^-?\d{1,3}(?:\.\d+)?,-?\d{1,3}(?:\.\d+)?$/;
const RADIUS_RE = /^\d+(?:\.\d+)?$/; // numeric only, no trailing garbage
const MAX_PAGE = 10_000; // cap OFFSET to prevent slow-scan DoS
const MAX_Q_LEN = 200; // cap free-text length to bound shell-arg + URL size
// Audit #36/#96: a 1-2 char substring cannot use the trigram index and
// scans the heap; the SPA only searches from 3 chars (web useSearch).
const MIN_Q_LEN = 3;
// Audit #53: digits only, no sign/decimal/exponent/trailing garbage.
const POSITIVE_INT_RE = /^[1-9]\d{0,6}$/;
// Audit #44: Mexico's bbox. Rejects out-of-range and swapped "lon,lat"
// input, which PostGIS would otherwise silently wrap to another point.
const MX_LAT_MIN = 14;
const MX_LAT_MAX = 33;
const MX_LON_MIN = -119;
const MX_LON_MAX = -86;
const POSTGREST_TIMEOUT_MS = 10_000;

export async function searchHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const q = c.req.query("q");
  const entidad = c.req.query("entidad");
  const from = c.req.query("from");
  const radiusKmRaw = c.req.query("radius_km");
  const pageRaw = c.req.query("page");
  const limitRaw = c.req.query("limit");

  // ---- Validate ----
  if (entidad !== undefined && !ENTIDAD_RE.test(entidad)) {
    throw new HttpError(
      `entidad inválida "${entidad}"`,
      400,
      "validation.entidad",
    );
  }
  if (q !== undefined && q.length > MAX_Q_LEN) {
    throw new HttpError(
      `q demasiado largo (${q.length} > ${MAX_Q_LEN})`,
      400,
      "validation.q_too_long",
    );
  }
  if (q !== undefined && q !== "" && q.trim().length < MIN_Q_LEN) {
    throw new HttpError(
      `q demasiado corto (mínimo ${MIN_Q_LEN} caracteres)`,
      400,
      "validation.q_too_short",
    );
  }
  // Audit #54: a NUL byte cannot travel through psql's stdin transport or
  // a PostgREST URL; reject it as input, not as a 500.
  if (q !== undefined && q.includes("\0")) {
    throw new HttpError("q contiene un byte NUL", 400, "validation.q");
  }
  if (from !== undefined && !FROM_RE.test(from)) {
    throw new HttpError(
      `from inválido "${from}" — esperado "lat,lon"`,
      400,
      "validation.from",
    );
  }
  if (radiusKmRaw !== undefined && from === undefined) {
    throw new HttpError(
      "radius_km requires from=lat,lon",
      400,
      "validation.radius_km_no_from",
    );
  }
  let radiusKm: number | undefined;
  if (radiusKmRaw !== undefined) {
    // Regex first to reject "10abc" → 10 trailing-garbage path
    if (!RADIUS_RE.test(radiusKmRaw)) {
      throw new HttpError(
        `radius_km inválido "${radiusKmRaw}" — debe ser numérico`,
        400,
        "validation.radius_km",
      );
    }
    radiusKm = parseFloat(radiusKmRaw);
    if (!Number.isFinite(radiusKm) || radiusKm <= 0 || radiusKm > 500) {
      throw new HttpError(
        `radius_km inválido "${radiusKmRaw}" — debe ser 0 < km <= 500`,
        400,
        "validation.radius_km",
      );
    }
  }

  const page = parsePositiveInt(pageRaw, 1, "page");
  if (page > MAX_PAGE) {
    throw new HttpError(
      `page demasiado grande (${page} > ${MAX_PAGE})`,
      400,
      "validation.page_too_large",
    );
  }
  const limit = Math.min(
    parsePositiveInt(limitRaw, DEFAULT_PAGE_SIZE, "limit"),
    MAX_PAGE_SIZE,
  );
  const offset = (page - 1) * limit;

  // ---- Execute ----
  let rows: Array<Record<string, unknown>>;
  if (radiusKm !== undefined && from !== undefined) {
    rows = await searchWithRadius(config, {
      q,
      entidad,
      from,
      radiusKm,
      offset,
      limit,
    });
  } else {
    rows = await searchPostgrest(config, { q, entidad, offset, limit });
  }

  const result: SearchResult = {
    rows,
    page,
    limit,
    total_returned: rows.length,
  };
  return c.json(result);
}

function parsePositiveInt(
  raw: string | undefined,
  defaultVal: number,
  field: string,
): number {
  if (raw === undefined) return defaultVal;
  const n = POSITIVE_INT_RE.test(raw) ? parseInt(raw, 10) : NaN;
  if (!Number.isInteger(n) || n < 1) {
    throw new HttpError(
      `${field} inválido "${raw}" — debe ser entero positivo`,
      400,
      `validation.${field}`,
    );
  }
  return n;
}

interface PostgrestParams {
  q?: string;
  entidad?: string;
  offset: number;
  limit: number;
}

async function searchPostgrest(
  config: ApiServerConfig,
  p: PostgrestParams,
): Promise<Array<Record<string, unknown>>> {
  const params = new URLSearchParams();
  // PostgREST: select all fields, paginated via Range header
  params.set(
    "select",
    "clee,nombre,razon_social,clase_actividad,municipio,entidad,latitud,longitud",
  );
  if (p.entidad) params.set("entidad", `eq.${p.entidad}`);
  if (p.q) {
    // Substring match, served by idx_estab_nombre_trgm (migration 009)
    params.set("nombre", `ilike.*${p.q}*`);
  }
  params.set("limit", String(p.limit));
  params.set("offset", String(p.offset));
  params.set("order", "clee.asc");

  const url = `${config.supabaseUrl}/rest/v1/establecimientos?${params.toString()}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        apikey: config.serviceRoleKey,
        Authorization: `Bearer ${config.serviceRoleKey}`,
      },
      // Audit #36/#96: never hold a PostgREST connection indefinitely.
      signal: AbortSignal.timeout(POSTGREST_TIMEOUT_MS),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      `PostgREST request failed: ${msg}`,
      502,
      "postgrest.error",
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new HttpError(
      `PostgREST returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      502,
      "postgrest.error",
    );
  }
  return (await res.json()) as Array<Record<string, unknown>>;
}

interface RadiusParams extends PostgrestParams {
  from: string;
  radiusKm: number;
}

async function searchWithRadius(
  config: ApiServerConfig,
  p: RadiusParams,
): Promise<Array<Record<string, unknown>>> {
  assertSafeContainer(config.dbContainer);
  const [latStr, lonStr] = p.from.split(",");
  const lat = parseFloat(latStr!);
  const lon = parseFloat(lonStr!);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    throw new HttpError(
      `from coords no parseables`,
      400,
      "validation.from_coords",
    );
  }
  if (
    lat < MX_LAT_MIN ||
    lat > MX_LAT_MAX ||
    lon < MX_LON_MIN ||
    lon > MX_LON_MAX
  ) {
    throw new HttpError(
      `from fuera de México (${lat},${lon}) — esperado "lat,lon" con lat ${MX_LAT_MIN}..${MX_LAT_MAX}, lon ${MX_LON_MIN}..${MX_LON_MAX}`,
      400,
      "validation.from_coords",
    );
  }
  const meters = Math.round(p.radiusKm * 1000);
  const pt = `ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)`;
  // Build SQL with safe interpolation: numeric values + entidad/q already validated
  // Audit #35/#97: `geom::geography` cannot use idx_estab_geom, so a
  // geometry bbox prefilter (`&&`) comes first. meters/111320/cos(lat)
  // degrees covers the radius in both axes for lat >= 14 (enforced above).
  // ST_DWithin on geography keeps the result exact. Rows come nearest-first
  // via KNN (`<->`) so the GiST scan stops at LIMIT; distance_m is additive.
  const filters: string[] = [
    `geom IS NOT NULL`,
    `geom && ST_Expand(${pt}, ${meters} / 111320.0 / cos(radians(${lat})))`,
    `ST_DWithin(geom::geography, ${pt}::geography, ${meters})`,
  ];
  if (p.entidad) filters.push(`entidad = '${p.entidad}'`);
  if (p.q) {
    // Escape single quotes in q
    const safeQ = p.q.replace(/'/g, "''");
    filters.push(`nombre ILIKE '%${safeQ}%'`);
  }
  const sql = `
    SELECT json_agg(row_to_json(t)) FROM (
      SELECT clee, nombre, razon_social, clase_actividad, municipio, entidad, latitud, longitud,
        round(ST_Distance(geom::geography, ${pt}::geography))::integer AS distance_m
      FROM establecimientos
      WHERE ${filters.join(" AND ")}
      ORDER BY geom <-> ${pt}
      LIMIT ${p.limit} OFFSET ${p.offset}
    ) t;
  `
    .replace(/\n\s+/g, " ")
    .trim();

  // SECURITY (audit C1): no shell layer — the shared runner spawns docker
  // with an args array and sends the SQL on stdin, so shell metacharacters
  // in `q` cannot escape. The SQL `'` escape on `q` still applies for the
  // SQL parser inside psql. Audit #94/#130/#54: the runner carries
  // statement_timeout via `docker exec -e PGOPTIONS` (host env never
  // reached the container) and turns psql failures into 502 postgres.error.
  return runJson<Array<Record<string, unknown>>>(sql, {
    container: config.dbContainer,
  });
}
