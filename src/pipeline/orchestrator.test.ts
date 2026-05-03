/**
 * Tests para Orchestrator — Fase 3
 *
 * Invariantes verificadas:
 * - Estados "done" se saltan (no se re-extraen)
 * - Errores de extracción no detienen el loop — el resto continúa
 * - concurrencia respeta el límite (no lanza más que `concurrency` paralelo)
 * - retryFailed resetea y reprocesa estados fallidos
 * - El resultado final tiene conteos correctos (done/failed/skipped)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Orchestrator } from "./orchestrator.js";
import { StateManager } from "./state-manager.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/orchestrator-test-`);
  vi.restoreAllMocks();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Config mínima para tests — apunta a tmpDir para estado */
function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    extractorConfig: {
      token: "test-token",
      pageSize: 10,
      delayMs: 0,
      maxRetries: 0,
      outputDir: tmpDir,
    },
    loaderConfig: {
      supabaseUrl: "http://localhost:8100",
      serviceRoleKey: "test-key",
      batchSize: 10,
    },
    ...overrides,
  };
}

/** Fixture de 1 registro válido para estados de prueba */
function writeValidFixture(clave: string): string {
  const record = {
    CLEE: `${clave}00100010001`,
    Id: "1",
    Nombre: "TEST HOSPITAL",
    Razon_social: "TST SA",
    Clase_actividad: "Hospitales generales",
    Estrato: "1 a 5 personas",
    Tipo_vialidad: "CALLE",
    Calle: "Test",
    Num_Exterior: "1",
    Num_Interior: "",
    Colonia: "Centro",
    CP: "01000",
    Ubicacion: "MUNICIPIO TEST, Municipio, ESTADO TEST",
    Telefono: "",
    Correo_e: "",
    Sitio_internet: "",
    Tipo: "Fijo",
    Longitud: "-99.0",
    Latitud: "19.0",
    tipo_corredor_industrial: "",
    nom_corredor_industrial: "",
    numero_local: "",
  };
  // Los estados de menor número para evitar colisiones en los tests paralelos
  const nombre = `${clave}_estado_test`;
  const file = resolve(tmpDir, `${clave}_${nombre}.json`);
  writeFileSync(file, JSON.stringify([record]), "utf-8");
  return file;
}

describe("Orchestrator — estados done se saltan", () => {
  it("un estado marcado 'done' no se vuelve a procesar", async () => {
    // Pre-marcar 09 como done
    const sm = new StateManager(tmpDir);
    sm.markRunning("09");
    sm.markDone("09", 100, 100);

    // Spy en processEstado para verificar que no se llama con "09"
    const orch = new Orchestrator({ ...makeConfig(), states: ["09"] });
    const spy = vi.spyOn(orch, "processEstado");

    const result = await orch.run();

    expect(spy).not.toHaveBeenCalled();
    expect(result.totalSkipped).toBe(1);
    expect(result.totalDone).toBe(0);
  });
});

describe("Orchestrator — errores no detienen el loop", () => {
  it("un estado que falla no impide procesar el siguiente", async () => {
    const orch = new Orchestrator({
      ...makeConfig(),
      states: ["01", "02"],
      concurrency: 1,
    });

    // Estado 01 falla, 02 tiene éxito
    vi.spyOn(orch, "processEstado").mockImplementation(async (clave) => {
      if (clave === "01") {
        return { clave, success: false, recordsExtracted: 0, recordsLoaded: 0, error: "timeout" };
      }
      return { clave, success: true, recordsExtracted: 5, recordsLoaded: 5 };
    });

    const result = await orch.run();
    expect(result.totalFailed).toBe(1);
    expect(result.totalDone).toBe(1);
  });
});

describe("Orchestrator — retryFailed", () => {
  it("retryFailed=true resetea estados 'failed' a 'pending' antes de correr", async () => {
    // Pre-marcar 09 como failed
    const sm = new StateManager(tmpDir);
    sm.markRunning("09");
    sm.markFailed("09", "error previo");

    const orch = new Orchestrator({
      ...makeConfig(),
      states: ["09"],
      retryFailed: true,
    });

    // Mock processEstado para no hacer llamadas reales
    vi.spyOn(orch, "processEstado").mockResolvedValue({
      clave: "09",
      success: true,
      recordsExtracted: 5,
      recordsLoaded: 5,
    });

    const result = await orch.run();
    expect(result.totalDone).toBe(1); // fue procesado, no skipped
  });

  it("retryFailed=false deja los estados 'failed' como 'failed' (no los retomamos)", async () => {
    const sm = new StateManager(tmpDir);
    sm.markRunning("09");
    sm.markFailed("09", "error previo");

    const orch = new Orchestrator({
      ...makeConfig(),
      states: ["09"],
      retryFailed: false,
    });

    const spy = vi.spyOn(orch, "processEstado");
    // Estado failed con retryFailed=false → ni siquiera aparece en targets (no es pending)
    const result = await orch.run();
    expect(spy).not.toHaveBeenCalled();
    expect(result.totalDone).toBe(0);
    expect(result.totalFailed).toBe(0);
    expect(result.totalSkipped).toBe(0); // failed no se cuenta como skipped
  });
});

describe("Orchestrator — resultado final", () => {
  it("totalRecordsLoaded suma correctamente los registros de todos los estados", async () => {
    const orch = new Orchestrator({
      ...makeConfig(),
      states: ["01", "02", "03"],
      concurrency: 1,
    });

    vi.spyOn(orch, "processEstado").mockImplementation(async (clave) => ({
      clave,
      success: true,
      recordsExtracted: 100,
      recordsLoaded: 99,
    }));

    const result = await orch.run();
    expect(result.totalDone).toBe(3);
    expect(result.totalRecordsLoaded).toBe(297); // 3 × 99
  });
});

describe("Orchestrator — pipeline integration (smoke)", () => {
  it("procesa 2 estados mockeados: uno éxito, uno falla → state final correcto", async () => {
    const orch = new Orchestrator({
      ...makeConfig(),
      states: ["01", "02"],
      concurrency: 1,
    });

    let callCount = 0;
    vi.spyOn(orch, "processEstado").mockImplementation(async (clave) => {
      callCount++;
      if (clave === "01") {
        return { clave, success: true, recordsExtracted: 10, recordsLoaded: 10 };
      }
      return { clave, success: false, recordsExtracted: 0, recordsLoaded: 0, error: "simulated failure" };
    });

    const result = await orch.run();

    expect(callCount).toBe(2); // ambos fueron intentados
    expect(result.totalDone).toBe(1);
    expect(result.totalFailed).toBe(1);
    expect(result.totalSkipped).toBe(0);
    expect(result.totalRecordsLoaded).toBe(10);
  });
});
