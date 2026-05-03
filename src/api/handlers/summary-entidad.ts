/**
 * GET /summary/entidad/:clave — full per-entidad picture.
 *
 * Composes data from:
 *   - mv_coverage (loaded count + first/last loaded timestamps)
 *   - INEGI authoritative counts JSON (operator-verified per entidad)
 *   - Top SCIAN sectors derived from CLEE prefix counts
 *   - Estrato distribution via PostgREST aggregation
 *
 * Reuses statusFor() from coverage-report.ts to keep status thresholds
 * (green ≥99 / yellow 90-99 / red <90 / unverified null) consistent.
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import {
  ENTIDAD_RE,
  type ApiServerConfig,
  type EntidadSummaryResult,
} from "../types.js";
import { loadInegiCounts, statusFor } from "../../analysis/coverage-report.js";

const TOP_SECTORS_LIMIT = 10;

export async function summaryEntidadHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const clave = c.req.param("clave");
  if (!clave || !ENTIDAD_RE.test(clave)) {
    throw new HttpError(
      `entidad inválida "${clave}"`,
      400,
      "validation.entidad",
    );
  }

  // 1. Loaded count (from mv_coverage, falls back to direct count)
  const loaded = await fetchLoadedCount(config, clave);

  // 2. INEGI authoritative count (from JSON file)
  const inegi = loadInegiCounts();
  const inegi_total = inegi.counts[clave] ?? null;
  const coverage_pct =
    inegi_total !== null && inegi_total > 0
      ? Number(((loaded / inegi_total) * 100).toFixed(2))
      : null;
  const status = statusFor(loaded, inegi_total);

  // 3. Top sectors + 4. Estrato distribution — fire in parallel
  const [top_sectors, estrato_distribution] = await Promise.all([
    fetchTopSectors(config, clave),
    fetchEstratoDistribution(config, clave),
  ]);

  const result: EntidadSummaryResult = {
    entidad: clave,
    loaded,
    inegi_total,
    coverage_pct,
    status,
    top_sectors,
    estrato_distribution,
  };
  return c.json(result);
}

async function fetchLoadedCount(
  config: ApiServerConfig,
  clave: string,
): Promise<number> {
  // Prefer mv_coverage if refreshed, else direct count
  const url = `${config.supabaseUrl}/rest/v1/mv_coverage?entidad=eq.${clave}&select=loaded&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
    },
  });
  if (res.ok) {
    const rows = (await res.json()) as Array<{ loaded: number | string }>;
    if (rows.length > 0) return Number(rows[0]!.loaded);
  }

  // Fallback: direct count via Range header
  const fallbackUrl = `${config.supabaseUrl}/rest/v1/establecimientos?entidad=eq.${clave}&select=clee&limit=1`;
  const fb = await fetch(fallbackUrl, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      Prefer: "count=exact",
      Range: "0-0",
    },
  });
  if (!fb.ok) {
    const body = await fb.text();
    throw new HttpError(
      `PostgREST returned HTTP ${fb.status}: ${body.slice(0, 200)}`,
      502,
      "postgrest.error",
    );
  }
  const cr = fb.headers.get("content-range") ?? "";
  const m = cr.match(/\/(\d+)$/);
  return m ? parseInt(m[1]!, 10) : 0;
}

async function fetchTopSectors(
  config: ApiServerConfig,
  clave: string,
): Promise<
  Array<{ scian_id: string; clase_actividad: string | null; count: number }>
> {
  const url = `${config.supabaseUrl}/rest/v1/mv_sector_summary?entidad=eq.${clave}&order=total.desc&limit=${TOP_SECTORS_LIMIT}`;
  const res = await fetch(url, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
    },
  });
  // Audit W5: only 404 (mv missing — operator hasn't applied views yet) is
  // silently empty. Real errors (500/502/etc) propagate so a dashboard
  // doesn't read "no top sectors" when PostgREST is actually down.
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text();
    throw new HttpError(
      `mv_sector_summary returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      502,
      "postgrest.error",
    );
  }
  const rows = (await res.json()) as Array<{
    clase_actividad_id: string | null;
    clase_actividad: string | null;
    total: number | string;
  }>;
  return rows.map((r) => ({
    scian_id: r.clase_actividad_id ?? "(null)",
    clase_actividad: r.clase_actividad,
    count: Number(r.total),
  }));
}

async function fetchEstratoDistribution(
  config: ApiServerConfig,
  clave: string,
): Promise<Array<{ estrato: string; count: number }>> {
  const url = `${config.supabaseUrl}/rest/v1/mv_estrato_por_entidad?entidad=eq.${clave}&order=total.desc`;
  const res = await fetch(url, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
    },
  });
  // Audit W5: same as fetchTopSectors — 404 = silent, others propagate
  if (res.status === 404) return [];
  if (!res.ok) {
    const body = await res.text();
    throw new HttpError(
      `mv_estrato_por_entidad returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      502,
      "postgrest.error",
    );
  }
  const rows = (await res.json()) as Array<{
    estrato: string;
    total: number | string;
  }>;
  return rows.map((r) => ({ estrato: r.estrato, count: Number(r.total) }));
}
