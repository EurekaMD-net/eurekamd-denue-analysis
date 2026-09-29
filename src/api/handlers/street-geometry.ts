/**
 * GET /analytics/street-geometry?cve_mun=09015&q=reforma
 *
 * Street geometry (GeoJSON MultiLineString per named street) from the
 * per-municipio OSM road extract cached on disk (src/osm/osmium.ts).
 *
 *   cve_mun — 5-digit INEGI municipio key; must exist in mun_polygons_2025
 *   q       — no control characters; 4..80 chars once normalised
 *             (normalizeName: accents stripped, whitespace collapsed)
 *
 * Cache hot  → 200 { cve_mun, q, status:"ok", matches:[...] } (matches may be []).
 *              At most HOT_CONCURRENCY lookups at once, else 429 osm.busy.
 * Cache cold → kicks the extraction (process-wide queue, concurrency 1) and
 *              returns 202 { status:"extracting", cve_mun, retry_after_s:30 }
 *              with `Retry-After: 30`; also 202 while it is in flight. Refused:
 *                429 osm.queue_full       — MAX_PENDING municipios already queued
 *                429 osm.cold_limit       — COLD_EXTRACT_LIMIT admissions per
 *                                           principal+IP per hour (hits never count)
 *                503 osm.cache_budget     — < 5 GB free or > 20 GB cached; re-checked
 *                                           when the queued job starts (reported once
 *                                           to the next caller)
 *                404 municipio.not_found  — cvegeo not in mun_polygons_2025
 *                409 osm.bbox_too_large   — padded bbox > 1 deg² (prewarm via CLI --force)
 * Extraction failed → 502 osm.extract_failed once (stderr tail logged
 *              server-side only); the next request starts a fresh attempt.
 * PBF missing → 503 osm.source_missing.
 */

import { existsSync } from "node:fs";
import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import type { ApiError, ApiServerConfig } from "../types.js";
import {
  clientIp,
  principalOf,
  trustProxyFromEnv,
} from "../middleware/rate-limit.js";
import {
  CVE_MUN_RE,
  OsmCacheBudgetError,
  OsmExtractError,
  OsmLockHeldError,
  PBF_PATH,
  cachePaths,
  checkCacheBudget,
  extractMunicipioRoads,
  fetchMunBbox,
  isBboxTooLarge,
  isCacheHot,
  sweepStaleTemps,
  type Bbox,
} from "../../osm/osmium.js";
import { extractQueue, type ExtractQueue } from "../../osm/extract-queue.js";
import {
  findStreets,
  normalizeName,
  type StreetLookupResult,
} from "../../osm/street-index.js";

const MIN_Q_LEN = 4;
const MAX_Q_LEN = 80;
const RETRY_AFTER_S = 30;
const QUEUE_FULL_RETRY_S = 60;
const BUSY_RETRY_S = 1;
/** Distinct municipios queued or extracting before cold requests get 429. */
export const MAX_PENDING = 3;
/** Concurrent hot-cache lookups (each streams a file of up to tens of MB). */
export const HOT_CONCURRENCY = 2;
/**
 * Cold extractions one principal+IP may start per window. The cache has no
 * eviction, so without it one caller could cycle every municipio and fill
 * the 20 GB budget for good. Hot lookups never count; X-Api-Key included.
 */
export const COLD_EXTRACT_LIMIT = { max: 10, windowMs: 3_600_000 } as const;
const COLD_LIMIT_MAX_KEYS = 10_000;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export interface StreetGeometryDeps {
  sourceAvailable: () => boolean;
  isCacheHot: (cveMun: string) => boolean;
  findStreets: (path: string, q: string) => Promise<StreetLookupResult>;
  fetchMunBbox: (cveMun: string, config: ApiServerConfig) => Promise<Bbox | null>;
  cacheBudgetOk: () => boolean;
  extract: (cveMun: string, bbox: Bbox) => Promise<unknown>;
  queue: ExtractQueue;
  cachePath: (cveMun: string) => string;
  /** Runs once when the handler is created (process start). */
  sweep: () => void;
  /** Bucket for COLD_EXTRACT_LIMIT: principal + client IP, as the route limiters. */
  coldKey: (c: Context) => string;
}

