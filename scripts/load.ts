/**
 * CLI: Carga datos del extractor DENUE a Supabase.
 *
 * Uso:
 *   npx tsx scripts/load.ts --file=/ruta/al/archivo.json
 *   npx tsx scripts/load.ts --file=/ruta/al/archivo.json --batch=50
 *
 * Variables de entorno requeridas:
 *   SUPABASE_URL         — ej. http://localhost:8100
 *   SUPABASE_SERVICE_KEY — JWT service_role de Supabase
 */

import { loadRecords, readExtractorOutput, updateGeometry, type LoaderConfig } from "../src/db/loader.js";

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------
function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) {
    console.error(`❌ Variable de entorno requerida: ${name}`);
    process.exit(1);
  }
  return val;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const filePath = getArg("file");
  if (!filePath) {
    console.error("❌ Falta --file=/ruta/al/archivo.json");
    process.exit(1);
  }

  const batchSize = parseInt(getArg("batch") ?? "100", 10);

  const supabaseUrl = process.env["SUPABASE_URL"] ?? "http://localhost:8100";
  const serviceRoleKey = requireEnv("SUPABASE_SERVICE_KEY");

  const config: LoaderConfig = { supabaseUrl, serviceRoleKey, batchSize };

  console.log(`📂 Leyendo: ${filePath}`);
  const records = readExtractorOutput(filePath);
  console.log(`📊 Registros a cargar: ${records.length}`);
  console.log(`🔗 Supabase: ${supabaseUrl}`);
  console.log(`📦 Batch size: ${batchSize}`);
  console.log();

  const result = await loadRecords(records, config);

  console.log("─".repeat(50));
  console.log(`✅ Insertados/actualizados : ${result.inserted}`);
  console.log(`❌ Errores                 : ${result.errors.length}`);
  console.log(`⏱  Duración               : ${result.durationMs}ms`);

  if (result.errors.length > 0) {
    console.log("\nDetalle de errores:");
    for (const err of result.errors) {
      console.log(`  CLEE ${err.clee}: ${err.error.slice(0, 120)}`);
    }
  }

  // Actualizar geometrías después de la carga
  if (result.errors.length === 0) {
    console.log();
    await updateGeometry(config);
  }
}

main().catch((err: unknown) => {
  console.error("❌ Error fatal:", err);
  process.exit(1);
});
