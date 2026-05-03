#!/usr/bin/env tsx
/**
 * scripts/analyze.ts — CLI de análisis DENUE
 *
 * Uso:
 *   npx tsx --env-file=.env scripts/analyze.ts sector-summary [--entidad=09] [--limit=20]
 *   npx tsx --env-file=.env scripts/analyze.ts top-municipios [--entidad=09] [--limit=10]
 *   npx tsx --env-file=.env scripts/analyze.ts export geojson --entidad=06 --output=colima.geojson
 *
 * Variables de entorno requeridas:
 *   SUPABASE_URL          — ej. http://localhost:8100
 *   SUPABASE_SERVICE_KEY  — JWT de service_role
 */

import { writeFileSync } from "fs";
import { execSync } from "node:child_process";
import { sectorSummary } from "../src/analysis/sector-summary.js";
import { topMunicipios } from "../src/analysis/top-municipios.js";
import { exportGeoJson } from "../src/analysis/geojson-export.js";
import {
  clusterBySector,
  formatClusters,
} from "../src/analysis/cluster-by-sector.js";
import {
  coverageReport,
  formatCoverageReport,
} from "../src/analysis/coverage-report.js";
import type { AnalysisConfig } from "../src/analysis/types.js";

const MATERIALIZED_VIEWS = [
  "mv_sector_summary",
  "mv_coverage",
  "mv_estrato_por_entidad",
];

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const flag = args.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.slice(`--${name}=`.length) : undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

// ---------------------------------------------------------------------------
// Build config from env
// ---------------------------------------------------------------------------

const supabaseUrl = process.env["SUPABASE_URL"];
const serviceRoleKey = process.env["SUPABASE_SERVICE_KEY"];

if (!supabaseUrl || !serviceRoleKey) {
  console.error(
    "❌  Faltan variables de entorno: SUPABASE_URL y SUPABASE_SERVICE_KEY son requeridas.",
  );
  process.exit(1);
}

const config: AnalysisConfig = {
  supabaseUrl,
  serviceRoleKey,
  dbContainer: process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db",
};

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const command = args[0];
const subcommand = args[1];

