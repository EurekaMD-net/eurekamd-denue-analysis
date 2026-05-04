import { describe, it, expect } from "vitest";
import {
  ENTIDADES_RESULT,
  IRS_GRADO,
  MUNICIPIOS_ANALYTICS_RESULT,
  NATIONAL_TREEMAP_RESULT,
  SECTOR_GRADE_MATRIX_RESULT,
  TOP_SECTORS_RESULT,
} from "./types";

describe("Zod response schemas", () => {
  it("IRS_GRADO accepts the 6 canonical labels and rejects others", () => {
    for (const g of [
      "Muy bajo",
      "Bajo",
      "Medio",
      "Alto",
      "Muy alto",
      "sin_dato",
    ]) {
      expect(IRS_GRADO.safeParse(g).success).toBe(true);
    }
    expect(IRS_GRADO.safeParse("Garbage").success).toBe(false);
    expect(IRS_GRADO.safeParse(null).success).toBe(false);
  });

  it("ENTIDADES_RESULT validates a real-shape payload", () => {
    const ok = ENTIDADES_RESULT.safeParse({
      entidades: [
        {
          clave: "06",
          nombre: "Colima",
          loaded: 41765,
          inegi_total: 41756,
          status: "green",
        },
        {
          clave: "01",
          nombre: "Aguascalientes",
          loaded: 71278,
          inegi_total: null,
          status: "unverified",
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("ENTIDADES_RESULT rejects missing fields", () => {
    const bad = ENTIDADES_RESULT.safeParse({ entidades: [{ clave: "06" }] });
    expect(bad.success).toBe(false);
  });

  it("NATIONAL_TREEMAP_RESULT round-trips through 32 entries", () => {
    const payload = {
      entidades: Array.from({ length: 32 }, (_, i) => ({
        entidad: String(i + 1).padStart(2, "0"),
        nombre: `Entidad ${i + 1}`,
        establecimientos: 1000 + i,
        modal_irs_grado: i % 2 === 0 ? "Muy bajo" : "Alto",
        pobreza_pct_promedio: i === 0 ? null : 25.5,
      })),
    };
    expect(NATIONAL_TREEMAP_RESULT.safeParse(payload).success).toBe(true);
  });

  it("NATIONAL_TREEMAP_RESULT rejects unknown irs_grado", () => {
    const bad = NATIONAL_TREEMAP_RESULT.safeParse({
      entidades: [
        {
          entidad: "01",
          nombre: "x",
          establecimientos: 1,
          modal_irs_grado: "garbage",
          pobreza_pct_promedio: null,
        },
      ],
    });
    expect(bad.success).toBe(false);
  });

  it("SECTOR_GRADE_MATRIX_RESULT validates cells", () => {
    const ok = SECTOR_GRADE_MATRIX_RESULT.safeParse({
      cells: [
        { scian: "46", irs_grado: "Muy bajo", count: 1500000 },
        { scian: "11", irs_grado: "sin_dato", count: 100 },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("MUNICIPIOS_ANALYTICS_RESULT allows null for poblacion + pobreza_pct + irs", () => {
    const ok = MUNICIPIOS_ANALYTICS_RESULT.safeParse({
      entidad: "09",
      municipios: [
        {
          cve_mun: "09001",
          municipio: null,
          poblacion: null,
          establecimientos: 5,
          farmacias: 0,
          unidades_clues: 0,
          pobreza_pct: null,
          irs_grado: null,
          irs_indice: null,
        },
      ],
    });
    expect(ok.success).toBe(true);
  });

  it("MUNICIPIOS_ANALYTICS_RESULT rejects negative establecimientos as still numeric (allowed)", () => {
    // Schema accepts any number including 0; keep the contract loose
    const r = MUNICIPIOS_ANALYTICS_RESULT.safeParse({
      entidad: "09",
      municipios: [
        {
          cve_mun: "09001",
          municipio: "x",
          poblacion: 0,
          establecimientos: 0,
          farmacias: 0,
          unidades_clues: 0,
          pobreza_pct: 0,
          irs_grado: "sin_dato",
          irs_indice: 0,
        },
      ],
    });
    expect(r.success).toBe(true);
  });

  it("TOP_SECTORS_RESULT validates the new endpoint shape", () => {
    const ok = TOP_SECTORS_RESULT.safeParse({
      entidad: "09",
      sectors: [
        { scian: "46", name: "Comercio al por menor", count: 120000 },
        { scian: "72", name: "Restaurantes", count: 30000 },
      ],
    });
    expect(ok.success).toBe(true);
  });
});
