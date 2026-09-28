import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { mockExec } = vi.hoisted(() => ({ mockExec: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFileSync: mockExec,
  execSync: vi.fn(),
  execFile: vi.fn(),
}));

import {
  normalizeHeader,
  RNID_VARIANTS,
  listFirstCsvInZip,
  findVariantInputs,
  buildVariantReloadSql,
  loadSesnsp,
  throughFromZipName,
  cutoffSql,
  monthHasDataSql,
  detectEncoding,
  preparePreparedCsv,
  assertCliArgs,
} from "./load-sesnsp.js";

beforeEach(() => mockExec.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("normalizeHeader", () => {
  it("maps the canonical Delitos columns", () => {
    expect(normalizeHeader("Año")).toBe("ano");
    expect(normalizeHeader("Clave_Ent")).toBe("cve_ent");
    expect(normalizeHeader("Cve. Municipio")).toBe("cve_municipio");
    expect(normalizeHeader("Bien jurídico afectado")).toBe("bien_juridico");
    expect(normalizeHeader("Tipo de delito")).toBe("tipo_delito");
    expect(normalizeHeader("Subtipo de delito")).toBe("subtipo_delito");
    expect(normalizeHeader("Modalidad")).toBe("modalidad");
  });

  it("maps the demographic columns from Víctimas variants", () => {
    expect(normalizeHeader("Sexo")).toBe("sexo");
    expect(normalizeHeader("Rango de edad")).toBe("rango_edad");
  });

  it("maps every monthly column to a Spanish month identifier", () => {
    const months = [
      "Enero",
      "Febrero",
      "Marzo",
      "Abril",
      "Mayo",
      "Junio",
      "Julio",
      "Agosto",
      "Septiembre",
      "Octubre",
      "Noviembre",
      "Diciembre",
    ];
    for (const m of months) {
      expect(normalizeHeader(m)).toBe(m.toLowerCase());
    }
  });

  it("strips leading BOM (\\ufeff) before lookup", () => {
    expect(normalizeHeader("﻿Año")).toBe("ano");
  });

  it("throws a helpful error on an unknown column", () => {
    expect(() => normalizeHeader("Presupuesto")).toThrow(
      /unknown SESNSP column "Presupuesto"/,
    );
  });
});

describe("RNID_VARIANTS", () => {
  it("ships only the Municipal Delitos variant — Estatal/Víctimas explicitly excluded", () => {
    expect(RNID_VARIANTS).toHaveLength(1);
    expect(RNID_VARIANTS[0]?.basename).toBe("RNID-Delitos_Municipal");
  });

  it("flags the Municipal Delitos variant correctly", () => {
    const v = RNID_VARIANTS[0]!;
    expect(v.level).toBe("municipal");
    expect(v.metric).toBe("delitos");
    expect(v.hasMunicipio).toBe(true);
    expect(v.hasDemographics).toBe(false);
  });

  it("uses sesnsp_<metric>_<level>(_raw) as the table naming convention", () => {
    for (const v of RNID_VARIANTS) {
      expect(v.rawTable).toBe(`sesnsp_${v.metric}_${v.level}_raw`);
      expect(v.longView).toBe(`sesnsp_${v.metric}_${v.level}`);
    }
  });
});

describe("listFirstCsvInZip", () => {
  it("returns the canonical CSV name when zip has exactly one .csv entry", () => {
    mockExec.mockReturnValue(
      [
        "Archive:  raw/sesnsp/RNID-Victimas_Estatal-2026-mar2026.zip",
        "  Length      Date    Time    Name",
        "---------  ---------- -----   ----",
        "  9702128  2026-04-10 13:15   RNID-Víctimas_Estatal-2026-mar2026.csv",
        "---------                     -------",
        "  9702128                     1 file",
      ].join("\n"),
    );
    expect(
      listFirstCsvInZip("raw/sesnsp/RNID-Victimas_Estatal-2026-mar2026.zip"),
    ).toBe("RNID-Víctimas_Estatal-2026-mar2026.csv");
  });

  it("throws when the zip has no CSV entries", () => {
    mockExec.mockReturnValue(
      [
        "Archive:  raw/sesnsp/empty.zip",
        "  Length      Date    Time    Name",
        "---------  ---------- -----   ----",
        "      100  2026-04-10 13:14   readme.txt",
      ].join("\n"),
    );
    expect(() => listFirstCsvInZip("raw/sesnsp/empty.zip")).toThrow(
      /no \.csv inside/,
    );
  });

  it("throws when the zip has multiple CSVs (loader expects one)", () => {
    mockExec.mockReturnValue(
      [
        "Archive:  raw/sesnsp/multi.zip",
        "  Length      Date    Time    Name",
        "---------  ---------- -----   ----",
        "      100  2026-04-10 13:14   a.csv",
        "      200  2026-04-10 13:14   b.csv",
      ].join("\n"),
    );
    expect(() => listFirstCsvInZip("raw/sesnsp/multi.zip")).toThrow(
      /multiple CSVs/,
    );
  });
});

describe("findVariantInputs", () => {
  /**
   * findVariantInputs calls execFileSync twice per zip: once via the `ls`
   * inside the helper itself, then once per matched zip via listFirstCsvInZip's
   * `unzip -l`. This dispatch mock distinguishes by the shell args — `ls *.zip`
   * for the first call, `unzip -l <path>` for each follow-up.
   */
  function mockDir(zipNames: string[], csvNames: string[] = []): void {
    mockExec.mockImplementation((cmd: string, args?: string[]) => {
      const argsArr = args ?? [];
      const argsStr = argsArr.join(" ");
      if (cmd === "/bin/sh" && argsStr.includes("ls *.zip")) {
        return [...zipNames, ...csvNames].join("\n");
      }
      if (cmd === "unzip" && argsArr[0] === "-l") {
        // Synthesize a minimal unzip listing whose only CSV name is derived
        // from the zip path (drop the dir, swap .zip → .csv).
        const zipPath = argsArr[1] as string;
        const inner = zipPath
          .split("/")
          .pop()!
          .replace(/\.zip$/, ".csv");
        return [
          `Archive:  ${zipPath}`,
          "  Length      Date    Time    Name",
          "---------  ---------- -----   ----",
          `   100  2026-04-10 13:15   ${inner}`,
        ].join("\n");
      }
      return "";
    });
  }

  it("returns one zip input when exactly one zip matches the basename", () => {
    mockDir([
      "RNID-Delitos_Estatal-2026-mar2026.zip",
      "RNID-Delitos_Municipal-2026-mar2026.zip",
      "RNID-Victimas_Estatal-2026-mar2026.zip",
      "RNID-Victimas_Municipal-2026-mar2026.zip",
    ]);
    const out = findVariantInputs("raw/sesnsp", "RNID-Victimas_Municipal");
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: "zip",
      zipPath: "raw/sesnsp/RNID-Victimas_Municipal-2026-mar2026.zip",
      csvInside: "RNID-Victimas_Municipal-2026-mar2026.csv",
    });
  });

  it("does not pick up Municipal when asked for Estatal (prefix is exact)", () => {
    mockDir([
      "RNID-Delitos_Estatal-2026-mar2026.zip",
      "RNID-Delitos_Municipal-2026-mar2026.zip",
    ]);
    const out = findVariantInputs("raw/sesnsp", "RNID-Delitos_Estatal");
    expect(out.map((i) => ("zipPath" in i ? i.zipPath : i.csvPath))).toEqual([
      "raw/sesnsp/RNID-Delitos_Estatal-2026-mar2026.zip",
    ]);
  });

  it("returns empty when no input matches the variant", () => {
    mockDir(["RNID-Delitos_Estatal-2026-mar2026.zip"]);
    expect(findVariantInputs("raw/sesnsp", "RNID-Victimas_Municipal")).toEqual(
      [],
    );
  });

  it("returns BOTH zip + csv when present, sorted alphabetically", () => {
    mockDir(
      ["RNID-Delitos_Municipal-2026-mar2026.zip"],
      ["RNID-Delitos_Municipal-Historical-2015-2025.csv"],
    );
    const out = findVariantInputs("raw/sesnsp", "RNID-Delitos_Municipal");
    expect(out).toHaveLength(2);
    // Lexical sort: "2026-mar…zip" < "Historical-…csv" because '2' (0x32)
    // sorts before 'H' (0x48). Load order is a non-issue — the variant's
    // raw table is a single append target after one DROP+CREATE.
    expect(out[0]).toMatchObject({
      kind: "zip",
      zipPath: "raw/sesnsp/RNID-Delitos_Municipal-2026-mar2026.zip",
    });
    expect(out[1]).toMatchObject({
      kind: "csv",
      csvPath: "raw/sesnsp/RNID-Delitos_Municipal-Historical-2015-2025.csv",
    });
  });
});

