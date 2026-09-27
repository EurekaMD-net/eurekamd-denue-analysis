import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 021 must scan establecimientos once per MV: WITH NO DATA, then one plain
// REFRESH (CONCURRENTLY needs a populated MV). refresh-matviews.sh later
// refreshes both CONCURRENTLY, which needs the unique index 021 creates.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

/** The migration without `--` comment lines. */
const SQL = read("scripts/migrations/021-summary-mvs.sql")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("--"))
  .join("\n");
const REFRESH_SH = read("scripts/refresh-matviews.sh");

describe("021-summary-mvs.sql", () => {
  for (const [mv, pk] of [
    ["mv_sector_summary", "mv_sector_summary_pk"],
    ["mv_estrato_por_entidad", "mv_estrato_por_entidad_pk"],
  ] as const) {
    it(`${mv}: created WITH NO DATA, unique index, then exactly one plain REFRESH`, () => {
      const create = SQL.indexOf(`CREATE MATERIALIZED VIEW IF NOT EXISTS ${mv} AS`);
      expect(create).toBeGreaterThan(-1);
      const body = SQL.slice(create, SQL.indexOf(";", create));
      expect(body.trimEnd().endsWith("WITH NO DATA")).toBe(true);

      const index = SQL.indexOf(`CREATE UNIQUE INDEX IF NOT EXISTS ${pk}\n  ON ${mv} (`);
      const refreshes = [...SQL.matchAll(new RegExp(`REFRESH MATERIALIZED VIEW[^;]*\\b${mv};`, "g"))];
      expect(refreshes).toHaveLength(1);
      expect(refreshes[0]![0]).toBe(`REFRESH MATERIALIZED VIEW ${mv};`);
      expect(index).toBeGreaterThan(create);
      expect(refreshes[0]!.index).toBeGreaterThan(index);
    });

    it(`refresh-matviews.sh refreshes ${mv} CONCURRENTLY (backed by 021's unique index)`, () => {
      expect(REFRESH_SH).toContain(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${mv};`);
    });
  }
});