const defaultDeps: StreetGeometryDeps = {
  sourceAvailable: () => existsSync(PBF_PATH),
  isCacheHot: (cveMun) => isCacheHot(cveMun),
  findStreets,
  fetchMunBbox: (cveMun, config) =>
    fetchMunBbox(cveMun, { container: config.dbContainer }),
  cacheBudgetOk: () => checkCacheBudget().ok,
  extract: (cveMun, bbox) => extractMunicipioRoads(cveMun, bbox),
  queue: extractQueue,
  cachePath: (cveMun) => cachePaths(cveMun).geojson,
  sweep: () => {
    const removed = sweepStaleTemps();
    if (removed.length > 0) {
      process.stderr.write(
        `[street-geometry] swept stale osm-cache leftovers: ${removed.join(" ")}\n`,
      );
    }
  },
  coldKey: (c) =>
    `p:${principalOf(c) ?? "-"}|ip:${clientIp(c, trustProxyFromEnv())}`,
};

function refuse(
  c: Context,
  status: 429,
  code: string,
  error: string,
  retryAfterS: number,
): Response {
  const body: ApiError = { error, code };
  return c.json(body, status, { "Retry-After": String(retryAfterS) });
}

function budgetError(): HttpError {
  return new HttpError(
    "osm-cache budget exceeded (free space < 5 GB or cache > 20 GB)",
    503,
    "osm.cache_budget",
  );
}

