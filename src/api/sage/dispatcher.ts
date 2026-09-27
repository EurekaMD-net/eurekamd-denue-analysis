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
export const ENDPOINT_PATHS: Record<string, string> = {
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

// Endpoints that return ONE record (nested layer objects, sometimes with
// small sample arrays such as ageb-detail's top_sectors). Their digest is
// the record flattened one level, never one of its sample arrays.
const SINGLE_RECORD_ENDPOINTS = new Set([
  "ageb-detail",
  "municipio-detail",
  "entidad-detail",
  "locality-detail",
]);

export function isSingleRecordEndpoint(endpointName: string): boolean {
  return SINGLE_RECORD_ENDPOINTS.has(endpointName);
}

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
  signal?: AbortSignal,
): Promise<DispatchResult> {
  const spec = SAGE_ENDPOINT_CATALOG.find(
    (e) => e.name === route.endpoint_name,
  );
  if (!spec) {
    return {
      ok: false,
      code: "ENDPOINT_NOT_IN_CATALOG",
      message: `Endpoint "${route.endpoint_name}" is not in the Sage catalog.`,
    };
  }

  // Catalog `required` params are checked here, before app.fetch, so a
  // missing query param is a self-correctable ENDPOINT_PARAM_MISSING and
  // not an opaque 400 from the handler.
  const missing = spec.params_schema.required?.find((k) => {
    const v = route.params[k];
    return v === undefined || v === null || v === "";
  });
  if (missing) {
    return {
      ok: false,
      code: "ENDPOINT_PARAM_MISSING",
      message: `Missing required param: ${missing}`,
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
      signal,
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

// Byte budget for the rows a digest carries (narrative prompt + the
// persisted first_5_rows). Rows are cut by this as well as by count.
export const DIGEST_ROWS_MAX_BYTES = 4096;

// ID-like columns are never numeric measures: no stats, no chart axis.
export const ID_COLUMN_RE = /^(cve_|clave|cvegeo|scian|ranking)/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Normalize an endpoint/SQL body to rows + scalar context.
 *   - bare array → rows
 *   - keyed object ({entidades:[…]}, {cve_mun, series:[…]}, …) → the
 *     largest top-level array of objects is the rows; scalar siblings
 *     become `context`
 *   - single record (singleRecord, or no array of objects) → one row,
 *     nested objects flattened one level as `parent.child`
 */
export function normalizeBody(
  body: unknown,
  opts: { singleRecord?: boolean } = {},
): { rows: unknown[]; context?: Record<string, unknown> } {
  if (Array.isArray(body)) return { rows: body };
  if (!isPlainObject(body)) return { rows: body === undefined ? [] : [body] };

  if (!opts.singleRecord) {
    let rowsKey: string | undefined;
    for (const [k, v] of Object.entries(body)) {
      if (
        Array.isArray(v) &&
        v.every(isPlainObject) &&
        (rowsKey === undefined ||
          v.length > (body[rowsKey] as unknown[]).length)
      ) {
        rowsKey = k;
      }
    }
    if (rowsKey !== undefined) {
      const context: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(body)) {
        if (k !== rowsKey && (v === null || typeof v !== "object")) {
          context[k] = v;
        }
      }
      return {
        rows: body[rowsKey] as unknown[],
        context: Object.keys(context).length > 0 ? context : undefined,
      };
    }
  }

  const flat: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (isPlainObject(v)) {
      for (const [ck, cv] of Object.entries(v)) flat[`${k}.${ck}`] = cv;
    } else {
      flat[k] = v;
    }
  }
  return { rows: [flat] };
}

// Keep a row's entries, in order, while the serialized row fits `maxBytes`.
function trimRow(row: unknown, maxBytes: number): unknown {
  if (!isPlainObject(row)) {
    return (JSON.stringify(row) ?? "null").slice(0, maxBytes);
  }
  const out: Record<string, unknown> = {};
  let used = 2;
  for (const [k, v] of Object.entries(row)) {
    const size = JSON.stringify({ [k]: v }).length - 1;
    if (used + size > maxBytes) continue;
    out[k] = v;
    used += size;
  }
  return out;
}

function capRows(rows: unknown[], maxRows: number, maxBytes: number) {
  const out: unknown[] = [];
  let used = 2;
  for (const r of rows.slice(0, maxRows)) {
    const size = (JSON.stringify(r) ?? "null").length + 1;
    if (used + size > maxBytes) {
      if (out.length === 0) out.push(trimRow(r, maxBytes));
      break;
    }
    out.push(r);
    used += size;
  }
  return out;
}

// Numeric value of a cell, or undefined when it is not a measure: NULL,
// empty strings and zero-padded codes ("01001") are not numbers.
function toMeasure(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || v.length >= 32 || v.trim() === "") {
    return undefined;
  }
  if (/^[-+]?0\d/.test(v.trim())) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Build a digest from raw endpoint or SQL rows. The digest is what gets
 * passed to the narrative writer AND back to the router on subsequent
 * turns — never the full row payload.
 */
export function buildDigest(
  rowsOrBody: unknown,
  firstN: number = 20,
  opts: { singleRecord?: boolean } = {},
): {
  columns: string[];
  row_count: number;
  first_n_rows: unknown[];
  numeric_stats?: Record<string, { min: number; max: number; mean: number }>;
  context?: Record<string, unknown>;
} {
  const { rows, context } = normalizeBody(rowsOrBody, opts);

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
    if (ID_COLUMN_RE.test(col)) continue;
    const vals: number[] = [];
    let present = 0;
    for (const r of rows) {
      if (r && typeof r === "object") {
        const v = (r as Record<string, unknown>)[col];
        if (v === null || v === undefined) continue;
        present++;
        const n = toMeasure(v);
        if (n !== undefined) vals.push(n);
      }
    }
    // NULLs are skipped, not counted as 0; every non-NULL cell must be
    // a number for the column to be numeric.
    if (vals.length >= 2 && vals.length === present) {
      const min = Math.min(...vals);
      const max = Math.max(...vals);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      numericStats[col] = { min, max, mean };
    }
  }
  return {
    columns,
    row_count: rows.length,
    first_n_rows: capRows(rows, firstN, DIGEST_ROWS_MAX_BYTES),
    numeric_stats:
      Object.keys(numericStats).length > 0 ? numericStats : undefined,
    ...(context ? { context } : {}),
  };
}
