/**
 * GET /sectors — dropdown source for the analyzer frontend.
 *
 * Returns one entry per 2-digit SCIAN sector that actually appears in the
 * loaded data, with the official INEGI name + national row count.
 *
 * SCIAN source: `sector_actividad_id`, summed from mv_sector_summary
 * (scripts/migrations/021-summary-mvs.sql) — audit #99: the live GROUP BY
 * over 6.1M establecimientos rows took 0.4-4.7 s per request. See
 * src/db/scian_2digit_names.json for the human-readable catalog.
 *
 * Implementation: shells to docker exec psql for the GROUP BY since
 * PostgREST can't express GROUP-BY aggregates over a column without
 * a server-side RPC. Same pattern as src/analysis/cluster-by-sector.ts.
 * The counts change only on reload + MV refresh, so they are memoized
 * in-process for SECTOR_COUNTS_TTL_MS and sent with a 1 h Cache-Control.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { runJson } from "../db/psql-runner.js";
import {
  type ApiServerConfig,
  type SectorEntry,
  type SectorsResult,
} from "../types.js";
import { assertSafeContainer } from "./_safe-container.js";

interface ScianNamesFile {
  _verified_at?: string;
  sectors: Record<string, string>;
}

let cachedNames: ScianNamesFile | null = null;

export function loadScianNames(overridePath?: string): ScianNamesFile {
  if (!overridePath && cachedNames) return cachedNames;
  const filePath =
    overridePath ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "db",
      "scian_2digit_names.json",
    );
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as ScianNamesFile;
  if (!overridePath) cachedNames = parsed;
  return parsed;
}

/** Reset the cache. For tests only. */
export function _resetScianCache(): void {
  cachedNames = null;
}

const SECTOR_COUNTS_TTL_MS = 60 * 60 * 1000;
let cachedCounts: { at: number; counts: Array<[string, number]> } | null =
  null;

/** Reset the sector-counts memo. For tests only. */
export function _resetSectorCountsCache(): void {
  cachedCounts = null;
}

export async function sectorsHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  if (!cachedCounts || Date.now() - cachedCounts.at > SECTOR_COUNTS_TTL_MS) {
    cachedCounts = { at: Date.now(), counts: await fetchSectorCounts(config) };
  }
  const counts = cachedCounts.counts;
  const names = loadScianNames();

  // Only emit sectors that are BOTH in the catalog and present in data.
  // Counts that are missing from the catalog are anomalies (e.g. 29/75/89
  // with 1-7 rows out of 6.1M) — surface them with a placeholder name so
  // the dropdown is honest rather than hiding data.
  const sectors: SectorEntry[] = [];
  for (const [scian, national_count] of counts) {
    const name = names.sectors[scian] ?? `(SCIAN ${scian} — sin etiqueta)`;
    sectors.push({ scian, name, national_count });
  }
  sectors.sort((a, b) => b.national_count - a.national_count);

  const payload: SectorsResult = { sectors };
  c.header("Cache-Control", "private, max-age=3600");
  c.header("Vary", "Authorization, X-Api-Key");
  return c.json(payload);
}

async function fetchSectorCounts(
  config: ApiServerConfig,
): Promise<Array<[string, number]>> {
  assertSafeContainer(config.dbContainer);
  // mv_sector_summary holds one row per (entidad, sector, clase), so the
  // national count per sector is a SUM over ~30k rows, not a 6.1M-row scan.
  // A missing MV surfaces as 502 postgres.error (migration 021 not applied).
  const sql =
    "SELECT json_agg(row_to_json(t)) FROM (" +
    "  SELECT sector_actividad_id AS scian, SUM(total)::bigint AS count" +
    "  FROM mv_sector_summary" +
    "  WHERE sector_actividad_id IS NOT NULL" +
    "  GROUP BY 1" +
    "  ORDER BY 1" +
    ") t;";

  // Audit #94/#130/#37: async shared runner — no event-loop block, and
  // statement_timeout reaches Postgres via `docker exec -e PGOPTIONS`.
  // psql failures surface as 502 postgres.error; null/empty → [].
  const rows = await runJson<
    Array<{
      scian: string;
      count: number | string;
    }>
  >(sql, { container: config.dbContainer });
  return rows.map((r) => [r.scian, Number(r.count)] as [string, number]);
}
