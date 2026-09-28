import { describe, expect, it } from "vitest";
import { assertYear, checkSniivCsv } from "./_sniiv-csv.js";

const HDR = ["ano", "mes", "cve_ent", "acciones"] as const;
const csv = (s: string): Buffer => Buffer.from(s, "utf-8");

describe("assertYear", () => {
  it("accepts 20xx and returns it", () => {
    expect(assertYear("2026", "--year")).toBe("2026");
  });
  it("rejects anything else, naming the flag", () => {
    for (const bad of ["abc", "1999", "20266", "2026;", " 2026", "", "2026\n"]) {
      expect(() => assertYear(bad, "--mv-source-year")).toThrow(
        /--mv-source-year must be a year/,
      );
    }
  });
});

describe("checkSniivCsv", () => {
  it("reads `año` as `ano`, tolerates CRLF + BOM + a trailing newline, returns rows and the mes range", () => {
    const out = checkSniivCsv(
      csv("﻿año,mes,cve_ent,acciones\r\n2026,1,01,3\r\n2026,6,02,1\r\n"),
      HDR,
      "2026",
    );
    expect(out).toEqual({ rows: 2, mesMin: 1, mesMax: 6 });
  });

  it("reports missing / extra columns and the first positional difference", () => {
    expect(() =>
      checkSniivCsv(csv("ano,mes,cve_mun,acciones\n2026,1,001,1\n"), HDR, "2026"),
    ).toThrow(
      /missing \[cve_ent\], extra \[cve_mun\], first difference at column 3: got "cve_mun", expected "cve_ent"/,
    );
    expect(() =>
      checkSniivCsv(csv("ano,mes,cve_ent,acciones,monto\n"), HDR, "2026"),
    ).toThrow(/extra \[monto\], first difference at column 5: got "monto", expected "<none>"/);
  });

  it("refuses rows from another year and names the first one", () => {
    expect(() =>
      checkSniivCsv(csv("ano,mes,cve_ent,acciones\n2026,1,01,1\n2025,12,01,1\n"), HDR, "2026"),
    ).toThrow(/1 of 2 rows have ano != 2026, 0 have mes outside 1..12 \(first: line 3: ano="2025" mes="12"\)/);
  });

  it("refuses a mes outside 1..12", () => {
    expect(() =>
      checkSniivCsv(csv("ano,mes,cve_ent,acciones\n2026,13,01,1\n2026,,01,1\n"), HDR, "2026"),
    ).toThrow(/0 of 2 rows have ano != 2026, 2 have mes outside 1..12/);
  });

  it("refuses a header-only file", () => {
    expect(() => checkSniivCsv(csv("ano,mes,cve_ent,acciones\r\n"), HDR, "2026")).toThrow(
      /no data rows/,
    );
  });
});
