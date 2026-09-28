import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 027 carries a verbatim copy of the municipios_2025 section of
// scripts/migrate-censo-views.sql, the canonical DDL load-censo.ts re-runs
// on every Censo reload. psql fed over stdin cannot \i a host file, so the
// copy is the reuse and this test is what keeps it one definition.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

const MIGRATION = read("scripts/migrations/027-municipio-bridge-2025.sql");
const CENSO_VIEWS_SQL = read("scripts/migrate-censo-views.sql");

const OPEN = "-- >>> municipios_2025 section";
const CLOSE = "-- <<< municipios_2025 section";

function section(sql: string): string {
  const start = sql.indexOf(OPEN);
  const end = sql.indexOf(CLOSE);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(sql.indexOf(OPEN, start + 1)).toBe(-1);
  return sql.slice(start, end + CLOSE.length);
}

describe("027-municipio-bridge-2025.sql", () => {
  it("copies the migrate-censo-views.sql section byte for byte", () => {
    expect(section(MIGRATION)).toBe(section(CENSO_VIEWS_SQL));
  });

  it("seeds the 11 (child, parent) pairs of the recon table", () => {
    const pairs = [
      ...section(MIGRATION).matchAll(/\('(\d{5})', '[^']+', +'(\d{5})', '[^']+', +'\d{4}-\d{2}-\d{2}'\)/g),
    ].map((m) => `${m[1]}<${m[2]}`);
    expect(pairs.sort()).toEqual(
      [
        "02007<02001",
        "02007<02002",
        "04013<04001",
        "12082<12053",
        "12083<12012",
        "12084<12041",
        "12085<12023",
        "24059<24028",
        "25019<25006",
        "25020<25011",
        "25020<25001",
      ].sort(),
    );
  });

  it("gives the children NULL census fields, never a parent's", () => {
    const view = section(MIGRATION).slice(
      section(MIGRATION).indexOf("CREATE OR REPLACE VIEW municipios_2025"),
    );
    const children = view.slice(view.indexOf("UNION ALL"));
    // The child branch reads only the bridge and the entidad name.
    expect(children).not.toMatch(/\bcenso_municipios\b/);
    expect(children).toMatch(/LEFT JOIN censo_entidades ce ON ce\.cve_ent = left\(b\.cve_mun_2025, 2\)/);
  });

  it("runs in one transaction, grants both relations, then asserts 2,478 keys", () => {
    const body = MIGRATION.split("\n")
      .filter((l) => !l.trimStart().startsWith("--"))
      .join("\n");
    expect(body.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(body.trimEnd().endsWith("COMMIT;")).toBe(true);
    for (const rel of ["municipio_bridge_2025", "municipios_2025"]) {
      expect(body).toContain(`REVOKE ALL ON ${rel} FROM anon, authenticated, trustr_app;`);
      expect(body).toContain(`GRANT SELECT ON ${rel} TO denue_sage;`);
      expect(body).toContain(`GRANT SELECT ON ${rel} TO denue_api;`);
    }
    expect(body).toContain(
      "IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'denue_api') THEN",
    );
    const check = body.lastIndexOf("RAISE EXCEPTION");
    expect(check).toBeGreaterThan(body.indexOf("CREATE OR REPLACE VIEW municipios_2025"));
    expect(body).toMatch(
      /IF n_pairs <> 11 OR n_children <> 9 OR n_bad_par <> 0 OR n_clash <> 0\s+OR n_rows <> 2478 OR n_keys <> 2478 THEN/,
    );
  });

  it("is allowlisted for both roles", () => {
    const sage = read("scripts/sage-role.sql");
    const api = read("scripts/api-role.sql");
    for (const rel of ["municipio_bridge_2025", "municipios_2025"]) {
      expect(sage).toMatch(new RegExp(`^\\s*GRANT SELECT ON ${rel} TO denue_sage;`, "m"));
      expect(api).toContain(`'${rel}',`);
    }
  });
});
