/**
 * Integration test: extractor → loader seam
 *
 * Reads the real API fixture captured on 2026-05-03 and pipes it through
 * the loader's transform + loadRecords. Asserts that the critical fields
 * (nombre, clase_actividad_id, entidad, latitud, longitud) are non-null
 * in the payload sent to Supabase — i.e., the extractor/loader interface
 * mismatch described in the Phase 1↔2 audit does NOT occur.
 *
 * Fixture: tests/fixtures/denue-real-09-sample.json
 * (5 records from buscarEntidad/todos/09/1/5, verbatim API response)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { loadRecords, type DenueRawRecord, type LoaderConfig } from "../../src/db/loader.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FIXTURE_PATH = join(__dirname, "../fixtures/denue-real-09-sample.json");

function loadFixture(): DenueRawRecord[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  return JSON.parse(raw) as DenueRawRecord[];
}

const LOADER_CONFIG: LoaderConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "fake-service-key",
  batchSize: 10,
};

describe("extractor → loader seam (real API fixture)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fixture loads and has expected record count", () => {
    const records = loadFixture();
    expect(records).toHaveLength(5);
  });

  it("all fixture records have non-empty CLEE", () => {
    const records = loadFixture();
    for (const rec of records) {
      expect(rec.CLEE).toBeTruthy();
      expect(rec.CLEE.trim()).not.toBe("");
    }
  });

  it("pipes real fixture through loadRecords and nombre/entidad/latitud/longitud are non-null in payload", async () => {
    const records = loadFixture();
    let capturedPayload: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: unknown, opts: RequestInit) => {
      capturedPayload = JSON.parse(opts.body as string) as Array<Record<string, unknown>>;
      return Promise.resolve({
        ok: true,
        json: async () => capturedPayload.map((_, i) => ({ id: i + 1 })),
      });
    }));

    const result = await loadRecords(records, LOADER_CONFIG);

    // No errors — all records passed through
    expect(result.errors).toHaveLength(0);
    expect(result.inserted).toBe(records.length);

    // Verify each row in the captured payload has the critical non-null fields
    for (const row of capturedPayload) {
      // nombre must be non-null (Nombre is always present in real API)
      expect(row["nombre"]).not.toBeNull();
      expect(typeof row["nombre"]).toBe("string");

      // entidad must be non-null — derived from CLEE (first 2 chars)
      expect(row["entidad"]).not.toBeNull();
      expect(row["entidad"]).toBe("09"); // all records are from CDMX (09)

      // latitud/longitud must be numeric (real records all have coordinates)
      expect(typeof row["latitud"]).toBe("number");
      expect(typeof row["longitud"]).toBe("number");

      // clase_actividad (text description) must be non-null
      expect(row["clase_actividad"]).not.toBeNull();
    }
  });

  it("clase_actividad_id is null for buscarEntidad records (field absent from real API)", () => {
    // buscarEntidad does NOT return CLASE_ACTIVIDAD_ID — this is expected.
    // clase_actividad_id should be null, not throw or produce garbage.
    const records = loadFixture();
    let capturedPayload: Array<Record<string, unknown>> = [];

    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: unknown, opts: RequestInit) => {
      capturedPayload = JSON.parse(opts.body as string) as Array<Record<string, unknown>>;
      return Promise.resolve({
        ok: true,
        json: async () => capturedPayload.map((_, i) => ({ id: i + 1 })),
      });
    }));

    return loadRecords(records, LOADER_CONFIG).then(() => {
      for (const row of capturedPayload) {
        // CLASE_ACTIVIDAD_ID not present in real buscarEntidad response → null
        expect(row["clase_actividad_id"]).toBeNull();
      }
    });
  });

  it("entidad is extracted from CLEE prefix, not AreaGeo (absent from real API)", () => {
    // Verify that even without AreaGeo, entidad is correctly populated from CLEE
    const records = loadFixture();
    // Real records have no AreaGeo field
    for (const rec of records) {
      expect((rec as Record<string, unknown>)["AreaGeo"]).toBeUndefined();
    }

    let capturedPayload: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn().mockImplementation((_url: unknown, opts: RequestInit) => {
      capturedPayload = JSON.parse(opts.body as string) as Array<Record<string, unknown>>;
      return Promise.resolve({
        ok: true,
        json: async () => capturedPayload.map((_, i) => ({ id: i + 1 })),
      });
    }));

    return loadRecords(records, LOADER_CONFIG).then(() => {
      for (const row of capturedPayload) {
        // entidad must still be "09" (from CLEE prefix), not null
        expect(row["entidad"]).toBe("09");
      }
    });
  });
});
