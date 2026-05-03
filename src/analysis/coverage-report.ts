/**
 * Runner: Coverage Report
 *
 * Reads mv_coverage (materialized view) via PostgREST and formats a
 * human-readable table showing loaded records per entidad.
 *
 * Prerequisite: apply src/db/materialized-views.sql and REFRESH mv_coverage.
 */

import type { AnalysisConfig } from "./types.js";

export interface CoverageRow {
  entidad: string;
  loaded: number;
  with_geom: number;
  with_telefono: number;
  with_correo_e: number;
  first_loaded_at: string | null;
  last_updated_at: string | null;
}

export interface CoverageReport {
  rows: CoverageRow[];
  total_loaded: number;
  entidades_loaded: number;
}

export async function coverageReport(config: AnalysisConfig): Promise<CoverageReport> {
  const { supabaseUrl, serviceRoleKey } = config;

  const res = await fetch(
    `${supabaseUrl}/rest/v1/mv_coverage?order=entidad.asc`,
    {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    },
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`coverageReport: PostgREST returned HTTP ${res.status}: ${body}`);
  }

  const rows = (await res.json()) as CoverageRow[];
  const total_loaded = rows.reduce((s, r) => s + Number(r.loaded), 0);

  return { rows, total_loaded, entidades_loaded: rows.length };
}

/** Format a CoverageReport as a plain-text table for CLI output. */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [
    `Entidad  Loaded       Geo%   Tel%   Email%  First loaded`,
    `-------  -----------  -----  -----  ------  -------------------------`,
  ];

  for (const r of report.rows) {
    const loaded = Number(r.loaded);
    const geoPct  = loaded > 0 ? ((Number(r.with_geom)     / loaded) * 100).toFixed(1) : "0.0";
    const telPct  = loaded > 0 ? ((Number(r.with_telefono) / loaded) * 100).toFixed(1) : "0.0";
    const mailPct = loaded > 0 ? ((Number(r.with_correo_e) / loaded) * 100).toFixed(1) : "0.0";
    const date    = r.first_loaded_at ? r.first_loaded_at.slice(0, 10) : "—";

    lines.push(
      `${r.entidad.padEnd(7)}  ${String(loaded).padEnd(11)}  ${geoPct.padStart(5)}  ${telPct.padStart(5)}  ${mailPct.padStart(6)}  ${date}`,
    );
  }

  lines.push(`-------  -----------`);
  lines.push(`TOTAL    ${String(report.total_loaded).padEnd(11)}  (${report.entidades_loaded} entidades)`);

  return lines.join("\n");
}
