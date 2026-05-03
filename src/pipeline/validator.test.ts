/**
 * Tests para Validator — Fase 3
 *
 * Invariantes verificadas:
 * - Acepta el fixture real (denue-real-09-sample.json)
 * - Rechaza JSON inválido
 * - Rechaza array vacío
 * - Rechaza archivo con registros donde campos críticos son null
 * - Rechaza archivo con registros sin CLEE
 * - sampleSize respeta min(sampleSize, totalRecords)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { validateExtractorFile } from "./validator.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/validator-test-`);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function writeFixture(filename: string, content: unknown): string {
  const file = resolve(tmpDir, filename);
  writeFileSync(file, JSON.stringify(content), "utf-8");
  return file;
}

/** Registro mínimo válido según el fixture real */
function makeValidRecord(overrides: Record<string, unknown> = {}) {
  return {
    CLEE: "0900100010001",
    Id: "123",
    Nombre: "HOSPITAL GENERAL",
    Razon_social: "HSP SA DE CV",
    Clase_actividad: "Hospitales generales",
    Estrato: "6 a 10 personas",
    Tipo_vialidad: "CALLE",
    Calle: "Insurgentes",
    Num_Exterior: "100",
    Num_Interior: "",
    Colonia: "Del Valle",
    CP: "03100",
    Ubicacion: "BENITO JUAREZ, Benito Juárez, CIUDAD DE MÉXICO",
    Telefono: "5555555555",
    Correo_e: "",
    Sitio_internet: "",
    Tipo: "Fijo",
    Longitud: "-99.1650",
    Latitud: "19.3830",
    tipo_corredor_industrial: "",
    nom_corredor_industrial: "",
    numero_local: "",
    ...overrides,
  };
}

describe("Validator — archivo real", () => {
  it("acepta el fixture real denue-real-09-sample.json", async () => {
    // Ruta al fixture real checkeado en el repo
    const fixturePath = resolve(
      process.cwd(),
      "tests/fixtures/denue-real-09-sample.json"
    );
    const result = validateExtractorFile(fixturePath, 5);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.totalRecords).toBeGreaterThan(0);
  });
});

describe("Validator — errores de parseo", () => {
  it("rechaza JSON malformado", () => {
    const file = resolve(tmpDir, "bad.json");
    writeFileSync(file, "{ this is not json }", "utf-8");
    const result = validateExtractorFile(file);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/Error al parsear JSON/);
  });

  it("rechaza si el root es un objeto, no un array", () => {
    const file = writeFixture("object.json", { records: [] });
    const result = validateExtractorFile(file);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/no contiene un array/);
  });

  it("rechaza array vacío", () => {
    const file = writeFixture("empty.json", []);
    const result = validateExtractorFile(file);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/0 registros/);
  });
});

describe("Validator — campos requeridos", () => {
  it("acepta un array con un registro válido completo", () => {
    const file = writeFixture("valid.json", [makeValidRecord()]);
    const result = validateExtractorFile(file, 1);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rechaza registro con CLEE vacío", () => {
    const file = writeFixture("no-clee.json", [makeValidRecord({ CLEE: "" })]);
    const result = validateExtractorFile(file, 1);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("CLEE"))).toBe(true);
  });

  it("rechaza registro con Nombre vacío", () => {
    const file = writeFixture("no-nombre.json", [makeValidRecord({ Nombre: "" })]);
    const result = validateExtractorFile(file, 1);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("nombre"))).toBe(true);
  });

  it("rechaza registro con coordenadas inválidas (no parseables)", () => {
    const file = writeFixture("bad-coords.json", [
      makeValidRecord({ Latitud: "N/A", Longitud: "N/A" }),
    ]);
    const result = validateExtractorFile(file, 1);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("latitud") || e.includes("longitud"))).toBe(true);
  });
});

describe("Validator — sampleSize", () => {
  it("sampleSize no excede el total de registros", () => {
    const records = [makeValidRecord(), makeValidRecord({ CLEE: "0900100010002", Id: "124" })];
    const file = writeFixture("two.json", records);
    const result = validateExtractorFile(file, 10); // pide 10 pero solo hay 2
    expect(result.sampleSize).toBe(2);
    expect(result.totalRecords).toBe(2);
  });

  it("sampleSize=1 funciona correctamente", () => {
    const file = writeFixture("one.json", [makeValidRecord()]);
    const result = validateExtractorFile(file, 1);
    expect(result.sampleSize).toBe(1);
    expect(result.valid).toBe(true);
  });
});
