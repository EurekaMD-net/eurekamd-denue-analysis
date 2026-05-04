/**
 * GET /sectors — dropdown source for the analyzer frontend.
 *
 * Returns one entry per 2-digit SCIAN sector that actually appears in the
 * loaded data, with the official INEGI name + national row count.
 *
 * SCIAN derivation: SUBSTR(clee, 6, 2). The CLEE encoding places the
 * 6-digit SCIAN class at chars 6-11; the leading 2 chars are the
 * 2-digit sector. (Chars 3-5 are the municipio — never use those for
 * sector grouping.) See src/db/scian_2digit_names.json for the catalog.
 *
 * Implementation: shells to docker exec psql for the GROUP BY since
 * PostgREST cannot express SUBSTR-based grouping. Same pattern as
 * src/analysis/cluster-by-sector.ts.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import {
  type ApiServerConfig,
  type SectorEntry,
  type SectorsResult,
} from "../types.js";

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

export async function sectorsHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const counts = await fetchSectorCounts(config);
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
  return c.json(payload);
}

async function fetchSectorCounts(
  config: ApiServerConfig,
): Promise<Array<[string, number]>> {
  const sql =
    "SELECT json_agg(row_to_json(t)) FROM (" +
    "  SELECT SUBSTR(clee, 6, 2) AS scian, COUNT(*)::bigint AS count" +
    "  FROM establecimientos" +
    "  GROUP BY 1" +
    "  ORDER BY 1" +
    ") t;";

  let stdout: string;
  try {
    stdout = execFileSync(
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
      { encoding: "utf-8", timeout: 30_000 },
    ).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      `sector aggregate failed: ${msg}`,
      502,
      "postgres.error",
    );
  }

  if (!stdout || stdout === "null") return [];
  const rows = JSON.parse(stdout) as Array<{
    scian: string;
    count: number | string;
  }>;
  return rows.map((r) => [r.scian, Number(r.count)] as [string, number]);
}