export function createStreetGeometryHandler(
  overrides: Partial<StreetGeometryDeps> = {},
) {
  const deps: StreetGeometryDeps = { ...defaultDeps, ...overrides };
  deps.sweep();
  // Failures of background extractions, reported once to the next caller.
  const failures = new Map<string, HttpError>();
  let hotActive = 0;
  // COLD_EXTRACT_LIMIT: admission timestamps per coldKey.
  const coldAdmissions = new Map<string, number[]>();
  const coldRetryAfterS = (key: string, now: number): number => {
    const recent = (coldAdmissions.get(key) ?? []).filter(
      (t) => now - t < COLD_EXTRACT_LIMIT.windowMs,
    );
    if (recent.length === 0) coldAdmissions.delete(key);
    else coldAdmissions.set(key, recent);
    if (recent.length < COLD_EXTRACT_LIMIT.max) return 0;
    return Math.max(
      1,
      Math.ceil((COLD_EXTRACT_LIMIT.windowMs - (now - recent[0]!)) / 1000),
    );
  };
  const recordCold = (key: string, now: number): void => {
    if (!coldAdmissions.has(key) && coldAdmissions.size >= COLD_LIMIT_MAX_KEYS) {
      for (const [k, times] of coldAdmissions) {
        if (now - times.at(-1)! >= COLD_EXTRACT_LIMIT.windowMs) coldAdmissions.delete(k);
      }
      if (coldAdmissions.size >= COLD_LIMIT_MAX_KEYS) {
        coldAdmissions.delete(coldAdmissions.keys().next().value!);
      }
    }
    coldAdmissions.set(key, [...(coldAdmissions.get(key) ?? []), now]);
  };

  return async function streetGeometryHandler(
    c: Context,
    config: ApiServerConfig,
  ): Promise<Response> {
    const cveMun = c.req.query("cve_mun") ?? "";
    const qRaw = c.req.query("q") ?? "";

    if (!CVE_MUN_RE.test(cveMun)) {
      throw new HttpError(
        `cve_mun inválido "${cveMun.slice(0, 20)}" — esperado 5 dígitos`,
        400,
        "validation.cve_mun",
      );
    }
    if (CONTROL_RE.test(qRaw)) {
      throw new HttpError("q contiene caracteres de control", 400, "validation.q");
    }
    const q = qRaw.trim();
    const qLen = normalizeName(q).length;
    if (qLen < MIN_Q_LEN || qLen > MAX_Q_LEN) {
      throw new HttpError(
        `q debe tener entre ${MIN_Q_LEN} y ${MAX_Q_LEN} caracteres`,
        400,
        "validation.q",
      );
    }

    if (!deps.sourceAvailable()) {
      throw new HttpError(
        `OSM source PBF missing at ${PBF_PATH}`,
        503,
        "osm.source_missing",
      );
    }

    if (deps.isCacheHot(cveMun)) {
      if (hotActive >= HOT_CONCURRENCY) {
        return refuse(c, 429, "osm.busy", "Demasiadas búsquedas de calles en curso", BUSY_RETRY_S);
      }
      hotActive++;
      let result: StreetLookupResult;
      try {
        result = await deps.findStreets(deps.cachePath(cveMun), q);
      } finally {
        hotActive--;
      }
      if (result.malformed > 0) {
        process.stderr.write(
          `[street-geometry] ${cveMun}: ${result.malformed} malformed line(s) skipped\n`,
        );
      }
      return c.json({
        cve_mun: cveMun,
        q,
        status: "ok",
        matches: result.matches,
        ...(result.truncated ? { truncated: true } : {}),
      });
    }

    const failure = failures.get(cveMun);
    if (failure !== undefined) {
      failures.delete(cveMun);
      throw failure;
    }

    const extracting = () =>
      c.json(
        { status: "extracting", cve_mun: cveMun, retry_after_s: RETRY_AFTER_S },
        202,
        { "Retry-After": String(RETRY_AFTER_S) },
      );
    const queueFull = () =>
      refuse(
        c,
        429,
        "osm.queue_full",
        "Cola de extracción OSM llena; reintenta más tarde",
        QUEUE_FULL_RETRY_S,
      );

    const coldLimited = (retryAfterS: number) =>
      refuse(
        c,
        429,
        "osm.cold_limit",
        `Límite de extracciones OSM nuevas alcanzado (${COLD_EXTRACT_LIMIT.max} por hora); reintenta más tarde`,
        retryAfterS,
      );
    const coldKey = deps.coldKey(c);

    if (deps.queue.isPending(cveMun)) return extracting();
    if (deps.queue.size() >= MAX_PENDING) return queueFull();
    const limited = coldRetryAfterS(coldKey, Date.now());
    if (limited > 0) return coldLimited(limited);
    if (!deps.cacheBudgetOk()) throw budgetError();

    const bbox = await deps.fetchMunBbox(cveMun, config);
    if (bbox === null) {
      throw new HttpError(
        `municipio "${cveMun}" no existe`,
        404,
        "municipio.not_found",
      );
    }
    if (isBboxTooLarge(bbox)) {
      throw new HttpError(
        `municipio "${cveMun}" demasiado extenso para extraer bajo demanda; prewarm it with \`scripts/osm-prewarm.ts ${cveMun} --force\``,
        409,
        "osm.bbox_too_large",
      );
    }

    // Re-check after the await: another request may have queued meanwhile.
    if (deps.queue.isPending(cveMun)) return extracting();
    if (deps.queue.size() >= MAX_PENDING) return queueFull();
    const now = Date.now();
    const limitedNow = coldRetryAfterS(coldKey, now);
    if (limitedNow > 0) return coldLimited(limitedNow);
    recordCold(coldKey, now);
    deps.queue
      .enqueue(cveMun, async () => {
        // The budget was checked before queueing; earlier jobs may have
        // filled the cache since, so check again when this one starts.
        if (!deps.cacheBudgetOk()) throw new OsmCacheBudgetError();
        return deps.extract(cveMun, bbox);
      })
      .catch((err: unknown) => {
        // The prewarm CLI is building it: not a failure, the next request
        // finds it hot or re-queues.
        if (err instanceof OsmLockHeldError) return;
        if (err instanceof OsmCacheBudgetError) {
          failures.set(cveMun, budgetError());
          return;
        }
        const tail = err instanceof OsmExtractError ? err.stderrTail : "";
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[street-geometry] extract ${cveMun} failed: ${msg}\n${tail}\n`,
        );
        failures.set(
          cveMun,
          new HttpError(`extract ${cveMun} failed: ${msg}`, 502, "osm.extract_failed"),
        );
      });
    return extracting();
  };
}

export const streetGeometryHandler = createStreetGeometryHandler();
