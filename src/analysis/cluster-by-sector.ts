/**
 * Runner: Cluster by sector
 *
 * Uses PostGIS ST_ClusterKMeans to identify k spatial clusters of
 * establecimientos within an entidad + 2-digit SCIAN sector. Returns
 * cluster centroids + sizes only (audit #34/#101: no member CLEE arrays —
 * those made entidad=15/sector=46 a 12 MB payload; now < 1 KB).
 *
 * Implementation: shells to `docker exec <container> psql` like
 * loader.ts:updateGeometry() — the same VPS-local pattern. PostgREST
 * doesn't expose ST_ClusterKMeans directly without an RPC wrapper.
 *
 * Inputs are validated against tight regex (entidad = 2 digits 01-32,
 * scianPrefix = 2 digits, k = positive int) before composing the SQL,
 * so even though we shell-quote them, there's no injection surface.
 */

import type { AnalysisConfig } from "./types.js";
import { runJson } from "../api/db/psql-runner.js";

// Audit C1-sec round-1 closure 2026-05-10: parity with the rest of the
// shell-out surface (sectors.ts, summary-sector.ts, search.ts, tiles.ts,
// loaders). Container name is server-set from env, but enforce the regex
// at the boundary anyway — defense in depth.
const SAFE_CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export interface ClusterCentroid {
  cluster_id: number;
  lon: number;
  lat: number;
  size: number;
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
  // Audit #56: k-means runs on EPSG:6372 (Mexico ITRF2008 LCC) so distances
  // are metric, not raw degrees; the centroid is taken back in 4326.
  // Outer aggregate computes centroid + size per cluster (no member list).
  // Output as JSON so we don't have to parse a psql table format.
  //
  // sector_actividad_id is backfilled from CLEE chars 6-7 (the 2-digit
  // SCIAN sector). Hits the idx_estab_sector btree — much faster than a
  // SUBSTR scan. The pre-P1 bug used CLEE chars 3-4 (municipio) thinking
  // they were SCIAN — the indexed column makes that class of bug impossible
  // by construction.
  const sql = `
    WITH clustered AS (
      SELECT geom,
             ST_ClusterKMeans(ST_Transform(geom, 6372), ${params.k}) OVER () AS cluster_id
      FROM establecimientos
      WHERE entidad = '${params.entidad}'
        AND sector_actividad_id = '${params.scianPrefix}'
        AND geom IS NOT NULL
    )
    SELECT json_agg(c) FROM (
      SELECT
        cluster_id,
        ROUND(ST_X(ST_Centroid(ST_Collect(geom)))::numeric, 6) AS lon,
        ROUND(ST_Y(ST_Centroid(ST_Collect(geom)))::numeric, 6) AS lat,
        COUNT(*)::int AS size
      FROM clustered
      GROUP BY cluster_id
      ORDER BY size DESC
    ) c;
  `
    .replace(/\n\s+/g, " ")
    .trim();

  // Audit #94/#130/#54/#37: the shared async runner (no shell layer, SQL
  // on stdin) carries statement_timeout=50s via `docker exec -e PGOPTIONS`
  // — the old host-env PGOPTIONS never reached the container — cancels
  // the backend on client timeout, and turns psql failures into a 502
  // postgres.error instead of a generic 500. null/empty output → [].
  return runJson<ClusterCentroid[]>(sql, {
    container,
    timeoutMs: 50_000,
  });
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
      `${String(c.cluster_id).padEnd(2)}  ${String(c.size).padStart(7)}  ${c.lat.toFixed(6)}, ${c.lon.toFixed(6)}`,
    );
  }
  return lines.join("\n");
}
