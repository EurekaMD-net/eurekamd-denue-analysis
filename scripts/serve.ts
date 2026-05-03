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
import type { ApiServerConfig } from "../src/api/types.js";

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

const app = createServer(config);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`✅ DENUE API escuchando en http://0.0.0.0:${info.port}`);
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
