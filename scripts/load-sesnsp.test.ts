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
  findVariantZip,
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
  it("declares exactly the 4 datasets the loader expects", () => {
    expect(RNID_VARIANTS).toHaveLength(4);
    expect(RNID_VARIANTS.map((v) => v.basename).sort()).toEqual([
      "RNID-Delitos_Estatal",
      "RNID-Delitos_Municipal",
      "RNID-Victimas_Estatal",
      "RNID-Victimas_Municipal",
    ]);
  });

  it("flags Municipal variants with hasMunicipio and Víctimas with hasDemographics", () => {
    const byBasename = Object.fromEntries(
      RNID_VARIANTS.map((v) => [v.basename, v]),
    );
    expect(byBasename["RNID-Delitos_Estatal"]?.hasMunicipio).toBe(false);
    expect(byBasename["RNID-Delitos_Municipal"]?.hasMunicipio).toBe(true);
    expect(byBasename["RNID-Victimas_Estatal"]?.hasMunicipio).toBe(false);
    expect(byBasename["RNID-Victimas_Municipal"]?.hasMunicipio).toBe(true);

    expect(byBasename["RNID-Delitos_Estatal"]?.hasDemographics).toBe(false);
    expect(byBasename["RNID-Delitos_Municipal"]?.hasDemographics).toBe(false);
    expect(byBasename["RNID-Victimas_Estatal"]?.hasDemographics).toBe(true);
    expect(byBasename["RNID-Victimas_Municipal"]?.hasDemographics).toBe(true);
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

describe("findVariantZip", () => {
  it("matches the zip whose name starts with the variant basename", () => {
    mockExec.mockReturnValue(
      [
        "RNID-Delitos_Estatal-2026-mar2026.zip",
        "RNID-Delitos_Municipal-2026-mar2026.zip",
        "RNID-Victimas_Estatal-2026-mar2026.zip",
        "RNID-Victimas_Municipal-2026-mar2026.zip",
      ].join("\n"),
    );
    expect(findVariantZip("raw/sesnsp", "RNID-Victimas_Municipal")).toBe(
      "RNID-Victimas_Municipal-2026-mar2026.zip",
    );
  });

  it("does not pick up Municipal when asked for Estatal (prefix is exact)", () => {
    mockExec.mockReturnValue(
      [
        "RNID-Delitos_Estatal-2026-mar2026.zip",
        "RNID-Delitos_Municipal-2026-mar2026.zip",
      ].join("\n"),
    );
    expect(findVariantZip("raw/sesnsp", "RNID-Delitos_Estatal")).toBe(
      "RNID-Delitos_Estatal-2026-mar2026.zip",
    );
  });

  it("throws when no zip matches the variant", () => {
    mockExec.mockReturnValue("RNID-Delitos_Estatal-2026-mar2026.zip\n");
    expect(() =>
      findVariantZip("raw/sesnsp", "RNID-Victimas_Municipal"),
    ).toThrow(/no zip in raw\/sesnsp starts with "RNID-Victimas_Municipal"/);
  });
});
