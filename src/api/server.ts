/**
 * Phase 5 + P1 — HTTP API server factory.
 *
 * createServer(config) returns a Hono app instance. Tests call app.fetch()
 * directly with a Request object, no live server. scripts/serve.ts wraps
 * with @hono/node-server for production.
 *
 * Routes:
 *   GET /health                                — liveness check (unauthenticated)
 *   GET /search?q=&entidad=&from=&radius_km=&page=&limit=
 *   GET /establishment/:clee
 *   GET /summary/sector/:scian
 *   GET /summary/entidad/:clave
 *   GET /clusters?entidad=&scian=&k=
 *   GET /entidades                             — dropdown source (P1)
 *   GET /sectors                               — dropdown source (P1)
 *   GET /tiles/:z/:x/:y.mvt?entidad=&sector=   — vector tile (P1, rate-limited)
 *   GET /analytics/national-treemap            — 32-entidad join (P2 Locust)
 *   GET /analytics/sector-grade-matrix         — SCIAN×IRS heatmap (P2 Locust)
 *   GET /analytics/municipios?entidad=XX       — per-municipio joined view (P2 Locust)
 *   GET /analytics/top-sectors?entidad=XX      — top SCIAN sectors by entidad
 *   GET /analytics/risk-summary?entidad=XX     — per-municipio SESNSP risk profile
 *   GET /analytics/risk-trend?cve_mun=NNNNN    — monthly delitos time series
 *   GET /analytics/mortality-summary?entidad=XX — per-municipio EDR mortality
 *   GET /analytics/mortality-trend?cve_mun=NNNNN — annual mortality time series
 *
 * All routes except /health require X-Api-Key header matching config.apiKey.
 * /tiles is additionally rate-limited per IP (60 req/sec, sized for
 * MapLibre's viewport burst).
 */

import { Hono } from "hono";
import type { ApiServerConfig } from "./types.js";
import { makeAuthMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error.js";
import { logMiddleware } from "./middleware/log.js";
import { makeRateLimitMiddleware } from "./middleware/rate-limit.js";
import { searchHandler } from "./handlers/search.js";
import { establishmentHandler } from "./handlers/establishment.js";
import { summarySectorHandler } from "./handlers/summary-sector.js";
import { summaryEntidadHandler } from "./handlers/summary-entidad.js";
import { clustersHandler } from "./handlers/clusters.js";
import { entidadesHandler } from "./handlers/entidades.js";
import { sectorsHandler } from "./handlers/sectors.js";
import { tilesHandler } from "./handlers/tiles.js";
import {
  mortalitySummaryHandler,
  mortalityTrendHandler,
  municipiosAnalyticsHandler,
  nationalTreemapHandler,
  riskSummaryHandler,
  riskTrendHandler,
  sectorGradeMatrixHandler,
  topSectorsByEntidadHandler,
} from "./handlers/analytics.js";

export function createServer(config: ApiServerConfig): Hono {
  if (!config.supabaseUrl)
    throw new Error("createServer: supabaseUrl is required");
  if (!config.serviceRoleKey)
    throw new Error("createServer: serviceRoleKey is required");
  if (!config.apiKey) throw new Error("createServer: apiKey is required");
  if (!config.dbContainer)
    throw new Error("createServer: dbContainer is required");

  const app = new Hono();

  // Global: log every request; uncaught errors → errorHandler (Hono's onError)
  app.use("*", logMiddleware);
  app.onError(errorHandler);

  // Public liveness endpoint — no auth so probes can hit it
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "denue-api",
      time: new Date().toISOString(),
    }),
  );

  // Authenticated routes
  const auth = makeAuthMiddleware(config.apiKey);
  app.use("/search", auth);
  app.use("/establishment/*", auth);
  app.use("/summary/*", auth);
  app.use("/clusters", auth);
  app.use("/entidades", auth);
  app.use("/sectors", auth);
  app.use("/tiles/*", auth);
  app.use("/analytics/*", auth);

  // /tiles also gets a per-IP rate limit on top of auth. Sized for
  // MapLibre's burst pattern: a single viewport at zoom 5 covering
  // Mexico fetches ~28 tiles in parallel at page load. The old 5/s
  // limit dropped 80% of those tiles to 429, leaving the user with a
  // near-empty map. 60/s/IP comfortably absorbs an initial burst plus
  // a follow-on pan; the 50k-features-per-tile cap inside the handler
  // is the real abuse defense.
  app.use("/tiles/*", makeRateLimitMiddleware({ max: 60, windowMs: 1000 }));

  app.get("/search", (c) => searchHandler(c, config));
  app.get("/establishment/:clee", (c) => establishmentHandler(c, config));
  app.get("/summary/sector/:scian", (c) => summarySectorHandler(c, config));
  app.get("/summary/entidad/:clave", (c) => summaryEntidadHandler(c, config));
  app.get("/clusters", (c) => clustersHandler(c, config));
  app.get("/entidades", (c) => entidadesHandler(c, config));
  app.get("/sectors", (c) => sectorsHandler(c, config));
  app.get("/tiles/:z/:x/:y", (c) => tilesHandler(c, config));
  app.get("/analytics/national-treemap", (c) =>
    nationalTreemapHandler(c, config),
  );
  app.get("/analytics/sector-grade-matrix", (c) =>
    sectorGradeMatrixHandler(c, config),
  );
  app.get("/analytics/municipios", (c) =>
    municipiosAnalyticsHandler(c, config),
  );
  app.get("/analytics/top-sectors", (c) =>
    topSectorsByEntidadHandler(c, config),
  );
  app.get("/analytics/risk-summary", (c) => riskSummaryHandler(c, config));
  app.get("/analytics/risk-trend", (c) => riskTrendHandler(c, config));
  app.get("/analytics/mortality-summary", (c) =>
    mortalitySummaryHandler(c, config),
  );
  app.get("/analytics/mortality-trend", (c) =>
    mortalityTrendHandler(c, config),
  );

  return app;
}
