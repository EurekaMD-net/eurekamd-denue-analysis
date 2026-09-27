/**
 * CLI: Carga datos del extractor DENUE a Supabase.
 *
 * Uso:
 *   npx tsx scripts/load.ts --file=/ruta/al/archivo.json
 *   npx tsx scripts/load.ts --file=/ruta/al/archivo.json --batch=50
 *
 * El archivo debe estar en el formato del paginator (un registro por línea) o
 * ser un array compacto en una sola línea; los arrays pretty-printed
 * (JSON.stringify(arr, null, 2)) no se soportan.
 *
 * Variables de entorno requeridas:
 *   SUPABASE_URL         — ej. http://localhost:8100
 *   SUPABASE_SERVICE_KEY — JWT service_role de Supabase
 */

import {
  loadRecords,
  readExtractorOutput,
  updateGeometry,
  type DenueRawRecord,
  type LoadResult,
  type LoaderConfig,
} from "../src/db/loader.js";

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
// Load + geometry (exported for src/db/loader.test.ts, audit #165)
// ---------------------------------------------------------------------------
/**
 * Upserts `records`, then rewrites PostGIS geometry ONLY when every batch
 * succeeded. With any failed batch the errors are reported and geometry is
 * skipped (`geometryUpdated: null`). An updateGeometry failure propagates.
 */
export async function loadAndUpdateGeometry(
  records: DenueRawRecord[],
  config: LoaderConfig,
): Promise<{ result: LoadResult; geometryUpdated: number | null }> {
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
    return { result, geometryUpdated: null };
  }

  // Actualizar geometrías después de la carga
  console.log();
  const geoResult = await updateGeometry(config);
  console.log(`🗺  Geometrías PostGIS actualizadas: ${geoResult.updated}`);
  return { result, geometryUpdated: geoResult.updated };
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

  await loadAndUpdateGeometry(records, config);
}

// Auto-invoke when run directly (not when imported by tests).
const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  main().catch((err: unknown) => {
    console.error("❌ Error fatal:", err);
    process.exit(1);
  });
}
