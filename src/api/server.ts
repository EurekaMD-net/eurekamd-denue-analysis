/**
 * Phase 5 — HTTP API server factory.
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
 *
 * All routes except /health require X-Api-Key header matching config.apiKey.
 */

import { Hono } from "hono";
import type { ApiServerConfig } from "./types.js";
import { makeAuthMiddleware } from "./middleware/auth.js";
import { errorHandler } from "./middleware/error.js";
import { logMiddleware } from "./middleware/log.js";
import { searchHandler } from "./handlers/search.js";
import { establishmentHandler } from "./handlers/establishment.js";
import { summarySectorHandler } from "./handlers/summary-sector.js";
import { summaryEntidadHandler } from "./handlers/summary-entidad.js";
import { clustersHandler } from "./handlers/clusters.js";

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

  app.get("/search", (c) => searchHandler(c, config));
  app.get("/establishment/:clee", (c) => establishmentHandler(c, config));
  app.get("/summary/sector/:scian", (c) => summarySectorHandler(c, config));
  app.get("/summary/entidad/:clave", (c) => summaryEntidadHandler(c, config));
  app.get("/clusters", (c) => clustersHandler(c, config));

  return app;
}
