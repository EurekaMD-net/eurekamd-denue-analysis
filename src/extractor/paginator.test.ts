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
    pageSize: 2,   // pequeño para probar paginación en tests
    delayMs: 0,    // sin espera en tests
    maxRetries: 1,
    outputDir,
  };
}

// ─── Mock del DenueClient ─────────────────────────────────────────────────────
// IMPORTANTE: vitest requiere function() para mocks de clases (no arrow functions)

vi.mock("./denue-client.js", () => {
  const mockCuantificar = vi.fn().mockResolvedValue(5);
  const mockBuscar = vi.fn().mockImplementation(function(
    _entidad: string, inicio: number, fin: number
  ) {
    const count = Math.min(fin, 5) - inicio + 1;
    return Promise.resolve(
      Array.from({ length: count }, (_, i) => ({
        ...MOCK_ESTABLISHMENT,
        Id: String(inicio + i),
      }))
    );
  });

  return {
    DenueClient: vi.fn().mockImplementation(function() {
      return {
        cuantificarEntidad: mockCuantificar,
        buscarEntidad: mockBuscar,
      };
    }),
    DenueApiError: class DenueApiError extends Error {
      constructor(msg: string) { super(msg); this.name = "DenueApiError"; }
    },
    // Exponer los mocks para poder resetearlos en tests individuales
    __mockCuantificar: mockCuantificar,
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

    expect(result.totalEsperado).toBe(5);
    expect(result.totalExtraido).toBe(5);
    expect(result.paginas).toBe(3); // ceil(5/2)=3 páginas
    expect(result.errores).toBe(0);
    expect(result.estado).toBe("Ciudad de México");
  });

  it("escribe el archivo JSON en el directorio de salida", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "denue-test-"));
    const paginator = new Paginator(makeConfig(tmpDir));

    const result = await paginator.extractEstado("09");

    expect(result.outputFile).toBeTruthy();
    expect(fs.existsSync(result.outputFile)).toBe(true);

    const content = JSON.parse(fs.readFileSync(result.outputFile, "utf-8")) as unknown[];
    expect(Array.isArray(content)).toBe(true);
    expect(content).toHaveLength(5);
  });

  it("el callback de progreso se llama por cada página", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "denue-test-"));
    const paginator = new Paginator(makeConfig(tmpDir));

    const progressCalls: number[] = [];
    paginator.setProgressCallback(({ pagina }) => {
      progressCalls.push(pagina);
    });

    await paginator.extractEstado("09");

    // 5 registros / 2 por página = 3 páginas → 3 callbacks
    expect(progressCalls).toEqual([1, 2, 3]);
  });

  it("retorna outputFile vacío y cero registros si cuantificar devuelve 0", async () => {
    // Importamos el mock para cambiar el retorno de cuantificar en este test
    const mod = await import("./denue-client.js") as unknown as {
      __mockCuantificar: ReturnType<typeof vi.fn>;
    };
    mod.__mockCuantificar.mockResolvedValueOnce(0);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "denue-test-"));
    const paginator = new Paginator(makeConfig(tmpDir));

    const result = await paginator.extractEstado("01");

    expect(result.totalExtraido).toBe(0);
    expect(result.paginas).toBe(0);
    expect(result.outputFile).toBe("");
  });
});