describe("buildVariantReloadSql (audit #144)", () => {
  const variant = RNID_VARIANTS[0]!;
  const sql = buildVariantReloadSql(variant, ["/tmp/a_0.csv", "/tmp/a_1.csv"]);

  it("\\copies every input into staging before dropping anything live", () => {
    const lastCopy = sql.lastIndexOf(
      "\\copy sesnsp_delitos_municipal_raw_staging FROM '/tmp/a_1.csv'",
    );
    expect(sql).toContain("\\copy sesnsp_delitos_municipal_raw_staging FROM '/tmp/a_0.csv'");
    expect(lastCopy).toBeGreaterThan(-1);
    expect(lastCopy).toBeLessThan(
      sql.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_delitos_municipal_yearly;"),
    );
  });

  it("never CASCADEs — old DROP ... CASCADE destroyed mv_delitos_municipal_yearly", () => {
    expect(sql).not.toMatch(/DROP (TABLE|VIEW|MATERIALIZED VIEW)[^;]*sesnsp[^;]*CASCADE/);
    expect(sql.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_delitos_municipal_yearly;")).toBeLessThan(
      sql.indexOf("DROP MATERIALIZED VIEW IF EXISTS sesnsp_delitos_municipal;"),
    );
  });

  it("swaps staging in, then rebuilds the long MV and mv_delitos_municipal_yearly on top", () => {
    const swap = sql.indexOf(
      "ALTER TABLE sesnsp_delitos_municipal_raw_staging RENAME TO sesnsp_delitos_municipal_raw;",
    );
    const longMv = sql.indexOf("CREATE MATERIALIZED VIEW sesnsp_delitos_municipal AS");
    const yearly = sql.indexOf("CREATE MATERIALIZED VIEW mv_delitos_municipal_yearly AS");
    expect(swap).toBeGreaterThan(-1);
    expect(swap).toBeLessThan(longMv);
    expect(longMv).toBeLessThan(yearly);
    expect(sql).toContain("GRANT SELECT ON mv_delitos_municipal_yearly TO denue_sage;");
    // The 31.6M-row long MV stays off the Sage allowlist.
    expect(sql).not.toContain("GRANT SELECT ON sesnsp_delitos_municipal TO");
  });
});