if (command === "sector-summary") {
  const entidad = getFlag("entidad") ?? null;
  const limit = parseInt(getFlag("limit") ?? "20", 10);

  console.log(
    `📊 Sector summary — entidad: ${entidad ?? "nacional"}, top ${limit}`,
  );

  const result = await sectorSummary(config, { entidad, limit });

  console.log(`\nTotal establecimientos: ${result.total.toLocaleString()}`);
  console.log(`\nTop ${result.rows.length} sectores:\n`);
  for (const row of result.rows) {
    const pct = ((row.count / result.total) * 100).toFixed(1);
    console.log(
      `  ${row.clase_actividad_id.padEnd(10)}  ${String(row.count).padStart(8)}  (${pct}%)  ${row.clase_actividad ?? ""}`,
    );
  }
} else if (command === "top-municipios") {
  const entidad = getFlag("entidad") ?? null;
  const limit = parseInt(getFlag("limit") ?? "10", 10);

  console.log(
    `🏙️  Top municipios — entidad: ${entidad ?? "nacional"}, top ${limit}`,
  );

  const result = await topMunicipios(config, { entidad, limit });

  console.log(`\nTop ${result.rows.length} municipios:\n`);
  for (const row of result.rows) {
    console.log(
      `  [${
        row.entidad ?? "??"
      }] ${(row.municipio ?? "(sin municipio)").padEnd(40)} ${String(row.count).padStart(8)}`,
    );
  }
} else if (command === "export" && subcommand === "geojson") {
  const entidad = getFlag("entidad") ?? null;
  const output = getFlag("output");
  const limitArg = getFlag("limit");
  const limit = limitArg ? parseInt(limitArg, 10) : null;
  const withGeomOnly = !hasFlag("include-no-geom");

  if (!output) {
    console.error(
      "❌  --output=<archivo.geojson> es requerido para export geojson",
    );
    process.exit(1);
  }

  console.log(
    `🗺️  Export GeoJSON — entidad: ${entidad ?? "nacional"}, output: ${output}`,
  );
  if (limit) console.log(`   Límite: ${limit} features`);
  if (!withGeomOnly) console.log("   Incluye establecimientos sin coordenadas");

  const result = await exportGeoJson(config, { entidad, withGeomOnly, limit });

  writeFileSync(output, JSON.stringify(result.collection, null, 2), "utf-8");

  console.log(
    `\n✅ ${result.total.toLocaleString()} features exportadas → ${output}`,
  );
  if (result.withoutGeometry > 0) {
    console.log(
      `   ⚠️  ${result.withoutGeometry} sin geometría (geometry: null)`,
    );
  }
} else if (command === "clusters") {
  const entidad = getFlag("entidad");
  const scian = getFlag("scian");
  const k = parseInt(getFlag("k") ?? "5", 10);
  if (!entidad || !scian) {
    console.error("❌  clusters: --entidad=NN y --scian=NN son requeridos.");
    process.exit(1);
  }
  console.log(
    `🌐  Clusters — entidad ${entidad}, sector SCIAN ${scian}, k=${k}`,
  );
  const result = await clusterBySector(config, {
    entidad,
    scianPrefix: scian,
    k,
  });
  console.log("\n" + formatClusters(result));
} else if (command === "coverage") {
  console.log("📋  Coverage report (entidades cargadas vs INEGI)\n");
  const report = await coverageReport(config);
  console.log(formatCoverageReport(report));
} else if (command === "refresh-views") {
  console.log("🔄  Refrescando materialized views...");
  for (const view of MATERIALIZED_VIEWS) {
    process.stdout.write(`  ${view}... `);
    try {
      // CONCURRENTLY allows reads during refresh; requires a UNIQUE INDEX (we have one)
      execSync(
        `docker exec ${config.dbContainer} psql -U postgres -d postgres -c "REFRESH MATERIALIZED VIEW CONCURRENTLY ${view};"`,
        { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] },
      );
      console.log("✅");
    } catch (err) {
      const msg =
        (err as { stderr?: Buffer | string }).stderr?.toString() ?? String(err);
      // CONCURRENTLY can fail on first refresh after WITH NO DATA — fall back to non-concurrent
      if (/cannot refresh materialized view.*concurrently/i.test(msg)) {
        process.stdout.write("(first refresh, no concurrency)... ");
        execSync(
          `docker exec ${config.dbContainer} psql -U postgres -d postgres -c "REFRESH MATERIALIZED VIEW ${view};"`,
          { encoding: "utf-8" },
        );
        console.log("✅");
      } else {
        console.log(`❌  ${msg.slice(0, 200)}`);
        process.exit(1);
      }
    }
  }
  console.log("\n✅ Todos los views refrescados.");
} else {
  console.log(`
DENUE Analyze CLI

Comandos:
  sector-summary   Agrupa establecimientos por clase de actividad económica
  top-municipios   Ranking de municipios por número de establecimientos
  export geojson   Exporta establecimientos como GeoJSON FeatureCollection
  clusters         PostGIS ST_ClusterKMeans por entidad + sector SCIAN
  coverage         Reporte de cobertura: cargado vs INEGI autoritativo
  refresh-views    REFRESH MATERIALIZED VIEW (CONCURRENTLY) para los 3 mv_*

Opciones:
  --entidad=<código>   Filtrar por clave de entidad (ej. 09, 06, 15). Sin = nacional.
  --scian=<NN>         Prefijo SCIAN de 2 dígitos (para clusters)
  --k=<n>              Número de clusters K-Means (para clusters, default 5)
  --limit=<n>          Máximo de filas a mostrar/exportar (default: 20 / 10)
  --output=<archivo>   Archivo de salida (requerido para export geojson)
  --include-no-geom    Incluir establecimientos sin coordenadas en el GeoJSON

Ejemplos:
  npx tsx --env-file=.env scripts/analyze.ts sector-summary --entidad=09
  npx tsx --env-file=.env scripts/analyze.ts top-municipios --entidad=06 --limit=20
  npx tsx --env-file=.env scripts/analyze.ts export geojson --entidad=06 --output=colima.geojson
`);
  process.exit(1);
}
