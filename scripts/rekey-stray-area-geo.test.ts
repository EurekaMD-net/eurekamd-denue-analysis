import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Pins the shape of the area_geo re-key (bogus INEGI CLEE prefixes) and its
// registration as a DENUE refresh post-step. Behaviour was proved on a
// throwaway Postgres; these guard the properties that proof relied on.
const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(join(HERE, "rekey-stray-area-geo.sql"), "utf-8");
const SH = readFileSync(join(HERE, "..", "ops", "denue-refresh.sh"), "utf-8");

// Comment-free SQL, so header prose cannot satisfy (or trip) a pin.
const CODE = SQL.split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("rekey-stray-area-geo.sql", () => {
  it("takes the new key from mun_polygons_2025.cvegeo, never its 3-digit cve_mun", () => {
    expect(CODE).toMatch(/min\(p\.cvegeo\)::text AS new_area_geo/);
    expect(CODE).not.toMatch(/p\.cve_mun/);
  });

  it("finds stray keys from DISTINCT area_geo anti-joined to municipios_2025, then reads rows by key", () => {
    expect(CODE).toMatch(
      /WITH keys AS \(\s*SELECT DISTINCT area_geo FROM establecimientos WHERE area_geo IS NOT NULL\s*\)/,
    );
    expect(CODE).toMatch(
      /NOT EXISTS \(SELECT 1 FROM municipios_2025 m WHERE m\.cve_mun = k\.area_geo\)/,
    );
    expect(CODE).toMatch(/e\.area_geo = ANY \(ARRAY\(SELECT area_geo FROM stray_keys\)\)/);
  });

  it("resolves spatially, only rows with geom, only with exactly one containing polygon", () => {
    expect(CODE).toMatch(/ST_Contains\(p\.geom, r\.geom\)/);
    expect(CODE).toMatch(/r\.geom IS NOT NULL/);
    expect(CODE).toMatch(/HAVING count\(\*\) = 1;/);
  });

  it("reports unresolved rows in a NOTICE", () => {
    expect(CODE).toMatch(/RAISE NOTICE '[^']*% unresolved \(left untouched\)'/);
    expect(CODE).toMatch(/n_rows - n_stray/);
  });

  it("wraps the UPDATE in an explicit transaction that commits only after the assertion", () => {
    const begin = CODE.indexOf("BEGIN;");
    const lock = CODE.indexOf("SET LOCAL lock_timeout");
    const update = CODE.indexOf("UPDATE establecimientos");
    const raise = CODE.indexOf("RAISE EXCEPTION");
    const commit = CODE.indexOf("COMMIT;");
    expect(begin).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(begin);
    expect(update).toBeGreaterThan(lock);
    expect(raise).toBeGreaterThan(update);
    expect(commit).toBeGreaterThan(raise);
    expect(CODE.indexOf("COMMIT;", commit + 1)).toBe(-1);
    expect(CODE.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("asserts every resolvable row was re-keyed and none still carries an invalid key", () => {
    const assertion = CODE.slice(CODE.indexOf("UPDATE establecimientos"));
    expect(assertion).toMatch(/IF n_rekeyed <> n_stray OR n_invalid <> 0 OR n_ent_bad <> 0 THEN/);
    expect(assertion).toMatch(
      /WHERE NOT EXISTS \(SELECT 1 FROM municipios_2025 m WHERE m\.cve_mun = e\.area_geo\)/,
    );
  });

  it("never deletes or truncates", () => {
    expect(CODE).not.toMatch(/\bDELETE\b/i);
    expect(CODE).not.toMatch(/\bTRUNCATE\b/i);
  });

  it("has exactly one UPDATE and it sets only area_geo and entidad (from the new key)", () => {
    expect(CODE.match(/\bUPDATE\b/g)).toHaveLength(1);
    const set = CODE.match(/UPDATE establecimientos e\s+SET ([\s\S]*?)\s+FROM stray s/);
    // One assignment per line; a comma inside left(..., 2) is not a separator.
    const cols = (set?.[1] ?? "").split(/,\s*\n/).map((c) => c.trim().replace(/\s+/g, " "));
    expect(cols).toEqual(["area_geo = s.new_area_geo", "entidad = left(s.new_area_geo, 2)"]);
    expect(CODE).toMatch(
      /AND \(e\.area_geo IS DISTINCT FROM s\.new_area_geo\s+OR e\.entidad IS DISTINCT FROM left\(s\.new_area_geo, 2\)\);/,
    );
  });

  it("asserts entidad matches the new area_geo prefix and prints the entidad changes", () => {
    const assertion = CODE.slice(CODE.indexOf("UPDATE establecimientos"));
    expect(assertion).toMatch(/WHERE e\.entidad IS DISTINCT FROM left\(e\.area_geo, 2\);/);
    expect(assertion).toMatch(/OR n_ent_bad <> 0 THEN/);
    expect(CODE).toMatch(
      /count\(\*\) FILTER \(WHERE old_entidad IS DISTINCT FROM left\(new_area_geo, 2\)\) AS entidad_changes/,
    );
  });

  it("drops its temp tables on commit, runs serially and bounds the statement time", () => {
    for (const t of ["stray_keys", "stray_rows", "stray"]) {
      expect(CODE).toMatch(new RegExp(`CREATE TEMP TABLE ${t} ON COMMIT DROP AS`));
    }
    expect(CODE.match(/CREATE TEMP TABLE/g)).toHaveLength(3);
    // supabase-db has 64 MB /dev/shm; without this the DISTINCT plan is a 2-worker Gather Merge.
    expect(CODE).toMatch(/SET LOCAL max_parallel_workers_per_gather = 0;/);
    expect(CODE).toMatch(/SET LOCAL statement_timeout = '300s';/);
  });
});

describe("ops/denue-refresh.sh area_geo_rekey post-step", () => {
  it("runs the script through the ON_ERROR_STOP psql array", () => {
    expect(SH).toMatch(
      /step_area_geo_rekey\(\) \{ "\$\{PSQL\[@\]\}" -f - < "\$REPO\/scripts\/rekey-stray-area-geo\.sql"; \}/,
    );
    expect(SH).toMatch(/PSQL=\(docker exec -i supabase-db psql [^)]*-v ON_ERROR_STOP=1\)/);
  });

  it("registers it after ageb_backfill and before vacuum", () => {
    const ageb = SH.indexOf("post_step ageb_backfill");
    const rekey = SH.indexOf("post_step area_geo_rekey step_area_geo_rekey");
    const vacuum = SH.indexOf("post_step vacuum");
    expect(ageb).toBeGreaterThan(-1);
    expect(rekey).toBeGreaterThan(ageb);
    expect(vacuum).toBeGreaterThan(rekey);
  });
});
