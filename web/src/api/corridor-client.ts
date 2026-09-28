/**
 * Client for the corridor tool: corridor density (POST), street geometry
 * (GET, 202-while-extracting polling) and the map-centre municipio lookup
 * (the existing GET /resolve/ageb point-in-polygon resolver).
 *
 * All requests go through apiFetch (Bearer JWT, path validation, 30 s
 * timeout, ApiError on non-2xx). A 202 is `res.ok`, so apiFetch returns it
 * and this module reads the status itself.
 */

import { ApiError, apiFetch } from "./client";
import {
  CORRIDOR_RESULT,
  RESOLVE_AGEB_RESULT,
  STREET_EXTRACTING,
  STREET_OK,
  type CorridorRequest,
  type CorridorResult,
  type StreetGeometryResponse,
  type StreetOk,
} from "./corridor-types";

/** Fallback when a 202 carries neither `retry_after_s` nor Retry-After. */
export const DEFAULT_RETRY_AFTER_S = 30;
/** Bounds on the server-supplied poll interval. */
const RETRY_MIN_S = 2;
const RETRY_MAX_S = 120;
/** 30 polls × the default 30 s ≈ 15 min: one extraction's 10-min server
 * cap plus part of a queue wait (extractions run one at a time). A longer
 * queue ends in `osm.poll_exhausted`; resubmitting resumes the wait. */
export const MAX_STREET_POLLS = 30;

export const OSM_FAILED_MESSAGE = "El servicio OSM falló; reintenta";
/** Wait before the one transparent retry of a 429 `osm.busy`, when the
 * response carries no Retry-After; the header is capped at 10 s. */
const BUSY_RETRY_DEFAULT_S = 1;
const BUSY_RETRY_MAX_S = 10;
export const CORRIDOR_FAILED_MESSAGE =
  "La consulta del corredor falló; reintenta";

export async function fetchCorridorDensity(
  req: CorridorRequest,
  signal?: AbortSignal,
): Promise<CorridorResult> {
  const res = await apiFetch("/analytics/corridor-density", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
    signal,
  });
  const body: unknown = await res.json();
  return CORRIDOR_RESULT.parse(body);
}

function clampRetry(s: number): number {
  if (!Number.isFinite(s)) return DEFAULT_RETRY_AFTER_S;
  return Math.min(RETRY_MAX_S, Math.max(RETRY_MIN_S, s));
}

/** One street-geometry call: 200 → matches, 202 → extracting. */
export async function fetchStreetGeometry(
  cveMun: string,
  q: string,
  signal?: AbortSignal,
): Promise<StreetGeometryResponse> {
  // encodeURIComponent, not URLSearchParams: its "+" for spaces fails
  // apiFetch's SAFE_QUERY check ("av. insurgentes" must reach the API).
  const res = await apiFetch(
    `/analytics/street-geometry?cve_mun=${encodeURIComponent(cveMun)}` +
      `&q=${encodeURIComponent(q.trim())}`,
    { signal },
  );
  const body: unknown = await res.json();
  if (res.status === 202) {
    const b = STREET_EXTRACTING.parse(body);
    const header = Number(res.headers.get("Retry-After"));
    const retry =
      b.retry_after_s ?? (header > 0 ? header : DEFAULT_RETRY_AFTER_S);
    return {
      status: "extracting",
      cve_mun: b.cve_mun,
      retry_after_s: clampRetry(retry),
    };
  }
  return STREET_OK.parse(body);
}

/** setTimeout that rejects with the signal's reason when aborted. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PollOptions {
  signal?: AbortSignal;
  /** Called on every 202, before sleeping `retryAfterS`. */
  onExtracting?: (retryAfterS: number, attempt: number) => void;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  maxPolls?: number;
}

/**
 * Calls street-geometry until the cache is hot, sleeping `retry_after_s`
 * between 202s. Throws ApiError on 4xx/5xx (from apiFetch), on abort, and
 * with code `osm.poll_exhausted` after `maxPolls` 202s.
 */
