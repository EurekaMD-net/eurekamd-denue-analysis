import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { MAP_LAYER_REGISTRY } from "../src/api/handlers/layers-values.js";

// Audit #8: the API's psql runner logs in as denue_api, so a relation the
// API reads without a GRANT here is a 502 in production. These checks keep
// scripts/api-role.sql in step with the SQL the runner's callers build.

const read = (p: string) => readFileSync(p, "utf-8");
const ROLE_SQL = read("scripts/api-role.sql");

// Every file whose SQL goes through src/api/db/psql-runner.ts.
const RUNNER_CALLERS = [
  "src/api/handlers/analytics.ts",
  "src/api/handlers/layers-values.ts",
  "src/api/handlers/search.ts",
  "src/api/handlers/sectors.ts",
  "src/api/handlers/summary-sector.ts",
  "src/api/handlers/tiles.ts",
  "src/analysis/cluster-by-sector.ts",
  "src/osm/osmium.ts",
];

const SAGE_TABLES = ["sage_threads", "sage_turns_audit"];

/** Relations the SELECT loop in api-role.sql grants. */
function selectAllowlist(): Set<string> {
  const start = ROLE_SQL.indexOf("FOREACH r IN ARRAY ARRAY[");
  const loop = ROLE_SQL.slice(start, ROLE_SQL.indexOf("]", start));
  return new Set([...loop.matchAll(/'([a-z_][a-z0-9_]*)'/g)].map((m) => m[1]!));
}

/** Static FROM/JOIN targets in a TS file's SQL, minus its CTE names. */
function relationRefs(path: string): string[] {
  const src = read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const ctes = new Set(
    [
      ...src.matchAll(
        /\b([a-z_][a-z0-9_]*)\s*(?:\([^)]*\))?\s+AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(/gi,
      ),
    ].map((m) => m[1]!.toLowerCase()),
  );
  // `(?![\w$])` skips interpolated names (`FROM ${rel}`, `JOIN l${i}`),
  // which are checked from their source constants below.
  return [...src.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)(?![\w$])/g)]
    .map((m) => m[1]!)
    .filter((r) => !ctes.has(r));
}

describe("scripts/api-role.sql", () => {
  const allow = selectAllowlist();

  it("creates denue_api as a password-less, non-superuser LOGIN role", () => {
    expect(ROLE_SQL).toContain("CREATE ROLE denue_api LOGIN;");
    expect(ROLE_SQL).toMatch(
      /ALTER ROLE denue_api LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE\s+NOREPLICATION NOBYPASSRLS;/,
    );
    expect(ROLE_SQL).toContain("\\set ON_ERROR_STOP on");
  });

  it("never grants whole-schema table access", () => {
    expect(ROLE_SQL).not.toMatch(/GRANT[^;]*ON ALL TABLES/i);
    expect(ROLE_SQL).toContain("GRANT USAGE ON SCHEMA public TO denue_api;");
  });

  it("grants write only on the Sage thread tables", () => {
    const writes = [...ROLE_SQL.matchAll(/INSERT, UPDATE, DELETE ON/g)];
    expect(writes).toHaveLength(1);
    const sageLoop = ROLE_SQL.slice(ROLE_SQL.indexOf("-- Sage thread store"));
    for (const t of SAGE_TABLES) expect(sageLoop).toContain(`'${t}'`);
    for (const t of SAGE_TABLES) expect(allow.has(t)).toBe(false);
  });

  it("grants SELECT on every static FROM/JOIN target of the runner's callers", () => {
    const missing = RUNNER_CALLERS.flatMap((f) =>
      relationRefs(f)
        .filter((r) => !allow.has(r))
        .map((r) => `${f}: ${r}`),
    );
    expect(missing).toEqual([]);
  });

  it("grants SELECT on both MG 2025 polygon tables next to the 2020 ones", () => {
    for (const t of ["mun_polygons", "ageb_polygons", "mun_polygons_2025", "ageb_polygons_2025"]) {
      expect(allow.has(t), t).toBe(true);
    }
  });

  it("grants SELECT on every layers-values registry source", () => {
    const froms = Object.values(MAP_LAYER_REGISTRY).map((d) => d.from);
    expect(froms.length).toBeGreaterThan(0);
    expect(froms.filter((r) => !allow.has(r))).toEqual([]);
  });

  it("grants SELECT on both SINBA morbidity relations analytics interpolates", () => {
    const src = read("src/api/handlers/analytics.ts");
    const rels = [
      ...src.matchAll(/const SINBA_MORBIDITY_(?:MV|VIEW) = "([a-z_]+)";/g),
    ].map((m) => m[1]!);
    expect(rels).toHaveLength(2);
    expect(rels.filter((r) => !allow.has(r))).toEqual([]);
  });
});

describe("SQL that DROP + CREATEs an API-read materialized view", () => {
  it("perf-matviews.sql re-grants every MV it creates to denue_api", () => {
    const sql = read("scripts/perf-matviews.sql");
    const created = [
      ...sql.matchAll(/^CREATE MATERIALIZED VIEW ([a-z_]+)/gm),
    ].map((m) => m[1]!);
    expect(created.length).toBeGreaterThan(0);
    for (const mv of created) {
      expect(sql).toContain(`GRANT SELECT ON ${mv} TO denue_api;`);
    }
  });

  it.each([
    ["scripts/migrations/018-mv-sinba-morbidity.sql", "mv_sinba_morbidity_municipal"],
    ["scripts/migrations/019-censo-views-treemap-geoms.sql", "mv_national_treemap"],
    ["scripts/migrations/021-summary-mvs.sql", "mv_sector_summary"],
  ])("%s grants %s to denue_api when the role exists", (path, mv) => {
    const sql = read(path);
    expect(sql).toContain(`GRANT SELECT ON ${mv} TO denue_api;`);
    expect(sql).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_api') THEN",
    );
  });
});
