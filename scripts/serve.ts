#!/usr/bin/env tsx
/**
 * scripts/serve.ts — DENUE HTTP API server entry point.
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/serve.ts
 *   API_PORT=3031 npx tsx --env-file=.env scripts/serve.ts
 *
 * Variables de entorno requeridas (en .env):
 *   SUPABASE_URL              — ej. http://localhost:8100
 *   SUPABASE_SERVICE_KEY      — JWT de service_role
 *   API_KEY                   — clave que clientes deben enviar en X-Api-Key
 *
 * Variables opcionales:
 *   API_PORT                  — default 3030
 *   SUPABASE_DB_CONTAINER     — default "supabase-db"
 */

import { serve } from "@hono/node-server";
import { createServer } from "../src/api/server.js";
import {
  resolveCurrentMortalityAno,
  resolveCurrentRiskAno,
} from "../src/api/handlers/analytics.js";
import {
  MORTALITY_DEFAULT_CURRENT_ANO,
  RISK_DEFAULT_CURRENT_ANO,
  type ApiServerConfig,
} from "../src/api/types.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.trim().length === 0) {
    console.error(`❌  Variable de entorno requerida: ${name}`);
    process.exit(1);
  }
  return v;
}

const config: ApiServerConfig = {
  supabaseUrl: requireEnv("SUPABASE_URL"),
  serviceRoleKey: requireEnv("SUPABASE_SERVICE_KEY"),
  apiKey: requireEnv("API_KEY"),
  dbContainer: process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db",
};

const port = parseInt(process.env["API_PORT"] ?? "3030", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`❌  API_PORT inválido: "${process.env["API_PORT"]}"`);
  process.exit(1);
}

// Resolve the "latest fully-reported year" from the data so
// /analytics/risk-summary rolls over automatically when next year's
// December SESNSP load lands. Resolver returns the static fallback if
// the DB is unreachable at boot — service still starts, risk-summary
// still serves.
const resolvedRisk = resolveCurrentRiskAno(config);
config.currentRiskAno = resolvedRisk.ano;
if (resolvedRisk.source === "fallback") {
  console.warn(
    `⚠️  risk-summary current_ano resolver fell back to static ${RISK_DEFAULT_CURRENT_ANO} (DB unreachable or no fully-reported year exists)`,
  );
} else {
  console.log(
    `   risk-summary default current_ano resolved from data: ${resolvedRisk.ano}`,
  );
}

// Same pattern for mortality-summary. Picks the latest year with at
// least 100k registered deaths so partial / lag-artifact years don't
// become the default.
const resolvedMortality = resolveCurrentMortalityAno(config);
config.currentMortalityAno = resolvedMortality.ano;
if (resolvedMortality.source === "fallback") {
  console.warn(
    `⚠️  mortality-summary current_ano resolver fell back to static ${MORTALITY_DEFAULT_CURRENT_ANO} (DB unreachable or no primary-year data loaded)`,
  );
} else {
  console.log(
    `   mortality-summary default current_ano resolved from data: ${resolvedMortality.ano}`,
  );
}

const app = createServer(config);

// Audit W3-sec round-1 closure 2026-05-10: bind to 127.0.0.1 explicitly.
// Caddy reverse-proxies on the same host; no need to expose :3030 on the
// LAN. UFW would also block external hits today (no public allow rule),
// but defense in depth: bind locally so a future UFW rule change can't
// silently expose the API. Override with API_HOST=0.0.0.0 only if the
// service ever needs LAN exposure.
const hostname = process.env["API_HOST"] ?? "127.0.0.1";

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`✅ DENUE API escuchando en http://${hostname}:${info.port}`);
  console.log(`   Endpoints (todos requieren X-Api-Key):`);
  console.log(`     GET /health`);
  console.log(
    `     GET /search?q=&entidad=&from=lat,lon&radius_km=&page=&limit=`,
  );
  console.log(`     GET /establishment/:clee`);
  console.log(`     GET /summary/sector/:scian`);
  console.log(`     GET /summary/entidad/:clave`);
  console.log(`     GET /clusters?entidad=&scian=&k=`);
});
