/**
 * CLI: Backfill the `ageb` column on establecimientos via PostGIS spatial
 * join against the `ageb_polygons` table.
 *
 * Prereq: `ageb_polygons` table must exist (loaded once via ogr2ogr from
 * INEGI Marco Geoestadístico 2020 — see docs/loading-marco-geoestadistico.md
 * if added). Relevant columns: `cvegeo` (13-char national-unique key,
 * ENT(2)+MUN(3)+LOC(4)+AGEB(4)) + `geom` (Polygon, SRID 4326, GIST-indexed).
 *
 * The 4-char `cve_ageb` is NOT national-unique (the same "001A" appears in
 * many localidades) — we always store the full 13-char CVEGEO so it joins
 * cleanly to Censo 2020 / CONEVAL data which is keyed by full CVEGEO.
 *
 * Idempotent: WHERE e.ageb IS NULL means re-runs only touch unfilled rows.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/backfill-ageb.ts
 *   npx tsx --env-file=.env scripts/backfill-ageb.ts --entidad=09
 *
 * Env:
 *   SUPABASE_DB_CONTAINER (default 'supabase-db')
 */

import { execFileSync } from "node:child_process";

const ENTIDAD_RE = /^(0[1-9]|[12][0-9]|3[0-2])$/;
// Docker container names: alphanumeric + _/./- but the first char must NOT
// be `-` (otherwise a malformed env var like `--rm` would be parsed by docker
// as a flag instead of a container name).
const CONTAINER_RE = /^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/;

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

export interface BackfillAgebConfig {
  dbContainer: string;
  entidad?: string;
}

export interface BackfillAgebResult {
  rows_updated: number;
  duration_ms: number;
}

/**
 * Build the SQL for the spatial-join backfill. Pure function so unit tests
 * can assert composition without spawning psql.
 *
 * Defense-in-depth: validates entidad inline (the caller also validates,
 * but this function is exported and a future caller might forget).
 */
export function buildBackfillAgebSQL(entidad?: string): string {
  if (entidad !== undefined && !ENTIDAD_RE.test(entidad)) {
    throw new Error(
      `buildBackfillAgebSQL: entidad inválida "${entidad}". Debe ser 2 dígitos 01-32.`,
    );
  }
  const filter = entidad ? `AND e.entidad = '${entidad}'` : "";
  // ST_Contains over GIST means the planner picks the polygon containing
  // each point. ageb IS NULL keeps re-runs idempotent + cheap.
  return [
    "WITH updated AS (",
    "  UPDATE establecimientos e",
    "  SET ageb = a.cvegeo",
    "  FROM ageb_polygons a",
    "  WHERE e.geom IS NOT NULL",
    "    AND e.ageb IS NULL",
    `    ${filter}`,
    "    AND ST_Contains(a.geom, e.geom)",
    "  RETURNING 1",
    ")",
    "SELECT COUNT(*) AS rows_updated FROM updated;",
  ].join(" ");
}

export async function backfillAgeb(
  config: BackfillAgebConfig,
): Promise<BackfillAgebResult> {
  if (config.entidad && !ENTIDAD_RE.test(config.entidad)) {
    throw new Error(
      `backfillAgeb: entidad inválida "${config.entidad}". Debe ser 2 dígitos 01-32.`,
    );
  }
  if (!CONTAINER_RE.test(config.dbContainer)) {
    throw new Error(
      `backfillAgeb: dbContainer inválido "${config.dbContainer}". Solo alfanuméricos + _.-`,
    );
  }
  const sql = buildBackfillAgebSQL(config.entidad);
  const started = Date.now();
  const stdout = execFileSync(
    "docker",
    [
      "exec",
      config.dbContainer,
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
    { encoding: "utf-8", timeout: 60 * 60 * 1000 }, // 1h cap — full-table on 6.1M
  ).trim();
  const rows_updated = parseInt(stdout, 10);
  if (!Number.isFinite(rows_updated)) {
    throw new Error(`backfillAgeb: unexpected psql output "${stdout}"`);
  }
  return { rows_updated, duration_ms: Date.now() - started };
}

// ---------------------------------------------------------------------------
// CLI entry — only runs when executed directly, never on import (matters for
// test files that import buildBackfillAgebSQL).
// ---------------------------------------------------------------------------

const isMain =
  import.meta.url === `file://${process.argv[1] ?? ""}`.replace(/\\/g, "/");

if (isMain) {
  const dbContainer = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  const entidad = getArg("entidad");
  console.log(
    `[backfill-ageb] running spatial join against ${dbContainer}` +
      (entidad ? ` (entidad=${entidad})` : " (national)") +
      "...",
  );
  backfillAgeb(entidad ? { dbContainer, entidad } : { dbContainer })
    .then((r) => {
      console.log(
        `[backfill-ageb] ✓ ${r.rows_updated.toLocaleString()} filas actualizadas en ${(r.duration_ms / 1000).toFixed(1)}s`,
      );
      process.exit(0);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[backfill-ageb] ✗ ${msg}`);
      process.exit(1);
    });
}
