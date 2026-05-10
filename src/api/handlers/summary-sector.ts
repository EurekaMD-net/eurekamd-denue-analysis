/**
 * GET /summary/sector/:scian — national breakdown of one 2-digit SCIAN.
 *
 * Returns: { scian, total_national, top_entidades: [{entidad, count}, ...] }
 *
 * SCIAN source: indexed `sector_actividad_id` column on `establecimientos`
 * (backfilled from CLEE chars 6-7 by src/db/loader.ts:deriveScian).
 *
 * NOTE on a pre-P1 bug fixed here: the prior implementation built a
 * PostgREST `clee=like.${entidad}${scian}*` filter, which matched CLEEs
 * by entidad + municipio-prefix (chars 3-4), not by SCIAN. Result: every
 * count for `/summary/sector/:scian` was wrong. The indexed column makes
 * that whole bug class impossible by construction.
 *
 * Implementation: shell to psql like sectors.ts / cluster-by-sector.ts.
 * One query returns the full per-entidad breakdown via json_agg.
 */

import { execFileSync } from "node:child_process";
import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import {
  SCIAN_RE,
  type ApiServerConfig,
  type SectorSummaryResult,
} from "../types.js";
import { assertSafeContainer } from "./_safe-container.js";

const TOP_ENTIDADES_LIMIT = 10;

export async function summarySectorHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const scian = c.req.param("scian");
  if (!scian || !SCIAN_RE.test(scian)) {
    throw new HttpError(
      `SCIAN inválido "${scian}" — debe ser 2 dígitos`,
      400,
      "validation.scian",
    );
  }

  const counts = await fetchPerEntidadCounts(config, scian);
  const total_national = counts.reduce((s, x) => s + x.count, 0);
  const top_entidades = [...counts]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_ENTIDADES_LIMIT);

  const result: SectorSummaryResult = {
    scian,
    total_national,
    top_entidades,
  };
  return c.json(result);
}

async function fetchPerEntidadCounts(
  config: ApiServerConfig,
  scian: string,
): Promise<Array<{ entidad: string; count: number }>> {
  assertSafeContainer(config.dbContainer);
  // scian is regex-validated (^[0-9]{2}$) BEFORE reaching here, so the
  // single-quote interpolation cannot escape into SQL.
  // Uses sector_actividad_id (backfilled from CLEE chars 6-7) to hit the
  // idx_estab_sector btree — much faster than a SUBSTR scan.
  const sql =
    "SELECT json_agg(row_to_json(t)) FROM (" +
    "  SELECT entidad, COUNT(*)::bigint AS count" +
    "  FROM establecimientos" +
    `  WHERE sector_actividad_id = '${scian}'` +
    "  GROUP BY entidad" +
    "  ORDER BY entidad" +
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
      {
        encoding: "utf-8",
        timeout: 30_000,
        // Audit C3-perf round-1 closure 2026-05-10.
        env: { ...process.env, PGOPTIONS: "-c statement_timeout=25000" },
      },
    ).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new HttpError(
      `summary aggregate failed: ${msg}`,
      502,
      "postgres.error",
    );
  }

  if (!stdout || stdout === "null") return [];
  const rows = JSON.parse(stdout) as Array<{
    entidad: string;
    count: number | string;
  }>;
  return rows.map((r) => ({ entidad: r.entidad, count: Number(r.count) }));
}
