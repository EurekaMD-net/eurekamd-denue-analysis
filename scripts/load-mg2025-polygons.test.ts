import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGEB_RURAL_9,
  AGEB_URBANA_13,
  DEFAULT_ZIP,
  LAYERS,
  LAYER_ORDER,
  MG2025_ZIP_SHA256,
  NEW_MUN_KEYS_2025,
  PgdumpFilter,
  assertOverwriteAllowed,
  assertionSql,
  grantAndCommentStatements,
  ledgerCommand,
  ogr2ogrArgs,
  parseArgs,
  postStepsSql,
  preludeSql,
  splitLines,
  type LayerSpec,
} from "./load-mg2025-polygons.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");

const ZIP = "/data/raw/mg2025/794551163061_s.zip";
const MUN = LAYERS.mun;
const AGEB = LAYERS.ageb;

describe("parseArgs", () => {
  it("defaults to both layers, mun first, and the repo zip", () => {
    const a = parseArgs([], "/repo");
    expect(a.layers.map((s) => s.table)).toEqual(["mun_polygons_2025", "ageb_polygons_2025"]);
    expect(a.zip).toBe(`/repo/${DEFAULT_ZIP}`);
    expect(a.dryRun).toBe(false);
    expect(a.force).toBe(false);
  });

  it("selects layers and keeps the fixed order", () => {
    expect(parseArgs(["--layers=ageb"]).layers.map((s) => s.layer)).toEqual(["ageb"]);
    expect(parseArgs(["--layers=mun"]).layers.map((s) => s.layer)).toEqual(["mun"]);
    expect(parseArgs(["--layers=ageb,mun"]).layers.map((s) => s.layer)).toEqual(["mun", "ageb"]);
  });

  it("parses --zip, --dry-run and --force", () => {
    const a = parseArgs([`--zip=${ZIP}`, "--dry-run", "--force"]);
    expect(a).toMatchObject({ zip: ZIP, dryRun: true, force: true });
  });

  it("rejects unknown layers, unknown flags, an empty layer list and a flag-like zip", () => {
    expect(() => parseArgs(["--layers=ent"])).toThrow(/unknown layer "ent"/);
    expect(() => parseArgs(["--overwrite"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--layers=,"])).toThrow(/empty/);
    expect(() => parseArgs(["--zip=-x"])).toThrow(/--zip inválido/);
  });
});

describe("ogr2ogr invocation", () => {
  it("dumps the national layer from the nested zip as COPY, reprojected, no DROP", () => {
    const args = ogr2ogrArgs(ZIP, MUN);
    expect(args).toContain(
      `/vsizip//vsizip/${ZIP}/mg_2025_integrado.zip/conjunto_de_datos/00mun.shp`,
    );
    const joined = args.join(" ");
    for (const frag of [
      "--config PG_USE_COPY YES",
      "-f PGDUMP /vsistdout/",
      "-nln mun_polygons_2025",
      "-lco SCHEMA=public",
      "-lco GEOMETRY_NAME=geom",
      "-lco FID=ogc_fid",
      "-lco SPATIAL_INDEX=GIST",
      "-lco CREATE_SCHEMA=OFF",
      "-lco DROP_TABLE=OFF",
      "-nlt PROMOTE_TO_MULTI",
      "-t_srs EPSG:4326",
    ]) {
      expect(joined).toContain(frag);
    }
    expect(joined).not.toMatch(/-overwrite|-append/);
    expect(ogr2ogrArgs(ZIP, AGEB)).toContain("ageb_polygons_2025");
    expect(ogr2ogrArgs(ZIP, AGEB).join(" ")).toContain("conjunto_de_datos/00a.shp");
  });
});

describe("prelude: transaction and overwrite guard", () => {
  it("opens the transaction, bounds it and refuses an existing table without --force", () => {
    const sql = preludeSql([MUN, AGEB], false);
    expect(sql.startsWith("SET client_encoding = 'UTF8';\nBEGIN;\n")).toBe(true);
    expect(sql).not.toMatch(/COMMIT/);
    expect(sql).toContain("SET LOCAL max_parallel_maintenance_workers = 0;");
    for (const t of ["mun_polygons_2025", "ageb_polygons_2025"]) {
      expect(sql).toContain(
        `IF to_regclass('public.${t}') IS NOT NULL THEN RAISE EXCEPTION 'public.${t} already exists; re-run with --force to replace it';`,
      );
    }
    expect(sql).not.toMatch(/DROP/);
  });

  it("with --force drops only the 2025 tables, without CASCADE", () => {
    const sql = preludeSql([MUN, AGEB], true);
    expect(sql).toContain("DROP TABLE IF EXISTS public.mun_polygons_2025;");
    expect(sql).toContain("DROP TABLE IF EXISTS public.ageb_polygons_2025;");
    expect(sql).not.toMatch(/CASCADE/i);
    expect(sql).not.toMatch(/\b(mun|ageb)_polygons\b(?!_2025)/);
  });

  it("assertOverwriteAllowed refuses an existing table unless forced", () => {
    expect(() => assertOverwriteAllowed(["mun_polygons_2025"], false, "supabase-db")).toThrow(
      /mun_polygons_2025 already exist\(s\) in supabase-db; re-run with --force/,
    );
    expect(() => assertOverwriteAllowed(["mun_polygons_2025"], true, "supabase-db")).not.toThrow();
    expect(() => assertOverwriteAllowed([], false, "supabase-db")).not.toThrow();
  });
});

describe("post-load steps", () => {
  it("repairs with migration 019's expression, indexes, analyzes, then asserts", () => {
    const sql = postStepsSql(MUN);
    const repair = "SET geom = ST_Multi(ST_CollectionExtract(ST_MakeValid(geom), 3))\nWHERE NOT ST_IsValid(geom);";
    expect(read("scripts/migrations/019-censo-views-treemap-geoms.sql")).toContain(repair);
    const order = [
      "geometries invalid before repair",
      `UPDATE public.mun_polygons_2025\n${repair}`,
      "CREATE UNIQUE INDEX mun_polygons_2025_cvegeo_uq ON public.mun_polygons_2025 (cvegeo);",
      "ANALYZE public.mun_polygons_2025;",
      "ALTER TABLE public.mun_polygons_2025 OWNER TO postgres;",
      "GRANT SELECT ON public.mun_polygons_2025 TO denue_api;",
      "COMMENT ON TABLE public.mun_polygons_2025 IS",
      "RAISE NOTICE 'mun_polygons_2025: OK",
    ].map((s) => sql.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(sql).not.toContain("_ent_mun");
  });

  it("gives the AGEB table its (cve_ent, cve_mun) index", () => {
    expect(postStepsSql(AGEB)).toContain(
      "CREATE INDEX idx_ageb_polygons_2025_ent_mun ON public.ageb_polygons_2025 (cve_ent, cve_mun);",
    );
  });

  it("strips the default ACL from table and sequence, keeps Sage out, grants the API", () => {
    for (const s of [MUN, AGEB]) {
      const t = s.table;
      expect(grantAndCommentStatements(s)).toEqual([
        `ALTER TABLE public.${t} OWNER TO postgres;`,
        `REVOKE ALL ON public.${t} FROM anon, authenticated, trustr_app;`,
        `REVOKE ALL ON SEQUENCE public.${t}_ogc_fid_seq FROM anon, authenticated, trustr_app;`,
        `REVOKE ALL ON public.${t} FROM denue_sage;`,
        `GRANT SELECT ON public.${t} TO denue_api;`,
        expect.stringMatching(new RegExp(`^COMMENT ON TABLE public\\.${t} IS '.*';$`)),
      ]);
    }
  });

  it("comments the edition, UPC and zip sha256", () => {
    const c = grantAndCommentStatements(MUN).at(-1)!;
    expect(c).toContain("MG 2025");
    expect(c).toContain("UPC 794551163061");
    expect(c).toContain(`sha256 ${MG2025_ZIP_SHA256}`);
  });
});

describe("in-transaction assertions", () => {
  it("mun: 2,478 rows / keys / 0 NULL, geometry, EXCEPT = the 9 keys, reverse 0, encoding", () => {
    const sql = assertionSql(MUN);
    expect(sql).toContain("IF n <> 2478 OR d <> 2478 OR nulls <> 0 THEN");
    expect(sql).toContain("GeometryType(geom) <> 'MULTIPOLYGON'");
    expect(sql).toContain("ST_SRID(geom) <> 4326");
    expect(sql).toContain("IF badtype <> 0 OR badsrid <> 0 OR invalid <> 0 THEN");
    expect(sql).toContain("IF Find_SRID('public', 'mun_polygons_2025', 'geom') <> 4326 THEN");
    expect(sql).toContain(
      "IF extra IS DISTINCT FROM ARRAY['02007','04013','12082','12083','12084','12085','24059','25019','25020']::text[] THEN",
    );
    expect(sql).toContain("EXCEPT SELECT cvegeo::text FROM public.mun_polygons) s;");
    expect(sql).toContain("EXCEPT SELECT cvegeo::text FROM public.mun_polygons_2025) s;");
    expect(sql).toContain("IF gone <> 0 THEN");
    expect(sql).toContain("WHERE cvegeo = '04013' AND nomgeo = 'Dzitbalché'");
    expect(sql).toContain("WHERE cvegeo = '12083' AND nomgeo = 'Ñuu Savi'");
  });

  it("ageb: 82,283 rows / keys / 0 NULL, Urbana 13-char and Rural 9-char splits", () => {
    const sql = assertionSql(AGEB);
    expect(sql).toContain("IF n <> 82283 OR d <> 82283 OR nulls <> 0 THEN");
    expect(sql).toContain("count(*) FILTER (WHERE ambito = 'Urbana' AND length(cvegeo) = 13)");
    expect(sql).toContain("count(*) FILTER (WHERE ambito = 'Rural' AND length(cvegeo) = 9)");
    expect(sql).toContain(`IF urb <> ${AGEB_URBANA_13} OR rur <> ${AGEB_RURAL_9} THEN`);
    expect(AGEB_URBANA_13 + AGEB_RURAL_9).toBe(AGEB.expectedRows);
    expect(sql).not.toContain("mun_polygons");
  });

  it("the 9 new keys are exactly migration 027's bridge children", () => {
    const sql = read("scripts/migrations/027-municipio-bridge-2025.sql");
    const children = new Set(
      [...sql.matchAll(/\('(\d{5})', '[^']+', +'\d{5}', '[^']+', +'\d{4}-\d{2}-\d{2}'\)/g)].map((m) => m[1]!),
    );
    expect([...children].sort()).toEqual([...NEW_MUN_KEYS_2025]);
  });
});

describe("migration 028 mirrors the loader's grants and comments", () => {
  const MIGRATION = read("scripts/migrations/028-mg2025-polygons-grants.sql");
  const lines = new Set(MIGRATION.split("\n").map((l) => l.trim()));

  it("carries every grant/revoke/comment statement verbatim", () => {
    for (const l of LAYER_ORDER) {
      for (const st of grantAndCommentStatements(LAYERS[l])) expect(lines.has(st), st).toBe(true);
    }
  });

  it("names exactly the loader's tables, each behind a to_regclass guard", () => {
    const rels = new Set([...MIGRATION.matchAll(/\b([a-z_]+_polygons_2025)\b/g)].map((m) => m[1]!));
    expect([...rels].sort()).toEqual(LAYER_ORDER.map((l) => LAYERS[l].table).sort());
    for (const r of rels) expect(MIGRATION).toContain(`IF to_regclass('public.${r}') IS NOT NULL THEN`);
  });

  it("carries only privileges and comments (no DDL, no data changes)", () => {
    const body = MIGRATION.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
    expect(body).not.toMatch(/\b(CREATE|DROP|UPDATE|DELETE|INSERT|TRUNCATE)\b/);
  });
});

describe("allowlists outside the loader", () => {
  it("sage-role.sql revokes both 2025 tables from denue_sage, guarded", () => {
    const sql = read("scripts/sage-role.sql");
    for (const t of ["ageb_polygons_2025", "mun_polygons_2025"]) {
      expect(sql).toContain(`IF to_regclass('public.${t}') IS NOT NULL THEN\n    REVOKE ALL ON ${t} FROM denue_sage;`);
      expect(sql).not.toMatch(new RegExp(`GRANT[^;]*\\b${t}\\b`));
    }
  });

  it("the deploy audit's leaked-grants check covers the 2025 tables", () => {
    const sh = read("ops/deploy-audit-refactor.sh");
    const line = sh.split("\n").find((l) => l.includes("P02 leaked grants"))!;
    expect(line).toContain("'ageb_polygons_2025','mun_polygons_2025'");
  });
});

describe("ledgerCommand", () => {
  it("records MG 2025 with the zip sha256 and the row total", () => {
    const cmd = ledgerCommand(2478 + 82283);
    expect(cmd).toContain('--dataset=marco_geoestadistico --edition="MG 2025"');
    expect(cmd).toContain(`sha256 ${MG2025_ZIP_SHA256}`);
    expect(cmd).toContain("--rows=84761");
    expect(cmd.endsWith("--apply")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stream filter
// ---------------------------------------------------------------------------

const b = (s: string): Buffer => Buffer.from(s, "utf-8");
const SPEC2: LayerSpec = { ...MUN, expectedRows: 2 };

function dump(rows: string[], extra: string[] = []): string[] {
  return [
    "SET standard_conforming_strings = ON;",
    "BEGIN;",
    'CREATE TABLE "public"."mun_polygons_2025"();',
    'ALTER TABLE "public"."mun_polygons_2025" ADD COLUMN "ogc_fid" SERIAL CONSTRAINT "mun_polygons_2025_pk" PRIMARY KEY;',
    "SELECT AddGeometryColumn('public','mun_polygons_2025','geom',4326,'MULTIPOLYGON',2);",
    'ALTER TABLE "public"."mun_polygons_2025" ADD COLUMN "cvegeo" VARCHAR(5);',
    'ALTER TABLE "public"."mun_polygons_2025" ADD COLUMN "nomgeo" VARCHAR(80);',
    ...extra,
    'COPY "public"."mun_polygons_2025" ("geom", "cvegeo", "cve_ent", "cve_mun", "nomgeo") FROM STDIN;',
    ...rows,
    "\\.",
    'CREATE INDEX "mun_polygons_2025_geom_geom_idx" ON "public"."mun_polygons_2025" USING GIST ("geom");',
    "COMMIT;",
  ];
}

const ROWS = ["0106AA\t04013\t04\t013\tDzitbalché", "0106BB\t12083\t12\t083\tÑuu Savi"];

function run(spec: LayerSpec, lines: string[]): { out: string[]; filter: PgdumpFilter } {
  const filter = new PgdumpFilter(spec);
  const out: string[] = [];
  for (const l of lines) {
    const r = filter.push(b(l));
    if (r !== null) out.push(r.toString("utf-8"));
  }
  return { out, filter };
}

describe("PgdumpFilter", () => {
  it("drops the dump's BEGIN/COMMIT, passes COPY data, reports columns and probes", () => {
    const { out, filter } = run(SPEC2, dump(ROWS));
    expect(out).not.toContain("BEGIN;");
    expect(out).not.toContain("COMMIT;");
    expect(out).toContain(ROWS[0]);
    expect(out).toContain("\\.");
    const r = filter.finish();
    expect(r.rows).toBe(2);
    expect(r.columns).toEqual([
      'ogc_fid SERIAL CONSTRAINT "mun_polygons_2025_pk" PRIMARY KEY',
      "geom geometry(MULTIPOLYGON,4326)",
      "cvegeo VARCHAR(5)",
      "nomgeo VARCHAR(80)",
    ]);
    expect(r.probesFound.sort()).toEqual(["04013 Dzitbalché", "12083 Ñuu Savi"]);
  });

  it("refuses destructive statements and statements on any other table", () => {
    expect(() => run(SPEC2, dump(ROWS, ['DROP TABLE "public"."mun_polygons_2025";']))).toThrow(/destructive/);
    expect(() => run(SPEC2, dump(ROWS, ['CREATE INDEX "x" ON "public"."mun_polygons" (cvegeo);']))).toThrow(
      /does not target mun_polygons_2025/,
    );
  });

  it("refuses a second statement smuggled onto a dump line", () => {
    const line = 'ALTER TABLE "public"."mun_polygons_2025" ADD COLUMN "x" VARCHAR(1); DROP TABLE mun_polygons;';
    expect(() => run(SPEC2, dump(ROWS, [line]))).toThrow(/exactly one statement ending the line/);
    expect(() => run(SPEC2, dump(ROWS, ['COMMENT ON TABLE "public"."mun_polygons_2025" IS NULL']))).toThrow(
      /exactly one statement/,
    );
  });

  it("refuses statement shapes the dump never produces, even on the target table", () => {
    for (const line of [
      'GRANT ALL ON "public"."mun_polygons_2025" TO anon;',
      'UPDATE "public"."mun_polygons_2025" SET cvegeo = NULL;',
      "SET ROLE supabase_admin; -- \"public\".\"mun_polygons_2025\"",
      'INSERT INTO "public"."mun_polygons_2025" (cvegeo) VALUES (\'x\');',
    ]) {
      expect(() => run(SPEC2, dump(ROWS, [line])), line).toThrow(/unexpected statement shape|exactly one statement/);
    }
    expect(() => run(SPEC2, ["\\.", ...dump(ROWS)])).toThrow(/exactly one statement|unexpected statement shape/);
  });

  it("does not treat COPY data as SQL", () => {
    const { filter } = run(SPEC2, dump(["BEGIN;\tDROP", ROWS[1]!]));
    // A data row is never inspected as a statement; the probe for 04013 is then missing.
    expect(() => filter.finish()).toThrow(/encoding probes not found in COPY data: 04013 Dzitbalché/);
  });

  it("fails a dump with the wrong row count, no COMMIT, or an unterminated COPY", () => {
    expect(() => run({ ...MUN, expectedRows: 3 }, dump(ROWS)).filter.finish()).toThrow(/2 COPY rows, expected 3/);
    expect(() => run(SPEC2, dump(ROWS).slice(0, -1)).filter.finish()).toThrow(/one BEGIN;\/COMMIT; pair, got 1\/0/);
    const cut = dump(ROWS).slice(0, dump(ROWS).indexOf("\\."));
    expect(() => run(SPEC2, cut).filter.finish()).toThrow(/stream ended inside COPY/);
  });

  it("fails when the encoding mangled the probe names", () => {
    const mangled = ["0106AA\t04013\t04\t013\tDzitbalchÃ©", ROWS[1]!];
    expect(() => run(SPEC2, dump(mangled)).filter.finish()).toThrow(/04013 Dzitbalché/);
  });

  it("does not probe the AGEB layer", () => {
    const lines = dump(["0106AA\t01\t001\t0001\t0010\t0100100010010\tUrbana"]).map((l) =>
      l.replaceAll("mun_polygons_2025", "ageb_polygons_2025"),
    );
    expect(run({ ...AGEB, expectedRows: 1 }, lines).filter.finish().probesFound).toEqual([]);
  });
});

describe("splitLines", () => {
  async function collect(chunks: string[]): Promise<string[]> {
    async function* src(): AsyncGenerator<Buffer> {
      for (const c of chunks) yield b(c);
    }
    const out: string[] = [];
    for await (const l of splitLines(src())) out.push(l.toString("utf-8"));
    return out;
  }

  it("rejoins lines split across chunks, multibyte characters included", async () => {
    const full = b("a\nDzitbalché\nlast");
    const cut = full.indexOf(0xc3) + 1; // split inside the two-byte é
    async function* src(): AsyncGenerator<Buffer> {
      yield full.subarray(0, 3);
      yield full.subarray(3, cut);
      yield full.subarray(cut);
    }
    const out: string[] = [];
    for await (const l of splitLines(src())) out.push(l.toString("utf-8"));
    expect(out).toEqual(["a", "Dzitbalché", "last"]);
  });

  it("keeps empty lines and drops nothing after a trailing newline", async () => {
    expect(await collect(["x\n\n", "y\n"])).toEqual(["x", "", "y"]);
  });
});
