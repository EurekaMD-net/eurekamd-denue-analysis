import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Audit #120 #121 #123 #125 #135 #141: index hygiene migration plus the
// DDL sources that must stop re-creating the dropped indexes.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

const MIGRATION = read("scripts/migrations/020-indexes.sql");
/** The migration without `--` comment lines. */
const SQL = MIGRATION.split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");

const DROPPED = [
  "idx_estab_entidad",
  "idx_mv_dmy_cve_mun_ano",
  "idx_mv_mmy_cve_mun_ano",
  "idx_mv_dmy_cve_mun",
  "idx_mv_mmy_cve_mun",
  "idx_mv_sgm_scian",
  "idx_censo_ageb_raw_cvegeo",
  "idx_estab_nombre",
];

describe("020-indexes.sql", () => {
  it("runs autocommit: no BEGIN/COMMIT around the CONCURRENTLY statements", () => {
    expect(SQL).not.toMatch(/\bBEGIN\s*;/);
    expect(SQL).not.toMatch(/\bCOMMIT\s*;/);
    expect(SQL).toContain("\\set ON_ERROR_STOP on");
  });

  it("builds a UNIQUE cvegeo index on all four polygon tables after a duplicate guard (#120)", () => {
    const guard = SQL.indexOf("duplicate or NULL cvegeo rows");
    expect(guard).toBeGreaterThan(-1);
    for (const t of ["ageb", "mun", "loc", "ent"]) {
      const at = SQL.indexOf(
        `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${t}_polygons_cvegeo_uq\n  ON public.${t}_polygons (cvegeo);`,
      );
      expect(at, t).toBeGreaterThan(guard);
    }
  });

  it("builds the covering entidad index and the ce2024 rollup index (#121 #135 #123)", () => {
    expect(SQL).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_estab_ent_mun_cov\n  ON public.establecimientos (entidad, area_geo)\n  INCLUDE (clase_actividad_id, sector_actividad_id);",
    );
    expect(SQL).toContain(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ce2024_mun_ent_rollup\n  ON public.ce2024_municipal (cve_ent)\n  WHERE sector IS NULL AND id_estrato IS NULL;",
    );
  });

  it("drops each redundant index concurrently, one per statement, only after the validity guard", () => {
    const guard = SQL.indexOf("is missing or INVALID");
    expect(guard).toBeGreaterThan(SQL.indexOf("idx_ce2024_mun_ent_rollup\n"));
    expect(guard).toBeGreaterThan(SQL.indexOf("idx_estab_ent_mun_cov\n"));
    for (const i of DROPPED) {
      const at = SQL.indexOf(`DROP INDEX CONCURRENTLY IF EXISTS public.${i};`);
      expect(at, i).toBeGreaterThan(guard);
    }
    // Every DROP is CONCURRENTLY and names a single index.
    for (const m of SQL.matchAll(/^DROP INDEX[^;]*;/gm)) {
      expect(m[0]).toMatch(/^DROP INDEX CONCURRENTLY IF EXISTS public\.[a-z_0-9]+;$/);
    }
  });

  it("the validity guard covers every index the migration builds", () => {
    const built = [...SQL.matchAll(/CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS ([a-z_0-9]+)/g)].map(
      (m) => m[1]!,
    );
    expect(built).toHaveLength(6);
    const guardBlock = SQL.slice(SQL.lastIndexOf("DO $$", SQL.indexOf("is missing or INVALID")));
    for (const i of built) expect(guardBlock, i).toContain(`'${i}'`);
  });

  it("refuses to drop idx_estab_nombre unless 009's idx_estab_nombre_trgm exists and is VALID", () => {
    const guardStart = SQL.lastIndexOf("DO $$", SQL.indexOf("is missing or INVALID"));
    const guardEnd = SQL.indexOf("END $$;", guardStart);
    const guard = SQL.slice(guardStart, guardEnd);
    expect(guard).toMatch(
      /x\.indexrelid = to_regclass\('public\.idx_estab_nombre_trgm'\)\s+AND x\.indisvalid\s+\) THEN\s+RAISE EXCEPTION/,
    );
    expect(guardEnd).toBeLessThan(SQL.indexOf("DROP INDEX CONCURRENTLY IF EXISTS public.idx_estab_nombre;"));
  });

  it("ends with VACUUM (ANALYZE) establecimientos so index-only scans skip the heap", () => {
    expect(SQL.trimEnd().endsWith("VACUUM (ANALYZE) public.establecimientos;")).toBe(true);
  });
});

describe("DDL sources stop re-creating the dropped indexes (#125 #141)", () => {
  it("perf-matviews.sql no longer creates the prefix-redundant MV indexes", () => {
    const pm = read("scripts/perf-matviews.sql");
    expect(pm).not.toMatch(/CREATE INDEX\s+idx_mv_dmy_cve_mun\s/);
    expect(pm).not.toMatch(/CREATE INDEX\s+idx_mv_mmy_cve_mun\s/);
    expect(pm).not.toMatch(/CREATE INDEX\s+idx_mv_sgm_scian\s/);
    // The unique keys REFRESH CONCURRENTLY needs stay.
    expect(pm).toContain("idx_mv_dmy_unique ON mv_delitos_municipal_yearly(cve_mun, ano)");
    expect(pm).toContain("idx_mv_mmy_unique ON mv_mortalidad_municipal_yearly(cve_mun, ano)");
    expect(pm).toMatch(/idx_mv_sgm_scian_irs\s+ON mv_sector_grade_matrix\(scian, irs_grado\)/);
  });

  it("schema.sql declares the covering index instead of idx_estab_entidad and drops idx_estab_nombre", () => {
    const schema = read("src/db/schema.sql");
    expect(schema).not.toMatch(/INDEX IF NOT EXISTS idx_estab_entidad\b/);
    expect(schema).not.toMatch(/INDEX IF NOT EXISTS idx_estab_nombre\b/);
    expect(schema).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_estab_ent_mun_cov\s+ON establecimientos\(entidad, area_geo\)\s+INCLUDE \(clase_actividad_id, sector_actividad_id\);/,
    );
  });
});
