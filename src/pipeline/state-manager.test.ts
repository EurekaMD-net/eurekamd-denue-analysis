/**
 * Tests para StateManager — Fase 3
 *
 * Invariantes verificadas:
 * - Estado inicial: todos los 32 estados en "pending"
 * - markRunning → markDone: transiciones correctas
 * - Crash recovery: estados "running" al cargar → "pending"
 * - resetFailed: solo resetea los fallidos
 * - summary(): conteos precisos
 * - No re-procesa estados "done"
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { StateManager } from "./state-manager.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(`${tmpdir()}/state-manager-test-`);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("StateManager - inicialización", () => {
  it("debe inicializar los 32 estados en pending", () => {
    const sm = new StateManager(tmpDir);
    const all = sm.getAll();
    expect(all).toHaveLength(32);
    expect(all.every((e) => e.status === "pending")).toBe(true);
  });

  it("debe tener todos los campos iniciales en null", () => {
    const sm = new StateManager(tmpDir);
    const e = sm.getEstado("09");
    expect(e.started_at).toBeNull();
    expect(e.finished_at).toBeNull();
    expect(e.error).toBeNull();
    expect(e.records_extracted).toBe(0);
    expect(e.records_loaded).toBe(0);
  });

  it("summary inicial: 32 pending, 0 resto", () => {
    const sm = new StateManager(tmpDir);
    const s = sm.summary();
    expect(s.pending).toBe(32);
    expect(s.done).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.running).toBe(0);
    expect(s.total).toBe(32);
  });
});

describe("StateManager - transiciones", () => {
  it("markRunning → estado es 'running', started_at poblado", () => {
    const sm = new StateManager(tmpDir);
    sm.markRunning("09");
    const e = sm.getEstado("09");
    expect(e.status).toBe("running");
    expect(e.started_at).not.toBeNull();
  });

  it("markDone → estado es 'done' con conteos correctos", () => {
    const sm = new StateManager(tmpDir);
    sm.markRunning("09");
    sm.markDone("09", 600000, 599850);
    const e = sm.getEstado("09");
    expect(e.status).toBe("done");
    expect(e.records_extracted).toBe(600000);
    expect(e.records_loaded).toBe(599850);
    expect(e.finished_at).not.toBeNull();
    expect(e.error).toBeNull();
  });

  it("markFailed → estado es 'failed' con mensaje de error", () => {
    const sm = new StateManager(tmpDir);
    sm.markRunning("15");
    sm.markFailed("15", "timeout después de 30s");
    const e = sm.getEstado("15");
    expect(e.status).toBe("failed");
    expect(e.error).toBe("timeout después de 30s");
    expect(e.finished_at).not.toBeNull();
  });

  it("getByStatus('done') retorna solo los done", () => {
    const sm = new StateManager(tmpDir);
    sm.markRunning("01");
    sm.markDone("01", 10, 10);
    sm.markRunning("02");
    sm.markFailed("02", "error");
    const done = sm.getByStatus("done");
    expect(done).toHaveLength(1);
    expect(done[0]!.clave).toBe("01");
  });
});

describe("StateManager - persistencia y crash recovery", () => {
  it("persiste estado a disco y lo recarga correctamente", () => {
    const sm1 = new StateManager(tmpDir);
    sm1.markRunning("09");
    sm1.markDone("09", 100, 99);

    // Segunda instancia lee el mismo directorio
    const sm2 = new StateManager(tmpDir);
    const e = sm2.getEstado("09");
    expect(e.status).toBe("done");
    expect(e.records_extracted).toBe(100);
    expect(e.records_loaded).toBe(99);
  });

  it("crash recovery: estados 'running' al cargar → 'pending'", () => {
    const sm1 = new StateManager(tmpDir);
    sm1.markRunning("09");
    sm1.markRunning("15");
    // No marcamos done — simula crash

    const sm2 = new StateManager(tmpDir);
    expect(sm2.getEstado("09").status).toBe("pending");
    expect(sm2.getEstado("15").status).toBe("pending");
  });

  it("estados 'done' NO se resetean en crash recovery", () => {
    const sm1 = new StateManager(tmpDir);
    sm1.markRunning("01");
    sm1.markDone("01", 5, 5);
    sm1.markRunning("09"); // crash aquí

    const sm2 = new StateManager(tmpDir);
    expect(sm2.getEstado("01").status).toBe("done");   // intacto
    expect(sm2.getEstado("09").status).toBe("pending"); // reseteado
  });
});

describe("StateManager - resetFailed", () => {
  it("resetFailed devuelve el conteo de estados reseteados", () => {
    const sm = new StateManager(tmpDir);
    sm.markRunning("01");
    sm.markFailed("01", "e1");
    sm.markRunning("02");
    sm.markFailed("02", "e2");

    const count = sm.resetFailed();
    expect(count).toBe(2);
    expect(sm.getEstado("01").status).toBe("pending");
    expect(sm.getEstado("02").status).toBe("pending");
  });

  it("resetFailed no toca los estados 'done'", () => {
    const sm = new StateManager(tmpDir);
    sm.markRunning("01");
    sm.markDone("01", 5, 5);
    sm.markRunning("02");
    sm.markFailed("02", "error");

    sm.resetFailed();
    expect(sm.getEstado("01").status).toBe("done"); // intacto
  });

  it("resetFailed en estado limpio devuelve 0", () => {
    const sm = new StateManager(tmpDir);
    expect(sm.resetFailed()).toBe(0);
  });
});

describe("StateManager - getAll ordenado", () => {
  it("getAll() retorna 32 estados ordenados por clave", () => {
    const sm = new StateManager(tmpDir);
    const all = sm.getAll();
    expect(all[0]!.clave).toBe("01");
    expect(all[31]!.clave).toBe("32");
  });
});
