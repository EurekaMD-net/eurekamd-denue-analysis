/**
 * GET /entidades — dropdown source for the analyzer frontend.
 *
 * Returns 32 entries (one per Mexican state, claves 01-32) with:
 *  - clave + nombre from the ESTADOS map
 *  - loaded count via PostgREST (mv_coverage if applied, else direct count)
 *  - inegi_total + status from the verified counts JSON
 *
 * Designed for the analyzer's filter panel — every payload member is
 * needed to render a labelled dropdown with green/yellow/red/unverified
 * dots next to each state.
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import {
  type ApiServerConfig,
  type EntidadDropdownEntry,
  type EntidadesResult,
} from "../types.js";
import { ESTADOS, type EstadoClave } from "../../extractor/types.js";
import { loadInegiCounts, statusFor } from "../../analysis/coverage-report.js";

interface CoverageRow {
  entidad: string;
  loaded: number | string;
}

// ECMAScript stores object keys "10"-"32" as integer-indexed (numeric order)
// BEFORE string-indexed "01"-"09" — so a naive Object.keys(ESTADOS) gives
// 10..32 then 01..09. Lexicographic sort restores 01..32 since both groups
// have the same 2-char width.
const CLAVES = (Object.keys(ESTADOS) as EstadoClave[]).sort();

export async function entidadesHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const loadedByClave = await fetchLoadedByEntidad(config);
  const inegi = loadInegiCounts();

  const entidades: EntidadDropdownEntry[] = CLAVES.map((clave) => {
    const loaded = loadedByClave.get(clave) ?? 0;
    const inegi_total = inegi.counts[clave] ?? null;
    return {
      clave,
      nombre: ESTADOS[clave],
      loaded,
      inegi_total,
      status: statusFor(loaded, inegi_total),
    };
  });

  const payload: EntidadesResult = { entidades };
  // Short max-age: dropdown source rarely changes mid-session. Caps the
  // damage when the fallback path is active and would otherwise fire
  // 32 parallel count requests on every render. Vary on X-Api-Key so a
  // shared cache never crosses keys.
  c.header("Cache-Control", "public, max-age=60");
  c.header("Vary", "X-Api-Key");
  return c.json(payload);
}

/**
 * Try mv_coverage first (cheap if applied). Fall back to GROUP BY entidad
 * when the view is missing — slower but deterministic. Both paths return
 * the same Map<clave, loaded>.
 */
async function fetchLoadedByEntidad(
  config: ApiServerConfig,
): Promise<Map<string, number>> {
  const mvUrl = `${config.supabaseUrl}/rest/v1/mv_coverage?select=entidad,loaded`;
  const mvRes = await fetch(mvUrl, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
    },
  });
  if (mvRes.ok) {
    const rows = (await mvRes.json()) as CoverageRow[];
    const map = new Map<string, number>();
    for (const r of rows) map.set(r.entidad, Number(r.loaded));
    return map;
  }
  // 404 = mv_coverage not applied yet (Phase 4 runners haven't been executed
  // against this DB). Anything else is a real error and propagates.
  if (mvRes.status !== 404) {
    const body = await mvRes.text();
    throw new HttpError(
      `mv_coverage returned HTTP ${mvRes.status}: ${body.slice(0, 200)}`,
      502,
      "postgrest.error",
    );
  }
  return fallbackGroupByEntidad(config);
}

/**
 * Fallback path: PostgREST does not support GROUP BY, so we issue 32
 * count-only Range requests in parallel — one per entidad. Each request
 * is cheap (PostgREST returns the count via Content-Range header).
 */
async function fallbackGroupByEntidad(
  config: ApiServerConfig,
): Promise<Map<string, number>> {
  const results = await Promise.all(
    CLAVES.map(async (clave) => {
      const url = `${config.supabaseUrl}/rest/v1/establecimientos?entidad=eq.${clave}&select=clee&limit=1`;
      const res = await fetch(url, {
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          Prefer: "count=exact",
          Range: "0-0",
        },
      });
      if (!res.ok) {
        const body = await res.text();
        throw new HttpError(
          `establecimientos count for ${clave} returned HTTP ${res.status}: ${body.slice(0, 200)}`,
          502,
          "postgrest.error",
        );
      }
      const cr = res.headers.get("content-range") ?? "";
      const m = cr.match(/\/(\d+)$/);
      const count = m && m[1] ? parseInt(m[1], 10) : 0;
      return [clave, count] as const;
    }),
  );
  return new Map(results);
}
