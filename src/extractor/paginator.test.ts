import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Paginator } from "./paginator.js";
import type { ExtractorConfig } from "./types.js";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

// Shape matches real API response (verified 2026-05-03, tests/fixtures/denue-real-09-sample.json)
const MOCK_ESTABLISHMENT = {
  CLEE: "09016541110003013001000000U0",
  Id: "1",
  Nombre: "TEST EMPRESA",
  Razon_social: "TEST SA DE CV",
  Clase_actividad: "Farmacias sin minisúper",
  Estrato: "1 a 5 personas",
  Tipo_vialidad: "CALLE",
  Calle: "REFORMA",
  Num_Exterior: "1",
  Num_Interior: "",
  Colonia: "JUÁREZ",
  CP: "06600",
  Ubicacion: "CUAUHTÉMOC, Cuauhtémoc, CIUDAD DE MÉXICO",
  Telefono: "",
  Correo_e: "",
  Sitio_internet: "",
  Tipo: "Fijo",
  Longitud: "-99.16",
  Latitud: "19.42",
  tipo_corredor_industrial: "",
  nom_corredor_industrial: "",
  numero_local: "SN",
};

function makeConfig(outputDir: string): ExtractorConfig {
  return {
    token: "test-token",
    pageSize: 2, // pequeño para probar paginación en tests
    delayMs: 0, // sin espera en tests
    maxRetries: 1,
    outputDir,
  };
}

// ─── Mock del DenueClient ─────────────────────────────────────────────────────
// IMPORTANTE: vitest requiere function() para mocks de clases (no arrow functions)
//
// Open-ended pagination: paginator calls buscarEntidad in a loop until it gets [].
// We simulate 5 real records spread over 3 pages (pageSize=2), then an empty page.

vi.mock("./denue-client.js", () => {
  const TOTAL_RECORDS = 5;
  const mockBuscar = vi.fn().mockImplementation(function (
    _entidad: string,
    inicio: number,
    fin: number,
  ) {
    // Return records that fall within [inicio, fin], stop at TOTAL_RECORDS
    const start = inicio - 1; // convert to 0-based
    const end = Math.min(fin - 1, TOTAL_RECORDS - 1); // cap at last real record
    if (start > end) return Promise.resolve([]); // past the end → empty page
    return Promise.resolve(
      Array.from({ length: end - start + 1 }, (_, i) => ({
        ...MOCK_ESTABLISHMENT,
        Id: String(inicio + i),
      })),
    );
  });

  return {
    DenueClient: vi.fn().mockImplementation(function () {
      return { buscarEntidad: mockBuscar };
    }),
    DenueApiError: class DenueApiError extends Error {
      statusCode?: number;
      constructor(msg: string, code?: number) {
        super(msg);
        this.name = "DenueApiError";
        this.statusCode = code;
      }
    },
    // Expose mock for per-test overrides
    __mockBuscar: mockBuscar,
  };
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("Paginator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extrae todos los registros paginando correctamente", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "denue-test-"));
    const paginator = new Paginator(makeConfig(tmpDir));

    const result = await paginator.extractEstado("09");

    // totalEsperado is always 0 (Cuantificar is broken — open-ended pagination)
    expect(result.totalEsperado).toBe(0);
    expect(result.totalExtraido).toBe(5);
    // Page 1: [1,2], Page 2: [3,4], Page 3: [5] (shorter than pageSize → early exit, no 4th call)
    expect(result.paginas).toBe(3);
    expect(result.errores).toBe(0);
    expect(result.estado).toBe("Ciudad de México");
  });

  it("escribe el archivo JSON en el directorio de salida", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "denue-test-"));
    const paginator = new Paginator(makeConfig(tmpDir));

    const result = await paginator.extractEstado("09");

    expect(result.outputFile).toBeTruthy();
    expect(fs.existsSync(result.outputFile)).toBe(true);

    const content = JSON.parse(
      fs.readFileSync(result.outputFile, "utf-8"),
    ) as unknown[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(5);
  });

  it("el callback de progreso se llama por cada página incluyendo la terminator", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "denue-test-"));
    const paginator = new Paginator(makeConfig(tmpDir));

    const progressCalls: number[] = [];
    paginator.setProgressCallback(({ pagina }) => {
      progressCalls.push(pagina);
    });

    await paginator.extractEstado("09");

    // 5 records / pageSize=2 → pages 1(2), 2(2), 3(1 short → breaks early)
    // Short page (length < pageSize) triggers early break, so only 3 callbacks
    expect(progressCalls).toEqual([1, 2, 3]);
  });

  it("retorna 0 registros si la primera página devuelve vacío", async () => {
    // Override buscarEntidad to always return [] (simulates estado with no data)
    const mod = (await import("./denue-client.js")) as unknown as {
      __mockBuscar: ReturnType<typeof vi.fn>;
    };
    mod.__mockBuscar.mockResolvedValueOnce([]);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "denue-test-"));
    const paginator = new Paginator(makeConfig(tmpDir));

    const result = await paginator.extractEstado("01");

    expect(result.totalExtraido).toBe(0);
    expect(result.paginas).toBe(1); // tried page 1, got [], stopped
    // outputFile is still created (empty JSON array [])
    expect(result.outputFile).toBeTruthy();
    expect(fs.existsSync(result.outputFile)).toBe(true);
  });

  it("M1: lanza error si una página falla mid-extracción (no silent break)", async () => {
    // Mock: page 1 succeeds with full pageSize, page 2 throws.
    // Pre-fix behavior: silently breaks, returns success with partial data.
    // Post-fix: throws so orchestrator marks estado failed and operator can --retry-failed.
    const mod = (await import("./denue-client.js")) as unknown as {
      __mockBuscar: ReturnType<typeof vi.fn>;
    };
    mod.__mockBuscar.mockReset();
    mod.__mockBuscar
      .mockResolvedValueOnce([
        { ...MOCK_ESTABLISHMENT, Id: "1" },
        { ...MOCK_ESTABLISHMENT, Id: "2" },
      ])
      .mockRejectedValueOnce(new Error("simulated network blip on page 2"));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "denue-test-"));
    const paginator = new Paginator(makeConfig(tmpDir));

    await expect(paginator.extractEstado("01")).rejects.toThrow(
      /Extracción interrumpida/,
    );

    // Output file is still left on disk as a closed JSON array (partial but valid)
    const outputFile = path.join(tmpDir, "01_aguascalientes.json");
    expect(fs.existsSync(outputFile)).toBe(true);
    const content = JSON.parse(
      fs.readFileSync(outputFile, "utf-8"),
    ) as unknown[];
    expect(content).toHaveLength(2); // page 1's 2 records
  });
});
