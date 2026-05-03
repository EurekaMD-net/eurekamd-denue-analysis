/**
 * Runner: Coverage Report
 *
 * Reads mv_coverage (materialized view) via PostgREST and joins each entidad
 * row against the verified INEGI authoritative counts in
 * src/db/inegi_authoritative_counts.json. Computes coverage_pct + status.
 *
 * Prerequisite: apply src/db/materialized-views.sql and REFRESH mv_coverage.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
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

export type CoverageStatus = "green" | "yellow" | "red" | "unverified";

export interface EnrichedCoverageRow extends CoverageRow {
  inegi_total: number | null;
  coverage_pct: number | null;
  status: CoverageStatus;
}

export interface CoverageReport {
  rows: EnrichedCoverageRow[];
  total_loaded: number;
  entidades_loaded: number;
  verified_at: string | null;
}

interface InegiCountsFile {
  _verified_at?: string;
  counts: Record<string, number | null>;
}

/**
 * Loads the INEGI authoritative counts JSON from src/db/.
 * Exported for testability; pass an override path in tests.
 */
export function loadInegiCounts(overridePath?: string): InegiCountsFile {
  const filePath =
    overridePath ??
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "db",
      "inegi_authoritative_counts.json",
    );
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as InegiCountsFile;
}

/** Compute the coverage status bucket for one entidad. */
export function statusFor(
  loaded: number,
  inegiTotal: number | null,
): CoverageStatus {
  if (inegiTotal === null || inegiTotal === undefined) return "unverified";
  const pct = (loaded / inegiTotal) * 100;
  if (pct >= 99) return "green";
  if (pct >= 90) return "yellow";
  return "red";
}

export async function coverageReport(
  config: AnalysisConfig,
  inegiCountsOverride?: InegiCountsFile,
): Promise<CoverageReport> {
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
    throw new Error(
      `coverageReport: PostgREST returned HTTP ${res.status}: ${body}`,
    );
  }

  const rows = (await res.json()) as CoverageRow[];
  const inegiCounts = inegiCountsOverride ?? loadInegiCounts();

  const enriched: EnrichedCoverageRow[] = rows.map((r) => {
    const loaded = Number(r.loaded);
    const inegi_total = inegiCounts.counts[r.entidad] ?? null;
    const coverage_pct =
      inegi_total !== null && inegi_total > 0
        ? Number(((loaded / inegi_total) * 100).toFixed(2))
        : null;
    return {
      ...r,
      loaded,
      inegi_total,
      coverage_pct,
      status: statusFor(loaded, inegi_total),
    };
  });

  const total_loaded = enriched.reduce((s, r) => s + r.loaded, 0);
  return {
    rows: enriched,
    total_loaded,
    entidades_loaded: enriched.length,
    verified_at: inegiCounts._verified_at ?? null,
  };
}

const STATUS_GLYPH: Record<CoverageStatus, string> = {
  green: "✅",
  yellow: "⚠️ ",
  red: "❌",
  unverified: "❓",
};

/** Format a CoverageReport as a plain-text table for CLI output. */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = [
    `St  Ent  Loaded       INEGI total   Cov%      Geo%   First loaded`,
    `--  ---  -----------  ------------  --------  -----  -------------------------`,
  ];

  for (const r of report.rows) {
    const inegi = r.inegi_total === null ? "—" : String(r.inegi_total);
    const cov = r.coverage_pct === null ? "—" : `${r.coverage_pct.toFixed(2)}%`;
    const geoPct =
      r.loaded > 0
        ? `${((Number(r.with_geom) / r.loaded) * 100).toFixed(1)}`
        : "0.0";
    const date = r.first_loaded_at ? r.first_loaded_at.slice(0, 10) : "—";

    lines.push(
      `${STATUS_GLYPH[r.status]}  ${r.entidad.padEnd(3)}  ${String(r.loaded).padEnd(11)}  ${inegi.padEnd(12)}  ${cov.padEnd(8)}  ${geoPct.padStart(5)}  ${date}`,
    );
  }

  lines.push(`--  ---  -----------`);
  lines.push(
    `TOTAL    ${String(report.total_loaded).padEnd(11)}  (${report.entidades_loaded} entidades, verificado ${report.verified_at ?? "?"})`,
  );

  return lines.join("\n");
}
