import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EIC_VIEWS } from "./_psql-tx.js";
import {
  API_ROLE_LINE,
  CONTAINER_CSV,
  DEFAULT_ZIP,
  EIC2025_HEADER,
  EIC2025_ZIP_SHA256,
  EXPECTED,
  IDENTITY_COLUMNS,
  LEDGER_LINE,
  LOADED_RELATIONS,
  NEW_KEYS_POBTOT,
  REPO_ROOT,
  assertDecoded,
  assertHeader,
  assertSafePath,
  assertionSql,
  buildReloadSql,
  dictionaryMnemonics,
  dropViewsSql,
  eicViewsSql,
  parseArgs,
  parseCsv,
  sourceStats,
  sqlColumnNames,
} from "./load-eic2025.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf-8");
const stripComments = (sql: string): string =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

const RAW = "eic_2025_municipio_raw";

describe("EIC2025_HEADER", () => {
  it("pins 349 unique names: 8 identity columns first, PCN_VPH_ESCRIDES last", () => {
    expect(EIC2025_HEADER).toHaveLength(349);
    expect(new Set(EIC2025_HEADER).size).toBe(349);
    expect(EIC2025_HEADER.slice(0, 8)).toEqual([
      "CVEGEO", "CVE_ENT", "NOM_ENT", "CVE_MUN", "NOM_MUN", "CVE_LOC", "NOM_LOC", "ESTIMADOR",
    ]);
    expect(IDENTITY_COLUMNS).toBe(8);
    expect(EIC2025_HEADER[8]).toBe("POBTOT");
    expect(EIC2025_HEADER[EIC2025_HEADER.length - 1]).toBe("PCN_VPH_ESCRIDES");
    // INEGI quirks kept verbatim.
    expect(EIC2025_HEADER).toContain("PNC_P6A14AN");
    expect(EIC2025_HEADER).toContain("PCN_PcSSyRecAc");
  });

  it("lower-cases to safe identifiers (load-censo regex) and renames CVE_MUN to mun", () => {
    const cols = sqlColumnNames();
    for (const c of cols) expect(c).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(new Set(cols).size).toBe(349);
    expect(cols[3]).toBe("mun");
    expect(cols).not.toContain("cve_mun");
    expect(cols).toContain("pcn_pcssyrecac");
  });

  it("assertHeader accepts the pin and rejects a renamed, dropped or extra column", () => {
    expect(() => assertHeader([...EIC2025_HEADER])).not.toThrow();
    const renamed = [...EIC2025_HEADER] as string[];
    renamed[10] = "POBMAS2";
    expect(() => assertHeader(renamed)).toThrow(/#11 "POBMAS2" != "POBMAS"/);
    expect(() => assertHeader(EIC2025_HEADER.slice(1))).toThrow(/348 columns, expected 349/);
    expect(() => assertHeader([...EIC2025_HEADER, "X"])).toThrow(/350 columns/);
  });

  it("sqlColumnNames refuses an unsafe name", () => {
    expect(() => sqlColumnNames(["CVEGEO", "a;DROP"])).toThrow(/unsafe column name/);
  });
});

describe("parseArgs", () => {
  it("defaults to a dry run on the repo-root zip", () => {
    const a = parseArgs([], "/elsewhere");
    expect(a.zip).toBe(join(REPO_ROOT, DEFAULT_ZIP));
    expect(DEFAULT_ZIP).toBe("raw/eic2025/conjunto_de_datos_eic2025_105_csv.zip");
    expect(a.apply).toBe(false);
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
  });

  it("accepts an absolute --zip and resolves a relative one against the cwd", () => {
    expect(parseArgs(["--zip=/data/e.zip", "--apply"])).toEqual({ zip: "/data/e.zip", apply: true });
    expect(parseArgs(["--zip=raw/e.zip"], "/repo").zip).toBe("/repo/raw/e.zip");
  });

  it("rejects unknown flags, --apply with --dry-run, and a flag-like --zip", () => {
    expect(() => parseArgs(["--force"])).toThrow(/unknown argument/);
    expect(() => parseArgs(["--apply", "--dry-run"])).toThrow(/exclusive/);
    expect(() => parseArgs(["--zip=-rf"])).toThrow(/--zip inválido/);
    expect(() => parseArgs(["--zip="])).toThrow(/--zip inválido/);
  });

  it("assertSafePath wants an absolute path that cannot read as a flag", () => {
    expect(() => assertSafePath("zip", "/a/b.zip")).not.toThrow();
    for (const p of ["", "-x", "rel/b.zip", "/a\nb"]) expect(() => assertSafePath("zip", p)).toThrow();
  });

  it("pins the zip sha256 from raw/eic2025/SHA256SUMS", () => {
    expect(EIC2025_ZIP_SHA256).toBe("e6ad7e8f8661f414face015e50e8d95652ab07442e912c76191eefd77defa182");
  });
});

describe("decode guards", () => {
  it("rejects U+FFFD and a missing 'Error estándar' (double-decoded UTF-8)", () => {
    expect(() => assertDecoded("a,Error estándar\n")).not.toThrow();
    expect(() => assertDecoded("a,Error est�ndar\n")).toThrow(/U\+FFFD/);
    expect(() => assertDecoded("a,Error estÃ¡ndar\n")).toThrow(/not found after decoding/);
  });
});

describe("parseCsv / dictionaryMnemonics", () => {
  it("handles a quoted comma, doubled quotes and CRLF", () => {
    expect(parseCsv('a,"b, c",d\r\n"x""y",2,3\n')).toEqual([
      ["a", "b, c", "d"],
      ['x"y', "2", "3"],
    ]);
  });

  it("keeps only numbered dictionary rows, mnemonic = 4th field", () => {
    const dict = [
      "DESCRIPTOR,,,,,",
      "Cons.,Indicador,Descripción,Mnemónico,Rangos,Long.",
      "IDENTIFICACIÓN GEOGRÁFICA,,,,,",
      '1,Clave,"Texto, con coma",CVEGEO,0…9,9',
      "2,Entidad,Código,CVE_ENT,00…32,2",
      ",,,,,",
    ].join("\n");
    expect(dictionaryMnemonics(dict)).toEqual(["CVEGEO", "CVE_ENT"]);
  });
});

describe("sourceStats", () => {
  const row = (cvegeo: string, nom: string, est: string, pob: string): string[] => {
    const r: string[] = Array.from({ length: 349 }, () => "1");
    r[0] = cvegeo;
    r[1] = cvegeo.slice(0, 2);
    r[2] = "Ent";
    r[3] = cvegeo.slice(2, 5);
    r[4] = nom;
    r[5] = cvegeo.slice(5);
    r[6] = "Total";
    r[7] = est;
    r[8] = pob;
    return r;
  };

  it("counts municipio Valor rows, suffixes, sentinels and the national total", () => {
    const s = sourceStats([
      row("000000000", "Total nacional", "Valor", "30"),
      row("120000000", "Guerrero", "Valor", "30"),
      row("120010000", "Acapulco", "Valor", "20"),
      row("120010000", "Acapulco", "Error estándar", "2.5"),
      row("120830000", "Ñuu Savi*", "Valor", "10"),
      row("071250000", "X**", "Valor", "MI"),
      row("129970000", "Menores", "Valor", "5"),
      row("120010001", "Acapulco", "Valor", "NA"),
    ]);
    expect(s.rows).toBe(8);
    expect(s.municipioValor).toBe(3);
    expect(s.municipioRows).toBe(4);
    expect(s.pobtotSum).toBe(30);
    expect(s.pobtotNational).toBe(30);
    expect(s.pobtotNull).toBe(1);
    expect(s.enumeracionCompleta).toBe(1);
    expect(s.muestraInsuficiente).toBe(1);
    expect(s.mi).toBe(1);
    expect(s.na).toBe(1);
    expect(s.byKey.get("12083")).toBe(10);
  });

  it("refuses ragged rows and values that are neither numeric nor MI/NA", () => {
    expect(() => sourceStats([["a", "b"]])).toThrow(/2 fields, expected 349/);
    expect(() => sourceStats([row("120010000", "A", "Valor", "1,5")])).toThrow(/neither numeric nor MI\/NA/);
    expect(() => sourceStats([row("120010000", "A", "Valor", "-")])).toThrow(/POBTOT = "-"/);
  });
});

describe("migrate-eic2025-views.sql", () => {
  const sql = eicViewsSql();
  const body = stripComments(sql);

  it("defines exactly the three EIC_VIEWS", () => {
    const created = [...body.matchAll(/^CREATE OR REPLACE VIEW ([a-z0-9_]+) AS$/gm)].map((m) => m[1]);
    expect(created).toEqual([...EIC_VIEWS]);
  });

  it("reads only the raw table (and eic_2025_municipio), never municipios_2025 / the bridge / censo_*", () => {
    expect(sql).not.toMatch(/\b(municipios_2025|municipio_bridge_2025|censo_\w+)\b/);
    const refs = new Set([...body.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_]*)/g)].map((m) => m[1]));
    expect([...refs].sort()).toEqual(["eic_2025_municipio", RAW]);
  });

  it("has no BEGIN/COMMIT and no psql meta-commands (it runs inside the loader's transaction)", () => {
    expect(body).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\b/i);
    for (const l of sql.split("\n")) expect(l.trimStart().startsWith("\\")).toBe(false);
  });

  it("filters municipio rows and casts every indicator with the MI/NA NULLIF chain", () => {
    const cols = sqlColumnNames().slice(IDENTITY_COLUMNS);
    expect(cols).toHaveLength(341);
    const main = body.slice(body.indexOf("VIEW eic_2025_municipio AS"), body.indexOf("VIEW eic_2025_municipio_moe AS"));
    const moe = body.slice(body.indexOf("VIEW eic_2025_municipio_moe AS"), body.indexOf("VIEW eic_2025_municipio_censo_parity AS"));
    for (const view of [main, moe]) {
      for (const c of cols) {
        expect(view).toContain(`NULLIF(NULLIF(NULLIF(r.${c}, ''), 'MI'), 'NA')::numeric AS ${c},`.replace(/,$/, ""));
      }
      expect(view).toContain("AND r.cve_loc = '0000'");
      expect(view).toContain("AND r.mun NOT IN ('000', '997')");
    }
    expect(main).toContain("WHERE r.estimador = 'Valor'");
    expect(main).toContain("regexp_replace(r.nom_mun, '\\*+$', '') AS nom_mun");
    expect(main).toContain("(r.nom_mun ~ '(^|[^*])\\*$') AS enumeracion_completa");
    expect(main).toContain("(r.nom_mun ~ '\\*\\*$') AS muestra_insuficiente");
    for (const [est, code] of [
      ["Error estándar", "se"],
      ["Límite inferior de confianza", "li90"],
      ["Límite superior de confianza", "ls90"],
      ["Coeficiente de variación", "cv"],
    ]) {
      expect(moe).toContain(`WHEN '${est}' THEN '${code}'`);
    }
  });

  it("derives parity absolutes with the base INEGI publishes for each percentage", () => {
    const parity = body.slice(body.indexOf("VIEW eic_2025_municipio_censo_parity AS"));
    const expr = (col: string): string => {
      const m = new RegExp(`^  (.+) AS ${col},?$`, "m").exec(parity);
      expect(m, col).not.toBeNull();
      return m![1]!;
    };
    const vph = ["inter", "autom", "refri", "lavad", "hmicro", "moto", "bici", "radio", "tv", "pc", "telef", "cel"];
    for (const v of vph) expect(expr(`vph_${v}`)).toBe(`round(e.pcn_vph_${v} * e.vivparhab_c / 100)::bigint`);
    expect(expr("vph_stvp")).toBe("round(e.pcn_vph_tvp * e.vivparhab_c / 100)::bigint");
    for (const [col, pcn] of [["pder_imss", "pder_imss"], ["pder_iste", "pder_iste"], ["pder_imssb", "pder_imssb"], ["pafil_ipriv", "pafil_ipriv"], ["pder_segp", "pafil_ipub"]]) {
      expect(expr(col)).toBe(`round(e.pcn_${pcn} * e.pder_ss / 100)::bigint`);
    }
    for (const [col, pcn] of [["pea", "pea"], ["p12ym_solt", "p12ym_solt"], ["p12ym_casa", "p12ym_cul"], ["p12ym_sepa", "p12ym_sepa"]]) {
      expect(expr(col)).toBe(`round(e.pcn_${pcn} * e.p_12ymas / 100)::bigint`);
    }
    for (const col of ["p15ym_an", "p15ym_se"]) expect(expr(col)).toBe(`round(e.pcn_${col} * e.p_15ymas / 100)::bigint`);
    expect(expr("p3ym_hli")).toBe("round(e.pcn_p3ym_hli * e.p_3ymas / 100)::bigint");
    for (const col of ["p3hlinhe", "p3hli_he"]) {
      expect(expr(col)).toBe(`round(e.pcn_${col} * (e.pcn_p3ym_hli * e.p_3ymas / 100) / 100)::bigint`);
    }
    expect(expr("pres2020")).toBe("round(e.pcn_prese20 * e.p_5ymas / 100)::bigint");
    expect(expr("presoe20")).toBe("round(e.pcn_presoe20 * e.p_5ymas / 100)::bigint");
    for (const col of ["pob_afro", "pnacent", "pnacoe", "psinder"]) expect(expr(col)).toBe(`round(e.pcn_${col} * e.pobtot / 100)::bigint`);
    expect(expr("p_60ymas")).toBe("round((e.pcn_p_60a64 + e.pcn_p_65a69 + e.pcn_p_70a74 + e.pcn_p_75ymas) * e.pobtot / 100)::bigint");
    expect(expr("tvivhab")).toBe("round(e.vivparhab)::bigint");
    expect(parity).not.toMatch(/\bpres(oe)?(2015|15)\b/);
  });
});