export async function pollStreetGeometry(
  cveMun: string,
  q: string,
  opts: PollOptions = {},
): Promise<StreetOk> {
  const sleep = opts.sleep ?? abortableSleep;
  const maxPolls = opts.maxPolls ?? MAX_STREET_POLLS;
  let busyRetried = false;
  for (let attempt = 1; attempt <= maxPolls; attempt++) {
    let r: StreetGeometryResponse;
    try {
      r = await fetchStreetGeometry(cveMun, q, opts.signal);
    } catch (err) {
      // 429 osm.busy: the extractor is momentarily locked. Retry once per
      // search after Retry-After; a second busy surfaces to the user.
      if (
        busyRetried ||
        !(err instanceof ApiError && err.status === 429 && err.code === "osm.busy")
      )
        throw err;
      busyRetried = true;
      const waitS = Math.min(
        BUSY_RETRY_MAX_S,
        err.retryAfterS ?? BUSY_RETRY_DEFAULT_S,
      );
      await sleep(waitS * 1000, opts.signal);
      attempt--;
      continue;
    }
    if (r.status === "ok") return r;
    opts.onExtracting?.(r.retry_after_s, attempt);
    await sleep(r.retry_after_s * 1000, opts.signal);
  }
  throw new ApiError(
    "La extracción de vialidades sigue en curso; reintenta en unos minutos",
    504,
    "osm.poll_exhausted",
  );
}

/** Municipio (cve_mun) containing a point, via GET /resolve/ageb. */
export async function resolveMunicipio(
  lon: number,
  lat: number,
  signal?: AbortSignal,
): Promise<string> {
  // The resolver's regex allows ≤10 decimals; 6 dp is ~0.1 m.
  const sp = new URLSearchParams({ lat: lat.toFixed(6), lon: lon.toFixed(6) });
  const res = await apiFetch(`/resolve/ageb?${sp}`, { signal });
  const body: unknown = await res.json();
  return RESOLVE_AGEB_RESULT.parse(body).cve_mun;
}

/** Fixed text for street-service codes (the body `code`, P2 fixes). Checked
 * before the status map so a 429 `osm.queue_full` is not read as the rate
 * limiter's 429. */
const OSM_CODE_MESSAGES: Record<string, string> = {
  "osm.bbox_too_large":
    "Municipio demasiado extenso para extraer en línea; pide al operador precalentarlo",
  "osm.queue_full": "Cola de extracción llena; reintenta en un minuto",
  "osm.cold_limit":
    "Límite de extracciones de municipios nuevos alcanzado (10 por hora); reintenta más tarde",
  "osm.busy": "Servicio ocupado; reintenta",
  "osm.cache_budget": "Servicio OSM no disponible (capacidad); avisa al operador",
  "osm.source_missing":
    "Servicio OSM no disponible (capacidad); avisa al operador",
};

/** The area cap fires on long lines × large buffers (≈35 km at 100 m,
 * ≈3 km at 1000 m); the API message says what, this says what to do. */
export const AREA_HINT = "reduce el buffer o acorta el corredor";

/** Fixed text for statuses whose API/proxy message is not user copy. */
const STATUS_MESSAGES: Record<number, string> = {
  401: "Sesión expirada; vuelve a iniciar sesión",
  413: "Solicitud demasiado grande",
  429: "Demasiadas solicitudes; espera un minuto",
};

/**
 * Text for the panel. 400 (validation) and 404 (resolver: no AGEB)
 * messages are written in Spanish for the user and shown verbatim;
 * 401/413/429 map to fixed lines; 5xx bodies are generic by design (the
 * error middleware hides internals), so they map to a fixed retry line.
 * `osm` selects the street-service wording.
 */
export function corridorErrorMessage(err: unknown, osm = false): string {
  if (err instanceof ApiError) {
    const byCode = err.code ? OSM_CODE_MESSAGES[err.code] : undefined;
    if (byCode) return byCode;
    if (err.code === "validation.geometry.area")
      return `${err.message.trimEnd()} — ${AREA_HINT}`;
    if (err.status === 400 || err.status === 404) return err.message;
    const fixed = STATUS_MESSAGES[err.status];
    if (fixed) return fixed;
    if (err.code === "osm.poll_exhausted") return err.message;
  }
  return osm ? OSM_FAILED_MESSAGE : CORRIDOR_FAILED_MESSAGE;
}

