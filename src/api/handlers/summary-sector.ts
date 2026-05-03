/**
 * GET /summary/sector/:scian — national breakdown of one 2-digit SCIAN.
 *
 * Reads mv_sector_summary, derives the 2-digit prefix from clase_actividad_id,
 * sums nationally and reports top 10 entidades by count.
 *
 * Note: clase_actividad_id is NULL on every record (BuscarEntidad doesn't
 * return it). The 2-digit prefix is derived from CLEE chars 3-4 instead, via
 * a separate aggregation directly against establecimientos.
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import {
  SCIAN_RE,
  type ApiServerConfig,
  type SectorSummaryResult,
} from "../types.js";

export async function summarySectorHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const scian = c.req.param("scian");
  if (!scian || !SCIAN_RE.test(scian)) {
    throw new HttpError(
      `SCIAN inválido "${scian}" — debe ser 2 dígitos`,
      400,
      "validation.scian",
    );
  }

  // PostgREST RPC isn't set up; use direct SQL via the supabase REST query
  // with substr-derived bucket. We aggregate via PostgREST's `select` with
  // count() aggregate using the rest API.
  // Strategy: query establecimientos filtered by SUBSTR(clee, 3, 2) = scian,
  // group by entidad, count. PostgREST doesn't easily express GROUP BY +
  // SUBSTR — fall back to direct entity counts via head request.
  //
  // Cleaner: query mv_sector_summary if a row exists matching the scian on
  // clase_actividad_id LIKE prefix; otherwise answer 0/empty.
  //
  // Simpler still: use PostgREST's like filter on clee prefix per entidad.
  // We do one query per entidad, but parallelized — 32 small requests.

  const ENTIDADES = Array.from({ length: 32 }, (_, i) =>
    String(i + 1).padStart(2, "0"),
  );

  const counts = await Promise.all(
    ENTIDADES.map(async (ent) => {
      // CLEE structure: <2-digit-entidad><2-digit-scian-bucket>... so
      // we filter by clee starting with `${ent}${scian}`. PostgREST `like`
      // pattern uses `*` for `%`.
      const params = new URLSearchParams();
      params.set("select", "clee");
      params.set("clee", `like.${ent}${scian}*`);
      params.set("limit", "1"); // we use Prefer: count=exact for the actual count
      const url = `${config.supabaseUrl}/rest/v1/establecimientos?${params.toString()}`;
      const res = await fetch(url, {
        headers: {
          apikey: config.serviceRoleKey,
          Authorization: `Bearer ${config.serviceRoleKey}`,
          Prefer: "count=exact",
          "Range-Unit": "items",
          Range: "0-0",
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
      // Content-Range: e.g. "0-0/12345" or "*/12345" for count-only
      const cr = res.headers.get("content-range") ?? "";
      const m = cr.match(/\/(\d+)$/);
      const count = m ? parseInt(m[1]!, 10) : 0;
      return { entidad: ent, count };
    }),
  );

  const total_national = counts.reduce((s, x) => s + x.count, 0);
  const top_entidades = counts
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const result: SectorSummaryResult = {
    scian,
    total_national,
    top_entidades,
  };
  return c.json(result);
}
