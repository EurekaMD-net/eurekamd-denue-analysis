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

import { execSync } from "node:child_process";
import type { AnalysisConfig } from "./types.js";

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
  // ST_ClusterKMeans returns cluster_id over the window of records matching the WHERE.
  // Outer aggregate computes centroid + member list per cluster.
  // Output as JSON so we don't have to parse a psql table format.
  const sql = `
    WITH clustered AS (
      SELECT clee, latitud, longitud,
             ST_ClusterKMeans(geom, ${params.k}) OVER () AS cluster_id
      FROM establecimientos
      WHERE entidad = '${params.entidad}'
        AND SUBSTR(clee, 3, 2) = '${params.scianPrefix}'
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
  const cmd = `docker exec ${container} psql -U postgres -d postgres -t -A -c "${sql}"`;
  const output = execSync(cmd, { encoding: "utf-8", timeout: 60_000 }).trim();

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
