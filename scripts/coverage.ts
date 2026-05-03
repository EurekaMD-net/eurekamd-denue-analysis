#!/usr/bin/env tsx
/**
 * Coverage report CLI
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/coverage.ts
 *
 * Prerequisite: apply src/db/materialized-views.sql + REFRESH mv_coverage.
 */

import { coverageReport, formatCoverageReport } from "../src/analysis/coverage-report.js";

const config = {
  supabaseUrl: process.env["SUPABASE_URL"] ?? "http://localhost:8100",
  serviceRoleKey: process.env["SUPABASE_SERVICE_KEY"] ?? "",
};

if (!config.serviceRoleKey) {
  console.error("SUPABASE_SERVICE_KEY is required");
  process.exit(1);
}

const report = await coverageReport(config);
console.log(formatCoverageReport(report));