describe("throughFromZipName", () => {
  it("parses the last published month from a canonical ZIP name", () => {
    expect(throughFromZipName("RNID-Delitos_Municipal-2026-ago2026.zip")).toEqual({ ano: 2026, mes: 8 });
    expect(throughFromZipName("RNID-Delitos_Municipal-2026-mar2026.zip")).toEqual({ ano: 2026, mes: 3 });
  });

  it("throws for a ZIP whose name does not carry a lowercase <mes>YYYY matching the year", () => {
    for (const name of [
      "RNID-Delitos_Municipal-2026-Ago2026.zip",
      "RNID-Delitos_Municipal-2026-ago2025.zip",
      "RNID-Delitos_Municipal-2026.zip",
    ]) {
      expect(() => throughFromZipName(name)).toThrow(/does not match/);
    }
  });

  it("returns null for the historical CSV input", () => {
    expect(throughFromZipName("RNID-Delitos_Municipal-Historical-2015-2025.csv")).toBeNull();
  });
});

describe("cutoffSql", () => {
  const ALL = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
  const setCols = (u: string): string[] =>
    [...u.matchAll(/(\w+) = NULL/g)].map((m) => m[1] as string);
  const assertCols = (a: string): string[] =>
    ALL.filter((c) => new RegExp(`\\b${c}\\b`).test(a));

  it("mes=8 blanks and asserts exactly septiembre..diciembre for that year", () => {
    const sql = cutoffSql("t_staging", "RNID-Delitos_Municipal-2026-ago2026.zip", 2026, 8);
    const after = ["septiembre", "octubre", "noviembre", "diciembre"];
    expect(setCols(sql.updateSql!)).toEqual(after);
    // Only rows that still hold a value: a mar2026-style file → UPDATE 0.
    expect(sql.updateSql).toBe(
      "UPDATE t_staging SET septiembre = NULL, octubre = NULL, noviembre = NULL, diciembre = NULL WHERE ano = '2026' AND (septiembre IS NOT NULL OR octubre IS NOT NULL OR noviembre IS NOT NULL OR diciembre IS NOT NULL);",
    );
    expect(assertCols(sql.assertSql)).toEqual(after);
    expect(sql.assertSql).toContain("carries data after 2026-08 (% rows)");
    expect(sql.assertSql).toContain("has no rows with ano = 2026");
    expect(sql.assertSql).toMatch(/^DO \$\$[\s\S]*END \$\$;$/);
  });

  it("pins the assert semantics: year-present check and the ''/'0' allow-list per later month", () => {
    const sql = cutoffSql("t_staging", "x-2026-ago2026.zip", 2026, 8).assertSql;
    expect(sql).toMatch(/SELECT count\(\*\) INTO n FROM t_staging WHERE ano = '2026';\n  IF n = 0 THEN\n    RAISE EXCEPTION/);
    expect(sql).toMatch(/IF n > 0 THEN\n    RAISE EXCEPTION 'loadSesnsp: x-2026-ago2026.zip carries data/);
    for (const c of ["septiembre", "octubre", "noviembre", "diciembre"]) {
      expect(sql).toContain(monthHasDataSql(c));
    }
    expect(monthHasDataSql("septiembre")).toBe("COALESCE(septiembre, '') NOT IN ('', '0')");
  });

  it("monthHasDataSql flags '5' but not NULL, '' or '0' (predicate evaluated from its string)", () => {
    for (const c of ALL) {
      const m = /^COALESCE\((\w+), '(.*?)'\) NOT IN \(((?:'[^']*'(?:, )?)+)\)$/.exec(monthHasDataSql(c));
      expect(m?.[1]).toBe(c);
      const nullAs = m![2]!;
      const allowed = [...m![3]!.matchAll(/'([^']*)'/g)].map((x) => x[1]);
      const hasData = (v: string | null): boolean => !allowed.includes(v ?? nullAs);
      expect([null, "", "0", "5"].map(hasData)).toEqual([false, false, false, true]);
    }
  });

  it("mes=3 covers abril..diciembre (9 columns)", () => {
    const sql = cutoffSql("t_staging", "x-2026-mar2026.zip", 2026, 3);
    expect(setCols(sql.updateSql!)).toEqual(ALL.slice(3));
    expect(assertCols(sql.assertSql)).toEqual(ALL.slice(3));
  });

  it("mes=12 keeps only the year-present check, no UPDATE", () => {
    const sql = cutoffSql("t_staging", "x-2026-dic2026.zip", 2026, 12);
    expect(sql.updateSql).toBeNull();
    expect(sql.assertSql).toMatch(/IF n = 0 THEN\n    RAISE EXCEPTION 'loadSesnsp: x-2026-dic2026.zip has no rows with ano = 2026/);
    expect(sql.assertSql).not.toContain("carries data after");
    expect(assertCols(sql.assertSql)).toEqual([]);
    expect(sql.assertSql).toMatch(/^DO \$\$[\s\S]*END \$\$;$/);
  });

  it("refuses a label that could break out of the SQL literal", () => {
    expect(() => cutoffSql("t_staging", "x'; DROP TABLE y;--.zip", 2026, 8)).toThrow(/unsafe cutoff label/);
  });
});

describe("buildVariantReloadSql with a ZIP cutoff", () => {
  const variant = RNID_VARIANTS[0]!;
  const sql = buildVariantReloadSql(variant, ["/tmp/a_0.csv", "/tmp/a_1.csv"], [
    { label: "RNID-Delitos_Municipal-2026-ago2026.zip", ano: 2026, mes: 8 },
  ]);

  it("asserts then blanks on STAGING after every \\copy and before anything live is dropped", () => {
    const lastCopy = sql.indexOf("\\copy sesnsp_delitos_municipal_raw_staging FROM '/tmp/a_1.csv'");
    const assertAt = sql.indexOf("carries data after 2026-08");
    const updateAt = sql.indexOf("UPDATE sesnsp_delitos_municipal_raw_staging SET septiembre = NULL");
    const firstDrop = sql.indexOf("DROP MATERIALIZED VIEW IF EXISTS mv_delitos_municipal_yearly;");
    expect(lastCopy).toBeGreaterThan(-1);
    expect(lastCopy).toBeLessThan(assertAt);
    expect(assertAt).toBeLessThan(updateAt);
    expect(updateAt).toBeLessThan(firstDrop);
  });

  it("emits the year-present check but no UPDATE for a dic ZIP", () => {
    const dic = buildVariantReloadSql(variant, ["/tmp/a_0.csv"], [
      { label: "RNID-Delitos_Municipal-2026-dic2026.zip", ano: 2026, mes: 12 },
    ]);
    expect(dic).toContain("has no rows with ano = 2026");
    expect(dic).not.toContain("UPDATE ");
  });

  it("emits no cutoff SQL without cutoffs", () => {
    expect(buildVariantReloadSql(variant, ["/tmp/a_0.csv"])).not.toContain("UPDATE ");
  });
});

describe("assertCliArgs", () => {
  it("accepts --rnid-dir=<dir> and nothing", () => {
    expect(() => assertCliArgs([])).not.toThrow();
    expect(() => assertCliArgs(["--rnid-dir=raw/x"])).not.toThrow();
  });

  it("rejects the space form and unknown flags", () => {
    expect(() => assertCliArgs(["--rnid-dir", "raw/x"])).toThrow(/unknown argument "--rnid-dir"/);
    expect(() => assertCliArgs(["--rnid_dir=raw/x"])).toThrow(/unknown argument/);
  });
});

describe("encoding detection + prep on real files (no mocks)", () => {
  const HEADER =
    "Año,Clave_Ent,Entidad,Cve. Municipio,Municipio,Bien jurídico afectado,Tipo de delito,Subtipo de delito,Modalidad,Enero,Febrero,Marzo,Abril,Mayo,Junio,Julio,Agosto,Septiembre,Octubre,Noviembre,Diciembre";
  const ROW = (m: string): string =>
    `2026,20,Oaxaca,${m},Santa María Peñoles,La vida y la Integridad corporal,Homicidio,Homicidio doloso,Con arma blanca,0,1,1,1,2,0,0,2,0,0,0,0`;
  const TEXT = [HEADER, ROW("20001"), ROW("20002"), ROW("20003")].join("\r\n") + "\r\n";
  let dir: string;

  beforeEach(async () => {
    const real = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    mockExec.mockImplementation(real.execFileSync as never);
    vi.spyOn(console, "log").mockImplementation(() => {});
    dir = mkdtempSync(join(tmpdir(), "sesnsp-enc-test-"));
    writeFileSync(join(dir, "utf8.csv"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(TEXT, "utf-8")]));
    writeFileSync(join(dir, "cp1252.csv"), Buffer.from(TEXT, "latin1"));
  });
  afterEach(() => {
    // The top-level beforeEach returns mockExec, which vitest then calls as
    // a teardown; don't let that run the real execFileSync with no args.
    mockExec.mockReset();
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects UTF-8 (with BOM) vs WINDOWS-1252 (raw 0xF1)", () => {
    expect(readFileSync(join(dir, "cp1252.csv")).includes(0xf1)).toBe(true);
    expect(detectEncoding('cat "$CSV"', { CSV: join(dir, "utf8.csv") }, "utf8.csv", dir)).toBe("utf-8");
    expect(detectEncoding('cat "$CSV"', { CSV: join(dir, "cp1252.csv") }, "cp1252.csv", dir)).toBe("windows-1252");
  });

  it("throws on an empty or unreadable sample instead of answering utf-8", () => {
    writeFileSync(join(dir, "empty.csv"), "");
    expect(() =>
      preparePreparedCsv({ kind: "csv", csvPath: join(dir, "empty.csv") }, dir),
    ).toThrow(/empty\.csv: empty or unreadable sample \(missing\/corrupt input\?\)/);
    expect(() =>
      detectEncoding('cat "$CSV"', { CSV: join(dir, "missing.csv") }, "missing.csv", dir),
    ).toThrow("loadSesnsp: missing.csv: empty or unreadable sample (missing/corrupt input?)");
  });

  it("prepares both into valid UTF-8 with the snake_case header and ñ/í intact", () => {
    for (const name of ["utf8.csv", "cp1252.csv"]) {
      const out = preparePreparedCsv({ kind: "csv", csvPath: join(dir, name) }, dir);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(out));
      const lines = text.split("\n");
      expect(lines[0]).toBe(
        "ano,cve_ent,entidad,cve_municipio,municipio,bien_juridico,tipo_delito,subtipo_delito,modalidad,enero,febrero,marzo,abril,mayo,junio,julio,agosto,septiembre,octubre,noviembre,diciembre",
      );
      expect(lines[1]).toBe(ROW("20001"));
      expect(text).not.toContain("\r");
      expect(text).not.toContain("\ufeff");
      expect(lines).toHaveLength(5); // header + 3 rows + trailing ""
    }
  });
});

describe("loadSesnsp orchestration (audit #144)", () => {
  const HEADER =
    "Año,Clave_Ent,Entidad,Cve. Municipio,Municipio,Bien jurídico afectado,Tipo de delito,Subtipo de delito,Modalidad,Enero,Febrero,Marzo,Abril,Mayo,Junio,Julio,Agosto,Septiembre,Octubre,Noviembre,Diciembre";

  function stubAll(missing = "", preparedLines = "10\n"): void {
    mockExec.mockImplementation((cmd: string, args: string[] = []) => {
      const joined = args.join(" ");
      if (cmd === "/bin/bash" && joined.includes('wc -l < "$OUT"')) return preparedLines;
      if (cmd === "/bin/bash" && joined.includes("iconv -f UTF-8 -t UTF-8")) return "windows-1252\n";
      if (cmd === "/bin/sh" && joined.includes("ls *.zip")) {
        return "RNID-Delitos_Municipal-Historical-2015-2025.csv\n";
      }
      if (cmd === "/bin/sh" && joined.includes("head -1")) return `${HEADER}\n`;
      if (cmd === "/bin/sh") return "";
      if (args.includes("--single-transaction") || args[0] === "cp") return "";
      if (args.includes("rm")) return "";
      if ((args.at(-1) ?? "").includes("to_regclass")) return missing;
      return "10\n";
    });
  }

  it("reloads each variant in ONE single-transaction psql session", async () => {
    stubAll();
    const r = await loadSesnsp({ rnidDir: "raw/sesnsp", dbContainer: "supabase-db" });
    expect(r.variants[0]?.raw_rows).toBe(10);
    const tx = mockExec.mock.calls.filter((c) =>
      ((c[1] as string[]) ?? []).includes("--single-transaction"),
    );
    expect(tx.length).toBe(1);
    expect((tx[0]?.[2] as { input: string }).input).toBe(
      buildVariantReloadSql(RNID_VARIANTS[0]!, [
        "/tmp/sesnsp_delitos_municipal_raw_0.csv",
      ]),
    );
    // No psql -c call builds or drops anything outside that transaction.
    for (const c of mockExec.mock.calls) {
      expect(((c[1] as string[]) ?? []).join(" ")).not.toMatch(/DROP|CREATE/);
    }
    const rm = mockExec.mock.calls.find((c) =>
      ((c[1] as string[]) ?? []).includes("/tmp/sesnsp_delitos_municipal_raw_0.csv") &&
      ((c[1] as string[]) ?? []).includes("rm"),
    );
    expect(rm).toBeDefined();
  });

  it("prepares the CSV under bash with pipefail so an unzip/iconv failure is fatal (audit #149)", async () => {
    stubAll();
    await loadSesnsp({ rnidDir: "raw/sesnsp", dbContainer: "supabase-db" });
    const body = mockExec.mock.calls.find((c) =>
      ((c[1] as string[]) ?? []).join(" ").includes("iconv -f WINDOWS-1252 -t UTF-8 | tail -n +2"),
    );
    expect(body?.[0]).toBe("/bin/bash");
    expect((body?.[1] as string[]).slice(0, 3)).toEqual(["-o", "pipefail", "-c"]);
  });

  it("refuses a prepared CSV with fewer lines than the source, before any psql session (audit #149)", async () => {
    stubAll("", "7\n");
    await expect(
      loadSesnsp({ rnidDir: "raw/sesnsp", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/has 7 lines, source has 10 \(truncated prep\)/);
    const tx = mockExec.mock.calls.filter((c) =>
      ((c[1] as string[]) ?? []).includes("--single-transaction"),
    );
    expect(tx).toHaveLength(0);
  });

  function withZip(zipName: string): void {
    stubAll();
    const base = mockExec.getMockImplementation()!;
    mockExec.mockImplementation((cmd: string, args: string[] = []) => {
      if (cmd === "/bin/sh" && args.join(" ").includes("ls *.zip")) {
        return `${zipName}\nRNID-Delitos_Municipal-Historical-2015-2025.csv\n`;
      }
      if (cmd === "unzip" && args[0] === "-l") {
        return `   100  2026-09-05 13:17   ${zipName.replace(/\.zip$/, ".csv")}\n`;
      }
      return base(cmd, args);
    });
  }

  it("passes the ZIP's month cutoff into the single transaction", async () => {
    withZip("RNID-Delitos_Municipal-2026-ago2026.zip");
    await loadSesnsp({ rnidDir: "raw/sesnsp", dbContainer: "supabase-db" });
    const tx = mockExec.mock.calls.find((c) =>
      ((c[1] as string[]) ?? []).includes("--single-transaction"),
    );
    expect((tx?.[2] as { input: string }).input).toBe(
      buildVariantReloadSql(
        RNID_VARIANTS[0]!,
        ["/tmp/sesnsp_delitos_municipal_raw_0.csv", "/tmp/sesnsp_delitos_municipal_raw_1.csv"],
        [{ label: "RNID-Delitos_Municipal-2026-ago2026.zip", ano: 2026, mes: 8 }],
      ),
    );
  });

  it("refuses a misnamed ZIP before any prep or psql session", async () => {
    withZip("RNID-Delitos_Municipal-2026-Ago2026.zip");
    await expect(
      loadSesnsp({ rnidDir: "raw/sesnsp", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/does not match/);
    for (const c of mockExec.mock.calls) {
      expect(c[0]).not.toBe("/bin/bash");
      expect((c[1] as string[]) ?? []).not.toContain("--single-transaction");
    }
  });

  it("fails loud when an analytics MV is missing after the load", async () => {
    stubAll("mv_delitos_municipal_yearly\n");
    await expect(
      loadSesnsp({ rnidDir: "raw/sesnsp", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/missing after load: mv_delitos_municipal_yearly/);
  });
});
