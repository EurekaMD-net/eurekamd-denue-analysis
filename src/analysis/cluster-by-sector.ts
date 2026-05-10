/**
 * Runner: Cluster by sector
 *
 * Uses PostGIS ST_ClusterKMeans to identify k spatial clusters of
 * establecimientos within an entidad + 2-digit SCIAN sector. Returns
 * cluster centroids + member CLEEs.
 *
 * Implementation: shells to `docker exec <container> psql` like
 * loader.ts:updateGeometry() — the same VPS-local pattern. PostgREST
 * doesn't expose ST_ClusterKMeans directly without an RPC wrapper.
 *
 * Inputs are validated against tight regex (entidad = 2 digits 01-32,
 * scianPrefix = 2 digits, k = positive int) before composing the SQL,
 * so even though we shell-quote them, there's no injection surface.
 */

import { execFileSync } from "node:child_process";
import type { AnalysisConfig } from "./types.js";

// Audit C1-sec round-1 closure 2026-05-10: parity with the rest of the
// shell-out surface (sectors.ts, summary-sector.ts, search.ts, tiles.ts,
// loaders). Container name is server-set from env, but enforce the regex
// at the boundary anyway — defense in depth.
const SAFE_CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export interface ClusterCentroid {
  cluster_id: number;
  centroid_lat: number;
  centroid_lon: number;
  member_count: number;
  member_clees: string[];
}

export interface ClusterBySectorParams {
  entidad: string;
  scianPrefix: string;
  k: number;
}

const ENTIDAD_RE = /^(0[1-9]|[12][0-9]|3[0-2])$/;
const SCIAN_RE = /^[0-9]{2}$/;

/**
 * Validates inputs and runs ST_ClusterKMeans in the database.
 * Throws on invalid input or psql failure.
 */
export async function clusterBySector(
  config: AnalysisConfig,
  params: ClusterBySectorParams,
): Promise<ClusterCentroid[]> {
  if (!ENTIDAD_RE.test(params.entidad)) {
    throw new Error(
      `clusterBySector: entidad inválida "${params.entidad}". Debe ser 2 dígitos 01-32.`,
    );
  }
  if (!SCIAN_RE.test(params.scianPrefix)) {
    throw new Error(
      `clusterBySector: scianPrefix inválido "${params.scianPrefix}". Debe ser 2 dígitos.`,
    );
  }
  if (!Number.isInteger(params.k) || params.k < 1 || params.k > 100) {
    throw new Error(
      `clusterBySector: k inválido "${params.k}". Debe ser entero 1-100.`,
    );
  }

  const container = config.dbContainer ?? "supabase-db";
  // Audit C1-sec round-1 closure 2026-05-10: defense-in-depth guard
  // (parity with loader surface). Container is server-set today but
  // regex-gating it at the boundary ensures shell-injection-by-env is
  // closed even if a future change ships an operator-controllable path.
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`clusterBySector: unsafe container name "${container}".`);
  }
  // ST_ClusterKMeans returns cluster_id over the window of records matching the WHERE.
  // Outer aggregate computes centroid + member list per cluster.
  // Output as JSON so we don't have to parse a psql table format.
  //
  // sector_actividad_id is backfilled from CLEE chars 6-7 (the 2-digit
  // SCIAN sector). Hits the idx_estab_sector btree — much faster than a
  // SUBSTR scan. The pre-P1 bug used CLEE chars 3-4 (municipio) thinking
  // they were SCIAN — the indexed column makes that class of bug impossible
  // by construction.
  const sql = `
    WITH clustered AS (
      SELECT clee, latitud, longitud,
             ST_ClusterKMeans(geom, ${params.k}) OVER () AS cluster_id
      FROM establecimientos
      WHERE entidad = '${params.entidad}'
        AND sector_actividad_id = '${params.scianPrefix}'
        AND geom IS NOT NULL
    )
    SELECT json_agg(c) FROM (
      SELECT
        cluster_id,
        ROUND(AVG(latitud)::numeric, 6) AS centroid_lat,
        ROUND(AVG(longitud)::numeric, 6) AS centroid_lon,
        COUNT(*)::int AS member_count,
        ARRAY_AGG(clee ORDER BY clee) AS member_clees
      FROM clustered
      GROUP BY cluster_id
      ORDER BY member_count DESC
    ) c;
  `
    .replace(/\n\s+/g, " ")
    .trim();

  // Use -t -A so psql returns just the JSON value (no headers, no padding).
  // timeout: 60_000 ms — clustering on a large bank+sector can take a while
  // but must be bounded so the API handler that wraps this can't be hung
  // indefinitely (audit C2 from Phase 5: never shell-out without a timeout).
  //
  // Audit C1-sec round-1 closure 2026-05-10: rewrote from `execSync` with
  // a shell-interpolated string to `execFileSync` array-arg form. No shell
  // layer means metacharacters in container/sql cannot escape; matches the
  // posture of every other shell-out site in the codebase. PGOPTIONS env
  // bounds the postgres backend at 50s (parity with C3-perf fix).
  const output = execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-t",
      "-A",
      "-c",
      sql,
    ],
    {
      encoding: "utf-8",
      timeout: 60_000,
      env: { ...process.env, PGOPTIONS: "-c statement_timeout=50000" },
    },
  ).trim();

  if (!output || output === "" || output === "null") {
    return [];
  }

  const parsed = JSON.parse(output) as ClusterCentroid[] | null;
  return parsed ?? [];
}

/** Format a cluster list as a plain-text table for CLI output. */
export function formatClusters(clusters: ClusterCentroid[]): string {
  if (clusters.length === 0) {
    return "(sin clusters — la consulta no devolvió registros con geometría)";
  }
  const lines = [
    `ID  Members  Centroid (lat, lon)`,
    `--  -------  -----------------------`,
  ];
  for (const c of clusters) {
    lines.push(
      `${String(c.cluster_id).padEnd(2)}  ${String(c.member_count).padStart(7)}  ${c.centroid_lat.toFixed(6)}, ${c.centroid_lon.toFixed(6)}`,
    );
  }
  return lines.join("\n");
}
