#!/usr/bin/env tsx
/**
 * Script de extracción DENUE
 * 
 * Uso:
 *   npx tsx scripts/extract.ts --estado=09
 *   npx tsx scripts/extract.ts --estado=09 --sector=462111
 *   npx tsx scripts/extract.ts --estado=all
 *   npx tsx scripts/extract.ts --estado=09 --condicion=farmacia
 *
 * Variables de entorno requeridas:
 *   DENUE_TOKEN=<tu-token>
 */

import { Paginator } from "../src/extractor/paginator.js";
import { ESTADOS } from "../src/extractor/types.js";
import type { EstadoClave, ExtractorConfig } from "../src/extractor/types.js";

// ─── Configuración ────────────────────────────────────────────────────────────

const TOKEN = process.env.DENUE_TOKEN ?? "";
if (!TOKEN) {
  console.error("ERROR: Variable de entorno DENUE_TOKEN no está definida.");
  console.error("  Ejemplo: DENUE_TOKEN=ac91ef8a-da15-433a-a42d-6802ffab6a9c npx tsx scripts/extract.ts --estado=09");
  process.exit(1);
}

const config: ExtractorConfig = {
  token: TOKEN,
  pageSize: 500,      // Máx recomendado para la API DENUE
  delayMs: 300,       // 300ms entre requests — conservador para no saturar
  maxRetries: 3,
  outputDir: "./data/raw",
};

// ─── Parseo de args ───────────────────────────────────────────────────────────

function getArg(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=")[1];
}

const estadoArg = getArg("estado") ?? "09";
const sectorArg = getArg("sector") ?? "todos";
const condicionArg = getArg("condicion") ?? "";

// ─── Ejecución ────────────────────────────────────────────────────────────────

async function main() {
  const paginator = new Paginator(config);

  // Callback de progreso
  paginator.setProgressCallback(({ nombre, pagina, totalPaginas, registrosExtraidos, totalEsperado }) => {
    const pct = Math.round((registrosExtraidos / totalEsperado) * 100);
    process.stdout.write(
      `\r[${nombre}] Página ${pagina}/${totalPaginas} | ${registrosExtraidos.toLocaleString()}/${totalEsperado.toLocaleString()} registros (${pct}%)  `
    );
  });

  const estados: EstadoClave[] =
    estadoArg === "all"
      ? (Object.keys(ESTADOS) as EstadoClave[])
      : [estadoArg.padStart(2, "0") as EstadoClave];

  const resultados = [];

  for (const clave of estados) {
    if (!ESTADOS[clave]) {
      console.error(`\nClave de estado inválida: ${clave}. Válidas: 01-32`);
      continue;
    }

    console.log(`\n\n→ Extrayendo: ${ESTADOS[clave]} (${clave})...`);
    const result = await paginator.extractEstado(clave, condicionArg, sectorArg);

    console.log(`\n  ✓ ${result.totalExtraido.toLocaleString()} registros extraídos`);
    console.log(`    Esperados:  ${result.totalEsperado.toLocaleString()}`);
    console.log(`    Páginas:    ${result.paginas}`);
    console.log(`    Errores:    ${result.errores}`);
    console.log(`    Duración:   ${(result.duracionMs / 1000).toFixed(1)}s`);
    console.log(`    Archivo:    ${result.outputFile}`);

    const gap = result.totalEsperado - result.totalExtraido;
    if (gap > 0) {
      console.warn(`    ⚠ GAP: ${gap} registros faltantes (errores de red o paginación)`);
    }

    resultados.push(result);
  }

  // Resumen final
  if (resultados.length > 1) {
    const totalExtraido = resultados.reduce((s, r) => s + r.totalExtraido, 0);
    const totalEsperado = resultados.reduce((s, r) => s + r.totalEsperado, 0);
    console.log("\n\n=== RESUMEN FINAL ===");
    console.log(`Estados procesados: ${resultados.length}`);
    console.log(`Total extraído:     ${totalExtraido.toLocaleString()}`);
    console.log(`Total esperado:     ${totalEsperado.toLocaleString()}`);
    console.log(`Cobertura:          ${((totalExtraido / totalEsperado) * 100).toFixed(1)}%`);
  }
}

main().catch((err) => {
  console.error("\n\nError fatal:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