describe("buildReloadSql", () => {
  const sql = buildReloadSql();
  const at = (s: string): number => {
    const i = sql.indexOf(s);
    expect(i, s).toBeGreaterThan(-1);
    return i;
  };

  it("runs staging -> \\copy -> explicit view drops -> swap -> keys -> views -> grants -> assertion, in order", () => {
    const order = [
      "SET client_encoding = 'UTF8';",
      `CREATE TABLE ${RAW}_staging (`,
      `\\copy ${RAW}_staging FROM '${CONTAINER_CSV}' WITH (FORMAT csv, HEADER true)\n`,
      "DROP VIEW IF EXISTS eic_2025_municipio_censo_parity;",
      "DROP VIEW IF EXISTS eic_2025_municipio_moe;",
      "DROP VIEW IF EXISTS eic_2025_municipio;",
      `DROP TABLE IF EXISTS ${RAW};`,
      `ALTER TABLE ${RAW}_staging RENAME TO ${RAW};`,
      `ALTER TABLE ${RAW} ADD COLUMN cve_mun TEXT GENERATED ALWAYS AS (cve_ent || mun) STORED;`,
      `ADD CONSTRAINT ${RAW}_cvegeo_estimador_key UNIQUE (cvegeo, estimador);`,
      `CREATE INDEX idx_${RAW}_cve_mun ON ${RAW} (cve_mun, estimador) WHERE cve_loc = '0000';`,
      "CREATE OR REPLACE VIEW eic_2025_municipio AS",
      "CREATE OR REPLACE VIEW eic_2025_municipio_censo_parity AS",
      `REVOKE ALL ON ${RAW} FROM anon, authenticated, trustr_app;`,
      "DO $$\nDECLARE",
    ];
    const idx = order.map(at);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  it("stages all 349 columns as TEXT with CVE_MUN renamed mun", () => {
    const ddl = sql.slice(at(`CREATE TABLE ${RAW}_staging (`), at("\\copy"));
    expect([...ddl.matchAll(/^ {2}"[a-z0-9_]+" TEXT,?$/gm)]).toHaveLength(349);
    expect(ddl).toContain('  "mun" TEXT,');
    expect(ddl).not.toContain('"cve_mun"');
  });

  it("never uses CASCADE, a NULL option or its own BEGIN/COMMIT (runPsqlScript owns the transaction)", () => {
    expect(stripComments(sql)).not.toMatch(/CASCADE/i);
    expect(sql).not.toMatch(/\\copy[^\n]*NULL/);
    expect(sql).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im);
  });

  it("drops the views child-first (parity reads eic_2025_municipio)", () => {
    expect(dropViewsSql()).toEqual([
      "DROP VIEW IF EXISTS eic_2025_municipio_censo_parity;",
      "DROP VIEW IF EXISTS eic_2025_municipio_moe;",
      "DROP VIEW IF EXISTS eic_2025_municipio;",
    ]);
  });

  it("restores the denue_sage SELECT on all four relations from sage-role.sql", () => {
    expect([...LOADED_RELATIONS]).toEqual([RAW, ...EIC_VIEWS]);
    for (const r of LOADED_RELATIONS) {
      expect(sql).toContain(`REVOKE ALL ON ${r} FROM anon, authenticated, trustr_app;`);
      expect(sql).toContain(`GRANT SELECT ON ${r} TO denue_sage;`);
    }
  });
});

describe("assertionSql", () => {
  const sql = assertionSql();

  it("pins the verified counts and totals", () => {
    expect(EXPECTED).toEqual({
      rawRows: 13880,
      municipios: 2478,
      moeRows: 9912,
      pobtotNational: 130393389,
      entidades: 32,
      acapulco12001: 767454,
      muestraInsuficiente: 7,
      enumeracionCompleta: 750,
    });
    expect(sql).toContain(`SELECT count(*) INTO n FROM ${RAW};\n  IF n <> 13880 THEN`);
    expect(sql).toContain("IF n <> 2478 OR d <> 2478 THEN");
    expect(sql).toContain("SELECT count(*), count(DISTINCT cve_mun) INTO n, d FROM eic_2025_municipio;");
    expect(sql).toContain("SELECT count(*) INTO n FROM eic_2025_municipio_moe;\n  IF n <> 9912 THEN");
    expect(sql).toContain("SELECT count(*) INTO n FROM eic_2025_municipio WHERE pobtot IS NULL;\n  IF n <> 0 THEN");
    expect(sql).toContain("IF s IS DISTINCT FROM 130393389 THEN");
    expect(sql).toContain("WHERE cvegeo = '000000000' AND estimador = 'Valor';\n  IF nat IS DISTINCT FROM s THEN");
    expect(sql).toContain("IF n <> 32 OR ent IS DISTINCT FROM s THEN");
    expect(sql).toContain("WHERE cve_mun = '12001';\n  IF s IS DISTINCT FROM 767454 THEN");
    expect(sql).toContain("WHERE muestra_insuficiente;\n  IF n <> 7 THEN");
    expect(sql).toContain("WHERE enumeracion_completa;\n  IF n <> 750 THEN");
  });

  it("checks the 9 new 2025 municipios with their EIC POBTOT", () => {
    expect(NEW_KEYS_POBTOT.map(([k]) => k)).toEqual([
      "02007", "04013", "12082", "12083", "12084", "12085", "24059", "25019", "25020",
    ]);
    expect(sql).toContain(
      "(VALUES ('02007', 20520), ('04013', 18366), ('12082', 8097), ('12083', 11015), ('12084', 7755), ('12085', 5837), ('24059', 170650), ('25019', 37266), ('25020', 41229))",
    );
    expect(sql).toContain("WHERE m.pobtot IS DISTINCT FROM k.pobtot;");
  });

  it("every check raises (no NOTICE-only check)", () => {
    expect((sql.match(/RAISE EXCEPTION/g) ?? []).length).toBe(12);
  });

  it("anti-joins the 2,478 keys against municipios_2025 both ways, only when it exists", () => {
    const guard = sql.indexOf("IF to_regclass('public.municipios_2025') IS NOT NULL THEN");
    expect(guard).toBeGreaterThan(-1);
    const block = sql.slice(guard, sql.indexOf("END IF;\n  RAISE NOTICE 'eic2025: OK"));
    expect(block).toContain(
      "SELECT count(*) INTO n FROM eic_2025_municipio e\n     WHERE NOT EXISTS (SELECT 1 FROM public.municipios_2025 m WHERE m.cve_mun = e.cve_mun);",
    );
    expect(block).toContain(
      "SELECT count(*) INTO d FROM public.municipios_2025 m\n     WHERE NOT EXISTS (SELECT 1 FROM eic_2025_municipio e WHERE e.cve_mun = m.cve_mun);",
    );
    expect(block).toContain("IF n <> 0 OR d <> 0 THEN\n      RAISE EXCEPTION");
    // Every municipios_2025 read sits behind the guard, inside the DO block
    // (never in a view: load-censo drops municipios_2025 without CASCADE).
    expect(sql.indexOf("municipios_2025")).toBeGreaterThan(guard - 1);
    expect(eicViewsSql()).not.toContain("municipios_2025");
  });
});

describe("hand-off lines", () => {
  it("prints api-role.sql and the ledger line but never writes the ledger itself", () => {
    expect(API_ROLE_LINE).toBe(
      "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < scripts/api-role.sql",
    );
    expect(LEDGER_LINE).toBe(
      'npx tsx scripts/record-dataset-version.ts --dataset=eic_2025 --edition=2025 --source="INEGI EIC 2025 datos abiertos (conjunto_de_datos_eic2025_105, pub. 2026-09-22)" --rows=13880 --apply',
    );
    const src = read("scripts/load-eic2025.ts");
    expect(src).not.toMatch(/INSERT INTO dataset_versions|from "\.\/record-dataset-version/);
    expect(buildReloadSql()).not.toMatch(/dataset_versions/);
  });
});

describe("allowlists outside the loader", () => {
  it("sage-role.sql grants the raw table and the three views to denue_sage, existence-guarded", () => {
    const sql = read("scripts/sage-role.sql");
    for (const r of LOADED_RELATIONS) {
      expect(sql).toContain(`IF to_regclass('public.${r}') IS NOT NULL THEN\n    GRANT SELECT ON ${r} TO denue_sage;`);
    }
  });

  it("api-role.sql grants SELECT on all four relations to denue_api", () => {
    const sql = read("scripts/api-role.sql");
    const start = sql.indexOf("FOREACH r IN ARRAY ARRAY[");
    const loop = sql.slice(start, sql.indexOf("]", start));
    for (const r of LOADED_RELATIONS) expect(loop).toContain(`'${r}'`);
  });

  it("migration 029 re-applies the same grants, guarded and idempotent, with no DDL", () => {
    const sql = read("scripts/migrations/029-eic2025-grants.sql");
    const body = stripComments(sql);
    expect(body.trimStart().startsWith("\\set ON_ERROR_STOP on\n\nBEGIN;")).toBe(true);
    expect(body.trimEnd().endsWith("COMMIT;")).toBe(true);
    for (const r of LOADED_RELATIONS) {
      const block = body.slice(body.indexOf(`IF to_regclass('public.${r}') IS NOT NULL THEN`));
      expect(block.length).toBeLessThan(body.length);
      const inner = block.slice(0, block.indexOf("END IF;"));
      expect(inner).toContain(`REVOKE ALL ON public.${r} FROM anon, authenticated, trustr_app;`);
      expect(inner).toContain(`GRANT SELECT ON public.${r} TO denue_sage;`);
      expect(inner).toContain(`GRANT SELECT ON public.${r} TO denue_api;`);
    }
    expect(body).not.toMatch(/\b(CREATE|DROP|ALTER|UPDATE|DELETE|INSERT|TRUNCATE)\b/);
  });

  it("the Sage schema summary describes eic_2025_municipio as a 2,478-row sample survey", () => {
    const src = read("src/api/sage/endpoint-catalog.ts");
    const line = src.split("\n").find((l) => l.includes("INEGI Encuesta Intercensal 2025"));
    expect(line).toBeDefined();
    expect(line).toContain("2,478 municipios");
    expect(line).toContain("SAMPLE SURVEY");
    expect(line).toContain("private dwellings only");
    expect(line).toContain("eic_2025_municipio_moe");
    expect(line).toContain("same indicator columns");
    const universe = src.split("\n").find((l) => l.includes("Canonical municipio universe"));
    expect(universe).toContain("The 9 carry NULL Censo 2020 fields");
    expect(universe).toContain("join eic_2025_municipio on cve_mun for 2025 figures");
    expect(universe).not.toContain("until EIC 2025 lands");
    expect(src).toMatch(/^eic_2025_municipio\(cve_mun, /m);
  });
});
