/**
 * GET /search — paginated establishment search.
 *
 * Query params:
 *   q          — full-text keyword on `nombre` (Spanish FTS)
 *   entidad    — 2-digit clave 01-32
 *   from       — "lat,lon" anchor for radius filter
 *   radius_km  — distance threshold (requires `from`)
 *   page       — 1-based page number (default 1)
 *   limit      — page size (default 50, max 1000)
 *
 * Two execution paths:
 *   1. With radius: shells to psql for ST_DWithin (PostgREST can't express it cleanly)
 *   2. Without radius: PostgREST REST query with `or=` and `eq.` filters
 */

import type { Context } from "hono";
import { execFileSync } from "node:child_process";
import { HttpError } from "../middleware/error.js";
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
  const n = parseInt(raw, 10);
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
    // Use ilike for substring; FTS index is set up on nombre
    params.set("nombre", `ilike.*${p.q}*`);
  }
  params.set("limit", String(p.limit));
  params.set("offset", String(p.offset));
  params.set("order", "clee.asc");

  const url = `${config.supabaseUrl}/rest/v1/establecimientos?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
    },
  });
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
  const meters = Math.round(p.radiusKm * 1000);
  // Build SQL with safe interpolation: numeric values + entidad/q already validated
  const filters: string[] = [
    `geom IS NOT NULL`,
    `ST_DWithin(geom::geography, ST_SetSRID(ST_MakePoint(${lon}, ${lat}), 4326)::geography, ${meters})`,
  ];
  if (p.entidad) filters.push(`entidad = '${p.entidad}'`);
  if (p.q) {
    // Escape single quotes in q
    const safeQ = p.q.replace(/'/g, "''");
    filters.push(`nombre ILIKE '%${safeQ}%'`);
  }
  const sql = `
    SELECT json_agg(row_to_json(t)) FROM (
      SELECT clee, nombre, razon_social, clase_actividad, municipio, entidad, latitud, longitud
      FROM establecimientos
      WHERE ${filters.join(" AND ")}
      ORDER BY clee
      LIMIT ${p.limit} OFFSET ${p.offset}
    ) t;
  `
    .replace(/\n\s+/g, " ")
    .trim();

  // SECURITY (audit C1): use execFileSync with args array, NOT execSync with
  // a shell-interpolated string. Shell metacharacters in `q` (`;`, `$()`, `,
  // `"`) cannot escape an args-array invocation — there is no shell layer.
  // The SQL `'` escape on `q` still applies for the SQL parser inside psql.
  const output = execFileSync(
    "docker",
    [
      "exec",
      config.dbContainer,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      sql,
    ],
    {
      encoding: "utf-8",
      timeout: 30_000, // hard cap; today's lesson: never shell-out without timeout
      // Audit C3-perf round-1 closure 2026-05-10: bound the postgres
      // backend separately from the spawn — radius/full-text search can
      // monopolize a connection past the 30s wall-clock kill.
      env: { ...process.env, PGOPTIONS: "-c statement_timeout=25000" },
    },
  ).trim();

  if (!output || output === "" || output === "null") return [];
  return JSON.parse(output) as Array<Record<string, unknown>>;
}
