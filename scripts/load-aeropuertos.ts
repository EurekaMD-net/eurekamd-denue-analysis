#!/usr/bin/env npx tsx --env-file=.env
/**
 * Loader: SCT/AFAC airport operations (2006-2026 March, per airport).
 *
 * Source: gob.mx producto-aeropuertos-2006-2026-mar-NNNNNNNN.xlsx (F5/Imperva-
 * gated; download via mc's Playwright stealth fetch).
 *
 * Structure of the input XLSX:
 *   Sheet "TD Prod Aptos" is a pivot table with operator codes as parent rows
 *   (AICM/AIFA/ASA/ASUR/GACM/OMA/GAP/MIDCM/CHIH-PAC/TOL) and airport names as
 *   child rows. Same airport may appear under multiple operators when
 *   privatization transferred ownership; downstream we dedupe by airport name
 *   across operators. The metric is March-of-year FLIGHTS (operations), not
 *   passengers — the chart sheet has top-10 passenger data but TD has
 *   coverage for ~60-70 airports.
 *
 * Pre-flight: this script reads from the manually-curated lookup
 * `scripts/aeropuertos-cvemun.json` (airport_name → cve_mun mapping). Only
 * airports in that file get loaded — unmapped airports are reported and
 * skipped. The lookup is the integration boundary: Mexican airports don't
 * have a clean public airport→cve_mun mapping, so we curate it.
 *
 * Usage:
 *   npx tsx --env-file=.env scripts/load-aeropuertos.ts
 *     [--csv=raw/airports/producto-aeropuertos.csv]
 *     [--lookup=scripts/aeropuertos-cvemun.json]
 *     [--force]   # bypass the safety check
 *
 * The CSV is produced by the companion Python script `aeropuertos-xlsx-to-csv.py`
 * — the XLSX has merged cells and formula references that JS xlsx libraries
 * choke on; openpyxl with data_only=True is the proven path.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { argv, exit } from "node:process";

interface Args {
  csv: string;
  lookup: string;
  force: boolean;
  container: string;
}

function parseArgs(): Args {
  const args = argv.slice(2);
  let csv = "raw/airports/producto-aeropuertos.csv";
  let lookup = "scripts/aeropuertos-cvemun.json";
  let force = false;
  for (const a of args) {
    if (a.startsWith("--csv=")) csv = a.slice(6);
    else if (a.startsWith("--lookup=")) lookup = a.slice(9);
    else if (a === "--force") force = true;
  }
  return {
    csv,
    lookup,
    force,
    container: process.env.SUPABASE_DB_CONTAINER ?? "supabase-db",
  };
}

const SAFE_CONTAINER_RE = /^[a-zA-Z0-9_.-]+$/;

const CREATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS aeropuertos_movements_raw (
  airport_name TEXT NOT NULL,
  operator     TEXT,
  ano          INTEGER NOT NULL,
  mar_flights  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (airport_name, operator, ano)
);

CREATE INDEX IF NOT EXISTS idx_aero_raw_name ON aeropuertos_movements_raw(airport_name);
CREATE INDEX IF NOT EXISTS idx_aero_raw_ano ON aeropuertos_movements_raw(ano);
`.trim();

// View that dedupes across operators (sum per airport_name, ano) AND joins
// the cve_mun lookup. Airports without a cve_mun map are excluded from
// the view (but kept in the raw table for forensic analysis).
const POST_LOAD_SQL = `
BEGIN;

CREATE OR REPLACE VIEW aeropuertos_movements_yearly AS
SELECT
  m.airport_name,
  l.cve_mun,
  l.cve_ent,
  m.ano,
  SUM(m.mar_flights)::INTEGER AS mar_flights
FROM aeropuertos_movements_raw m
JOIN aeropuertos_cvemun_lookup l ON UPPER(TRIM(m.airport_name)) = UPPER(TRIM(l.airport_name))
GROUP BY m.airport_name, l.cve_mun, l.cve_ent, m.ano;

-- Convenience: per-municipio activity. Aggregates all airports in a muni.
-- Recent baseline = avg of 2024 + 2025 + 2026 March values.
-- Pre-pandemic baseline = 2019 March (last full pre-COVID year).
CREATE OR REPLACE VIEW aeropuertos_by_municipio AS
WITH per_muni_year AS (
  SELECT
    cve_mun,
    cve_ent,
    ano,
    SUM(mar_flights)::INTEGER AS flights,
    COUNT(DISTINCT airport_name)::INTEGER AS num_airports
  FROM aeropuertos_movements_yearly
  GROUP BY cve_mun, cve_ent, ano
)
SELECT
  p.cve_mun,
  p.cve_ent,
  MAX(p.num_airports) FILTER (WHERE p.ano = 2026) AS num_airports_active_2026,
  ROUND(AVG(p.flights) FILTER (WHERE p.ano IN (2024, 2025, 2026)))::INTEGER AS mar_flights_recent_avg,
  MAX(p.flights) FILTER (WHERE p.ano = 2019) AS mar_flights_2019_baseline,
  MAX(p.flights) FILTER (WHERE p.ano = 2026) AS mar_flights_2026,
  CASE
    WHEN MAX(p.flights) FILTER (WHERE p.ano = 2019) > 0
    THEN ROUND(
      (MAX(p.flights) FILTER (WHERE p.ano = 2026) -
       MAX(p.flights) FILTER (WHERE p.ano = 2019))::numeric * 100.0
      / MAX(p.flights) FILTER (WHERE p.ano = 2019)
    , 1)
    ELSE NULL
  END AS pct_change_vs_2019
FROM per_muni_year p
GROUP BY p.cve_mun, p.cve_ent;

COMMIT;
`.trim();

interface LookupEntry {
  airport_name: string;
  cve_mun: string;
  cve_ent: string;
}

function dockerExec(container: string, args: string[]): string {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name: ${container}`);
  }
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function dockerExecStdin(
  container: string,
  args: string[],
  stdin: string,
): string {
  if (!SAFE_CONTAINER_RE.test(container)) {
    throw new Error(`unsafe container name: ${container}`);
  }
  return execFileSync("docker", ["exec", "-i", container, ...args], {
    encoding: "utf-8",
    input: stdin,
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function main(): Promise<void> {
  const args = parseArgs();

  if (!existsSync(args.csv)) {
    console.error(
      `[load-aeropuertos] CSV not found: ${args.csv}. Run scripts/aeropuertos-xlsx-to-csv.py first.`,
    );
    exit(1);
  }
  if (!existsSync(args.lookup)) {
    console.error(`[load-aeropuertos] lookup JSON not found: ${args.lookup}`);
    exit(1);
  }

  const lookupRaw = JSON.parse(readFileSync(args.lookup, "utf-8")) as {
    entries: LookupEntry[];
  };
  console.log(
    `[load-aeropuertos] lookup has ${lookupRaw.entries.length} mapped airports`,
  );

  // Apply schema FIRST so the idempotency check below can run on a fresh
  // DB. CREATE TABLE IF NOT EXISTS is idempotent — applying ahead of the
  // count check is safe.
  console.log("[load-aeropuertos] applying schema...");
  dockerExecStdin(
    args.container,
    ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    CREATE_SCHEMA_SQL,
  );

  // Idempotency check (audit C1 pattern from load-edr) — refuse to overwrite
  // populated table without --force.
  const countOut = dockerExec(args.container, [
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tA",
    "-c",
    "SELECT COUNT(*) FROM aeropuertos_movements_raw;",
  ]).trim();
  const existing = Number.parseInt(countOut || "0", 10);
  if (existing > 0 && !args.force) {
    console.error(
      `[load-aeropuertos] aeropuertos_movements_raw has ${existing} rows. Use --force to truncate + reload.`,
    );
    exit(2);
  }

  // Materialize lookup table (idempotent — recreated each load)
  console.log("[load-aeropuertos] writing lookup table...");
  const lookupSql = `
DROP TABLE IF EXISTS aeropuertos_cvemun_lookup;
CREATE TABLE aeropuertos_cvemun_lookup (
  airport_name TEXT PRIMARY KEY,
  cve_mun      TEXT NOT NULL,
  cve_ent      TEXT NOT NULL
);
${lookupRaw.entries
  .map(
    (e) =>
      `INSERT INTO aeropuertos_cvemun_lookup (airport_name, cve_mun, cve_ent) VALUES (${[
        e.airport_name,
        e.cve_mun,
        e.cve_ent,
      ]
        .map((v) => `'${String(v).replace(/'/g, "''")}'`)
        .join(", ")});`,
  )
  .join("\n")}
`;
  dockerExecStdin(
    args.container,
    ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    lookupSql,
  );

  // Truncate + load CSV (idempotent under --force)
  console.log("[load-aeropuertos] truncating + loading raw CSV...");
  dockerExecStdin(
    args.container,
    ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    `TRUNCATE TABLE aeropuertos_movements_raw;`,
  );

  const csvBuf = readFileSync(args.csv);
  const copyCmd = `\\copy aeropuertos_movements_raw (airport_name, operator, ano, mar_flights) FROM STDIN WITH (FORMAT csv, HEADER true)`;
  execFileSync(
    "docker",
    [
      "exec",
      "-i",
      args.container,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      copyCmd,
    ],
    { input: csvBuf, maxBuffer: 64 * 1024 * 1024 },
  );

  // POST_LOAD: views
  console.log("[load-aeropuertos] applying POST_LOAD_SQL (views)...");
  dockerExecStdin(
    args.container,
    ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    POST_LOAD_SQL,
  );

  // Report
  const stats = dockerExec(args.container, [
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tA",
    "-c",
    `SELECT
       (SELECT COUNT(*) FROM aeropuertos_movements_raw) AS raw_rows,
       (SELECT COUNT(DISTINCT airport_name) FROM aeropuertos_movements_yearly) AS mapped_airports,
       (SELECT COUNT(*) FROM aeropuertos_by_municipio) AS munis_with_airport;`,
  ]).trim();
  console.log(`[load-aeropuertos] done. ${stats}`);
}

await main();
