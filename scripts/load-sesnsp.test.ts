import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

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

describe("loadSesnsp orchestration (audit #144)", () => {
  const HEADER =
    "Año,Clave_Ent,Entidad,Cve. Municipio,Municipio,Bien jurídico afectado,Tipo de delito,Subtipo de delito,Modalidad,Enero,Febrero,Marzo,Abril,Mayo,Junio,Julio,Agosto,Septiembre,Octubre,Noviembre,Diciembre";

  function stubAll(missing = ""): void {
    mockExec.mockImplementation((cmd: string, args: string[] = []) => {
      const joined = args.join(" ");
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

  it("fails loud when an analytics MV is missing after the load", async () => {
    stubAll("mv_delitos_municipal_yearly\n");
    await expect(
      loadSesnsp({ rnidDir: "raw/sesnsp", dbContainer: "supabase-db" }),
    ).rejects.toThrow(/missing after load: mv_delitos_municipal_yearly/);
  });
});
