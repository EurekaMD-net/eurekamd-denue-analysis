/**
 * Tests de integración del pipeline — Fase 3
 *
 * Invariante central: el seam extractor→loader→Supabase funciona de punta a punta.
 * Usa el fixture real (denue-real-09-sample.json) para probar la cadena completa
 * sin llamadas a la API DENUE ni a Supabase real.
 *
 * Flujo: fixture → readExtractorOutput → loadRecords (fetch stubbed) → assert payload
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { validateExtractorFile } from "../../src/pipeline/validator.js";
import { readExtractorOutput, loadRecords } from "../../src/db/loader.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/pipeline-integration-test-`);
  vi.restoreAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const REAL_FIXTURE = resolve(process.cwd(), "tests/fixtures/denue-real-09-sample.json");

describe("Pipeline integration — fixture real", () => {
  it("el fixture real pasa validación", () => {
    const result = validateExtractorFile(REAL_FIXTURE, 5);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.totalRecords).toBeGreaterThan(0);
  });

  it("readExtractorOutput parsea el fixture real en DenueRawRecord[]", () => {
    const records = readExtractorOutput(REAL_FIXTURE);
    expect(Array.isArray(records)).toBe(true);
    expect(records.length).toBeGreaterThan(0);

    // Todos los registros tienen CLEE poblado
    for (const r of records) {
      expect(r.CLEE).toBeTruthy();
      expect(typeof r.CLEE).toBe("string");
    }
  });

  it("loadRecords transforma el fixture real y envía payload con campos críticos no-null", async () => {
    const records = readExtractorOutput(REAL_FIXTURE);

    // Capturar el body enviado a fetch
    const capturedBodies: unknown[] = [];
    const mockFetch = vi.fn().mockImplementation(async (_url: unknown, options: { body?: string }) => {
      if (options?.body) {
        capturedBodies.push(JSON.parse(options.body as string));
      }
      return {
        ok: true,
        json: async () => records.map((_, i) => ({ id: i + 1 })),
      } as Response;
    });

    vi.stubGlobal("fetch", mockFetch);

    const result = await loadRecords(records, {
      supabaseUrl: "http://localhost:8100",
      serviceRoleKey: "test-key",
      batchSize: 1000, // un solo batch para el fixture de 5 registros
    });

    expect(mockFetch).toHaveBeenCalled();
    expect(result.errors).toHaveLength(0);

    // Inspeccionar el payload del primer (y único) batch
    const payload = capturedBodies[0] as Array<Record<string, unknown>>;
    expect(Array.isArray(payload)).toBe(true);
    expect(payload.length).toBe(records.length);

    // Cada fila debe tener los campos críticos no-null
    for (const row of payload) {
      expect(row["clee"]).toBeTruthy();                    // CLEE siempre presente
      expect(row["nombre"]).toBeTruthy();                   // Nombre del establecimiento
      expect(row["clase_actividad"]).toBeTruthy();          // Actividad SCIAN
      expect(row["entidad"]).toBeTruthy();                  // Derivado del CLEE
      expect(typeof row["latitud"]).toBe("number");         // Coordenada numérica
      expect(typeof row["longitud"]).toBe("number");        // Coordenada numérica
      // raw_json debe ser objeto (no string) para que PostgreSQL lo trate como JSONB
      expect(typeof row["raw_json"]).toBe("object");
      expect(row["raw_json"]).not.toBeNull();
    }
  });

  it("entidad se extrae del CLEE (primeros 2 chars) para todos los registros del fixture", async () => {
    const records = readExtractorOutput(REAL_FIXTURE);
    const { transform } = await importTransform();
    for (const r of records) {
      const row = transform(r);
      expect(row.entidad).toBe(r.CLEE.slice(0, 2));
    }
  });

  it("municipio se extrae del primer segmento de Ubicacion", async () => {
    const records = readExtractorOutput(REAL_FIXTURE);
    const { transform } = await importTransform();
    for (const r of records) {
      if (!r.Ubicacion) continue;
      const row = transform(r);
      const expectedMunicipio = r.Ubicacion.split(",")[0]!.trim();
      expect(row.municipio).toBe(expectedMunicipio);
    }
  });
});

describe("Pipeline integration — estado con 2 registros (uno válido, uno sin CLEE)", () => {
  it("registros sin CLEE se filtran y no contaminan el batch", async () => {
    const rawFixture = readFileSync(REAL_FIXTURE, "utf-8");
    const records = JSON.parse(rawFixture) as Array<Record<string, unknown>>;

    // Agregar un registro corrupto sin CLEE
    const corrupted = [...records, { ...records[0], CLEE: "" }];
    const testFile = resolve(tmpDir, "corrupted.json");
    writeFileSync(testFile, JSON.stringify(corrupted), "utf-8");

    const loaded = readExtractorOutput(testFile);
    const capturedBodies: unknown[] = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (_url: unknown, options: { body?: string }) => {
      if (options?.body) capturedBodies.push(JSON.parse(options.body as string));
      return { ok: true, json: async () => [] } as unknown as Response;
    }));

    await loadRecords(loaded, {
      supabaseUrl: "http://localhost:8100",
      serviceRoleKey: "test-key",
      batchSize: 1000,
    });

    // El payload debe tener records.length (originales) — el corrupto fue filtrado
    const payload = capturedBodies[0] as unknown[];
    expect(payload?.length).toBe(records.length);
  });
});

// ---------------------------------------------------------------------------
// Helper para import dinámico de transform (que no es re-exported por default
// en tests anteriores)
// ---------------------------------------------------------------------------
async function importTransform() {
  const mod = await import("../../src/db/loader.js");
  return { transform: mod.transform };
}
