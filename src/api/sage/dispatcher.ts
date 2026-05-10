/**
 * Dispatches a RouteOutputEndpoint back through the Hono app via
 * in-process app.fetch(). The Sage route already authenticated the
 * caller, so it forwards the API key explicitly to satisfy the
 * downstream auth middleware.
 *
 * Returns the parsed JSON body of the endpoint response or an error
 * code for the LLM to self-correct on the next turn.
 */

import type { Hono } from "hono";
import type { RouteOutputEndpoint } from "./providers/provider.js";
import { SAGE_ENDPOINT_CATALOG } from "./endpoint-catalog.js";

export interface DispatchSuccess {
  ok: true;
  body: unknown;
  status: number;
  endpoint_path: string;
}

export interface DispatchFailure {
  ok: false;
  code:
    | "ENDPOINT_NOT_IN_CATALOG"
    | "ENDPOINT_PARAM_MISSING"
    | "ENDPOINT_HTTP_ERROR";
  message: string;
  status?: number;
}

export type DispatchResult = DispatchSuccess | DispatchFailure;

// Map from spec name → server-side path template. Strings inside `{…}`
// are placeholders filled from params; the rest go into the query
// string. Centralized here so the catalog stays free of paths.
const ENDPOINT_PATHS: Record<string, string> = {
  entidades: "/entidades",
  sectors: "/sectors",
  "summary-entidad": "/summary/entidad/{clave}",
  "summary-sector": "/summary/sector/{scian}",
  "national-treemap": "/analytics/national-treemap",
  "sector-grade-matrix": "/analytics/sector-grade-matrix",
  municipios: "/analytics/municipios",
  "top-sectors": "/analytics/top-sectors",
  "risk-summary": "/analytics/risk-summary",
  "risk-trend": "/analytics/risk-trend",
  "mortality-summary": "/analytics/mortality-summary",
  "mortality-trend": "/analytics/mortality-trend",
  "state-calibrators": "/analytics/state-calibrators",
  "agebs-by-municipio": "/analytics/agebs-by-municipio",
  "ageb-detail": "/analytics/ageb-detail",
  "ageb-farmacia-opportunity": "/analytics/ageb-farmacia-opportunity",
  "opportunity-by-ageb": "/analytics/opportunity-by-ageb",
  "opportunity-by-colonia": "/analytics/opportunity-by-colonia",
  "colonias-by-municipio": "/analytics/colonias-by-municipio",
  "licensed-pharmacies-by-municipio":
    "/analytics/licensed-pharmacies-by-municipio",
  "licensed-pharmacies-by-ageb": "/analytics/licensed-pharmacies-by-ageb",
  "manzanas-by-ageb": "/analytics/manzanas-by-ageb",
  "colonias-by-ageb": "/analytics/colonias-by-ageb",
  "airports-by-municipio": "/analytics/airports-by-municipio",
  "localities-by-municipio": "/analytics/localities-by-municipio",
  "locality-detail": "/analytics/locality-detail",
  "municipio-detail": "/analytics/municipio-detail",
  "entidad-detail": "/analytics/entidad-detail",
};

export function buildEndpointPath(
  endpointName: string,
  params: Record<string, string | number>,
): { ok: true; path: string } | { ok: false; missing: string } {
  const tmpl = ENDPOINT_PATHS[endpointName];
  if (!tmpl) return { ok: false, missing: `endpoint:${endpointName}` };

  // Fill {placeholder}s first.
  let path = tmpl;
  const placeholders = [...tmpl.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
  for (const ph of placeholders) {
    const v = params[ph as string];
    if (v === undefined || v === null) {
      return { ok: false, missing: ph as string };
    }
    path = path.replace(`{${ph}}`, encodeURIComponent(String(v)));
  }

  // Remaining params → query string. Skip those already consumed.
  const consumed = new Set(placeholders);
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (consumed.has(k)) continue;
    if (v === undefined || v === null) continue;
    search.set(k, String(v));
  }
  const qs = search.toString();
  return { ok: true, path: qs ? `${path}?${qs}` : path };
}

export async function dispatchEndpoint(
  app: Hono,
  apiKey: string,
  route: RouteOutputEndpoint,
): Promise<DispatchResult> {
  const inCatalog = SAGE_ENDPOINT_CATALOG.some(
    (e) => e.name === route.endpoint_name,
  );
  if (!inCatalog) {
    return {
      ok: false,
      code: "ENDPOINT_NOT_IN_CATALOG",
      message: `Endpoint "${route.endpoint_name}" is not in the Sage catalog.`,
    };
  }

  const built = buildEndpointPath(route.endpoint_name, route.params);
  if (!built.ok) {
    return {
      ok: false,
      code: "ENDPOINT_PARAM_MISSING",
      message: `Missing required param: ${built.missing}`,
    };
  }

  const url = `http://localhost${built.path}`;
  const res = await app.fetch(
    new Request(url, {
      method: "GET",
      headers: { "X-Api-Key": apiKey },
    }),
  );
  if (!res.ok) {
    const text = await res.text();
    return {
      ok: false,
      code: "ENDPOINT_HTTP_ERROR",
      message: text.slice(0, 240),
      status: res.status,
    };
  }
  const body = (await res.json()) as unknown;
  return { ok: true, body, status: res.status, endpoint_path: built.path };
}

/**
 * Build a digest from raw endpoint or SQL rows. The digest is what gets
 * passed to the narrative writer AND back to the router on subsequent
 * turns — never the full row payload.
 */
export function buildDigest(
  rowsOrBody: unknown,
  firstN: number = 20,
): {
  columns: string[];
  row_count: number;
  first_n_rows: unknown[];
  numeric_stats?: Record<string, { min: number; max: number; mean: number }>;
} {
  // Endpoint bodies are sometimes objects (composite endpoints) and
  // sometimes {rows:[...]} or arrays. Normalize to "array of rows".
  const rows: unknown[] = Array.isArray(rowsOrBody)
    ? rowsOrBody
    : rowsOrBody &&
        typeof rowsOrBody === "object" &&
        Array.isArray((rowsOrBody as Record<string, unknown>)["rows"])
      ? ((rowsOrBody as Record<string, unknown>)["rows"] as unknown[])
      : [rowsOrBody];

  const columns = Array.from(
    new Set(
      rows
        .filter(
          (r): r is Record<string, unknown> =>
            r !== null && typeof r === "object",
        )
        .flatMap((r) => Object.keys(r)),
    ),
  );
  const numericStats: Record<
    string,
    { min: number; max: number; mean: number }
  > = {};
  for (const col of columns) {
    const vals: number[] = [];
    for (const r of rows) {
      if (r && typeof r === "object") {
        const v = (r as Record<string, unknown>)[col];
        if (typeof v === "number" && Number.isFinite(v)) vals.push(v);
        else if (typeof v === "string" && v.length < 32) {
          const n = Number(v);
          if (Number.isFinite(n)) vals.push(n);
        }
      }
    }
    if (vals.length >= 2 && vals.length === rows.length) {
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      numericStats[col] = { min, max, mean };
    }
  }
  return {
    columns,
    row_count: rows.length,
    first_n_rows: rows.slice(0, firstN),
    numeric_stats:
      Object.keys(numericStats).length > 0 ? numericStats : undefined,
  };
}
