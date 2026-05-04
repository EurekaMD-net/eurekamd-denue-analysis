/**
 * scripts/pipeline.ts — CLI para el pipeline nacional de extracción DENUE
 *
 * Uso:
 *   npx tsx scripts/pipeline.ts --all
 *   npx tsx scripts/pipeline.ts --estados=09,15,14
 *   npx tsx scripts/pipeline.ts --retry-failed
 *   npx tsx scripts/pipeline.ts --status
 *
 * Variables de entorno requeridas (en .env):
 *   DENUE_TOKEN=<token INEGI>
 *   SUPABASE_URL=http://localhost:8100
 *   SUPABASE_SERVICE_KEY=<jwt>   ← mismo nombre que scripts/load.ts y README
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { EstadoClave } from "../src/extractor/types.js";
import { ESTADOS } from "../src/extractor/types.js";
import { Orchestrator } from "../src/pipeline/orchestrator.js";
import { StateManager } from "../src/pipeline/state-manager.js";

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const envFile = resolve(process.cwd(), ".env");
  try {
    const lines = readFileSync(envFile, "utf-8").split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      env[key] = val;
    }
  } catch {
    // .env no existe — se usan las env vars del proceso
  }
  return { ...env, ...process.env } as Record<string, string>;
}

function requireEnv(env: Record<string, string>, key: string): string {
  const val = env[key];
  if (!val) {
    console.error(`❌ Variable de entorno requerida: ${key}`);
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(): {
  command: "run" | "status";
  estados?: EstadoClave[];
  retryFailed: boolean;
  concurrency: number;
  updateGeom: boolean;
} {
  const args = process.argv.slice(2);

  if (args.includes("--status")) {
    return {
      command: "status",
      retryFailed: false,
      concurrency: 1,
      updateGeom: false,
    };
  }

  const estadosArg = args.find((a) => a.startsWith("--estados="));
  let estados: EstadoClave[] | undefined;
  if (estadosArg) {
    estados = estadosArg
      .replace("--estados=", "")
      .split(",")
      .map((s) => s.trim().padStart(2, "0") as EstadoClave)
      .filter((s) => s in ESTADOS);
  }

  const concurrencyArg = args.find((a) => a.startsWith("--concurrency="));
  const concurrency = concurrencyArg
    ? parseInt(concurrencyArg.replace("--concurrency=", ""), 10)
    : 1;

  return {
    command: "run",
    estados,
    retryFailed: args.includes("--retry-failed"),
    concurrency: isNaN(concurrency) ? 1 : concurrency,
    updateGeom: args.includes("--update-geom"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs();
  const env = loadEnv();
  const outputDir = env["OUTPUT_DIR"] ?? resolve(process.cwd(), "data");

  if (args.command === "status") {
    const stateDir = env["STATE_DIR"] ?? resolve(process.cwd(), "data/state");
    const sm = new StateManager(stateDir);
    const summary = sm.summary();
    console.log("\n📊 Pipeline Status");
    console.log("==================");
    console.log(`Total:    ${summary.total}`);
    console.log(`✅ Done:   ${summary.done}`);
    console.log(`❌ Failed: ${summary.failed}`);
    console.log(`⏳ Pending: ${summary.pending}`);
    console.log(`🔄 Running: ${summary.running}`);
    console.log("\nDetalle por estado:");
    for (const e of sm.getAll()) {
      const icon = { done: "✅", failed: "❌", pending: "⏳", running: "🔄" }[
        e.status
      ];
      const detail =
        e.status === "failed"
          ? ` — ${e.error ?? ""}`
          : e.records_loaded > 0
            ? ` — ${e.records_loaded.toLocaleString()} registros`
            : "";
      console.log(`  ${icon} [${e.clave}] ${e.nombre}${detail}`);
    }
    return;
  }

  // Run
  const token = requireEnv(env, "DENUE_TOKEN");
  const supabaseUrl = env["SUPABASE_URL"] ?? "http://localhost:8100";
  const serviceRoleKey = requireEnv(env, "SUPABASE_SERVICE_KEY");

  console.log("\n🚀 Pipeline DENUE — Extracción Nacional");
  console.log(`   Estados: ${args.estados?.join(", ") ?? "todos (32)"}`);
  console.log(`   Concurrencia: ${args.concurrency}`);
  console.log(`   Retry failed: ${args.retryFailed}`);
  console.log(`   Output dir: ${outputDir}`);
  console.log("");

  const stateDir = env["STATE_DIR"] ?? resolve(process.cwd(), "data/state");

  const orchestrator = new Orchestrator({
    stateDir,
    extractorConfig: {
      token,
      // pageSize=500 matches scripts/extract.ts conservative default.
      // Attempted live verification of 1000 on 2026-05-03 but the INEGI
      // v1 API endpoint returned 404 from this VPS IP (load-balancer routing).
      // Keeping 500 until pageSize=1000 can be confirmed end-to-end.
      pageSize: 500,
      delayMs: 500,
      maxRetries: 3,
      outputDir,
    },
    loaderConfig: {
      supabaseUrl,
      serviceRoleKey,
      batchSize: 200,
    },
    concurrency: args.concurrency,
    states: args.estados,
    retryFailed: args.retryFailed,
    updateGeomAtEnd: args.updateGeom,
  });

  const result = await orchestrator.run();

  console.log("\n✅ Pipeline completado");
  console.log(`   Done:    ${result.totalDone}`);
  console.log(`   Failed:  ${result.totalFailed}`);
  console.log(`   Skipped: ${result.totalSkipped} (ya estaban done)`);
  console.log(
    `   Total registros cargados: ${result.totalRecordsLoaded.toLocaleString()}`,
  );
  console.log(`   Duración: ${(result.durationMs / 1000).toFixed(1)}s`);

  if (result.totalRecordsLoaded > 0) {
    console.log(
      "\n💡 Recuerda llenar la columna `ageb` (CVEGEO 13-char) corriendo:",
    );
    console.log("   npx tsx --env-file=.env scripts/backfill-ageb.ts");
    console.log("   (es idempotente: solo toca filas con ageb IS NULL)");
    console.log(
      "\n💡 Refresca también las mat-views de /analytics (se quedan stale):",
    );
    console.log(
      "   docker exec -i supabase-db psql -U postgres -d postgres < scripts/perf-matviews.sql",
    );
    console.log(
      "   (reconstruye mv_sector_grade_matrix + mv_national_treemap; ~15s)",
    );
  }

  if (result.totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
