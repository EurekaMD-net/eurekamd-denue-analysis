import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Audit #111 #112 #113: DENUE relations must not be reachable by the public
// PostgREST roles (anon/authenticated) nor by trustr_app.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

const MIGRATION = read("scripts/migrations/002-grants-lockdown.sql");

/** Relation names in the migration's REVOKE loop array. */
function revokedRelations(): Set<string> {
  const arr = /FOREACH r IN ARRAY ARRAY\[([\s\S]*?)\]/.exec(MIGRATION);
  expect(arr).not.toBeNull();
  return new Set([...(arr as RegExpExecArray)[1]!.matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!));
}

describe("002-grants-lockdown.sql", () => {
  it("revokes anon/authenticated/trustr_app from the polygon tables, establecimientos and mv_coverage", () => {
    expect(MIGRATION).toContain(
      "EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, trustr_app', r);",
    );
    const rels = revokedRelations();
    for (const r of [
      "ageb_polygons",
      "mun_polygons",
      "ent_polygons",
      "loc_polygons",
      "establecimientos",
      "establecimientos_geo",
      "mv_coverage",
      "sage_turns_audit",
    ]) {
      expect(rels.has(r), r).toBe(true);
    }
  });

  it("covers every relation materialized-views.sql creates", () => {
    const rels = revokedRelations();
    const created = [
      ...read("src/db/materialized-views.sql").matchAll(
        /CREATE MATERIALIZED VIEW IF NOT EXISTS ([a-z_0-9]+)/g,
      ),
    ].map((m) => m[1]!);
    expect(created.length).toBeGreaterThan(0);
    for (const r of created) expect(rels.has(r), r).toBe(true);
  });

  it("moves the polygon tables off supabase_admin", () => {
    for (const t of ["ageb_polygons", "mun_polygons", "ent_polygons", "loc_polygons"]) {
      expect(MIGRATION).toContain(`ALTER TABLE ${t} OWNER TO postgres;`);
    }
  });

  it("covers the MG 2025 polygon tables, guarded for instances without them", () => {
    const rels = revokedRelations();
    for (const t of ["ageb_polygons_2025", "mun_polygons_2025"]) {
      expect(rels.has(t), t).toBe(true);
      expect(MIGRATION).toContain(`ALTER TABLE IF EXISTS ${t} OWNER TO postgres;`);
    }
  });

  it("never touches whole-schema grants (other apps share public)", () => {
    expect(MIGRATION).not.toMatch(/^\s*[^-\s].*ALL TABLES IN SCHEMA/im);
    expect(MIGRATION).not.toMatch(/^\s*ALTER DEFAULT PRIVILEGES/im);
  });

  it("bounds the PostgREST roles and reloads PostgREST", () => {
    expect(MIGRATION).toContain("ALTER ROLE anon SET statement_timeout = '3s';");
    expect(MIGRATION).toContain("ALTER ROLE authenticated SET statement_timeout = '8s';");
    expect(MIGRATION).toContain("ALTER ROLE service_role SET statement_timeout = '30s';");
    expect(MIGRATION).toContain("NOTIFY pgrst, 'reload config';");
  });
});

describe("DDL no longer re-grants public PostgREST roles", () => {
  it("materialized-views.sql grants nothing to anon/authenticated", () => {
    // Old code: `GRANT SELECT ON mv_coverage TO anon, authenticated;` (fails here).
    expect(read("src/db/materialized-views.sql")).not.toMatch(
      /GRANT[^;]*TO[^;]*\b(anon|authenticated)\b/i,
    );
  });

  it("backfill-ageb.ts polygon recipe re-applies the lockdown right after ogr2ogr", () => {
    const src = read("scripts/backfill-ageb.ts");
    const ogr = src.indexOf("ogr2ogr the Marco");
    const revoke = src.indexOf("scripts/migrations/002-grants-lockdown.sql");
    expect(ogr).toBeGreaterThan(-1);
    expect(revoke).toBeGreaterThan(ogr);
    expect(src).toContain("REVOKE ALL ON ageb_polygons FROM anon, authenticated, trustr_app;");
  });
});
