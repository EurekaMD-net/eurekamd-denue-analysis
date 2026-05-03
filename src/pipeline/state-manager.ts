/**
 * StateManager — Fase 3
 *
 * Persiste el progreso de la extracción nacional en un archivo JSON local
 * (pipeline-state.json en stateDir — separado de outputDir). Sin dependencias adicionales.
 *
 * Invariante de reanudabilidad: si el proceso muere a mitad, el próximo
 * run salta estados "done" y retoma desde "running" → "pending".
 * Estados "running" al arrancar se resetean a "pending" (crash recovery).
 */

import fs from "node:fs";
import path from "node:path";
import type { EstadoClave } from "../extractor/types.js";
import { ESTADOS } from "../extractor/types.js";

export type EstadoStatus = "pending" | "running" | "done" | "failed";

export interface EstadoState {
  clave: EstadoClave;
  nombre: string;
  status: EstadoStatus;
  records_extracted: number;
  records_loaded: number;
  started_at: string | null;
  finished_at: string | null;
  error: string | null;
}

export interface PipelineState {
  version: number;
  created_at: string;
  updated_at: string;
  estados: Record<EstadoClave, EstadoState>;
}

const STATE_FILE = "pipeline-state.json";
const STATE_VERSION = 1;

export class StateManager {
  private readonly stateFile: string;
  private state: PipelineState;

  constructor(stateDir: string) {
    this.stateFile = path.join(stateDir, STATE_FILE);
    this.state = this.loadOrInit();
  }

  // ---------------------------------------------------------------------------
  // Inicialización
  // ---------------------------------------------------------------------------

  private loadOrInit(): PipelineState {
    if (fs.existsSync(this.stateFile)) {
      const raw = fs.readFileSync(this.stateFile, "utf-8");
      const loaded = JSON.parse(raw) as PipelineState;
      // Crash recovery: cualquier estado "running" al cargar = crash anterior
      for (const estado of Object.values(loaded.estados)) {
        if (estado.status === "running") {
          estado.status = "pending";
          estado.started_at = null;
          estado.error = "reset: crash recovery (status was 'running' on startup)";
        }
      }
      loaded.updated_at = new Date().toISOString();
      return loaded;
    }
    return this.initFresh();
  }

  private initFresh(): PipelineState {
    const now = new Date().toISOString();
    const estados = {} as Record<EstadoClave, EstadoState>;

    for (const [clave, nombre] of Object.entries(ESTADOS)) {
      estados[clave as EstadoClave] = {
        clave: clave as EstadoClave,
        nombre,
        status: "pending",
        records_extracted: 0,
        records_loaded: 0,
        started_at: null,
        finished_at: null,
        error: null,
      };
    }

    return { version: STATE_VERSION, created_at: now, updated_at: now, estados };
  }

  // ---------------------------------------------------------------------------
  // Persistencia
  // ---------------------------------------------------------------------------

  private persist(): void {
    this.state.updated_at = new Date().toISOString();
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), "utf-8");
  }

  // ---------------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------------

  /** Devuelve el estado actual de un estado específico */
  getEstado(clave: EstadoClave): EstadoState {
    return this.state.estados[clave];
  }

  /** Lista todos los estados con un status dado */
  getByStatus(status: EstadoStatus): EstadoState[] {
    return Object.values(this.state.estados).filter((e) => e.status === status);
  }

  /** Todos los estados en orden de clave */
  getAll(): EstadoState[] {
    return Object.values(this.state.estados).sort((a, b) =>
      a.clave.localeCompare(b.clave)
    );
  }

  markRunning(clave: EstadoClave): void {
    this.state.estados[clave].status = "running";
    this.state.estados[clave].started_at = new Date().toISOString();
    this.state.estados[clave].error = null;
    this.persist();
  }

  markDone(clave: EstadoClave, extracted: number, loaded: number): void {
    const e = this.state.estados[clave];
    e.status = "done";
    e.records_extracted = extracted;
    e.records_loaded = loaded;
    e.finished_at = new Date().toISOString();
    e.error = null;
    this.persist();
  }

  markFailed(clave: EstadoClave, error: string): void {
    const e = this.state.estados[clave];
    e.status = "failed";
    e.finished_at = new Date().toISOString();
    e.error = error;
    this.persist();
  }

  /** Resetea estados "failed" a "pending" para reintento */
  resetFailed(): number {
    let count = 0;
    for (const e of Object.values(this.state.estados)) {
      if (e.status === "failed") {
        e.status = "pending";
        e.error = null;
        e.started_at = null;
        e.finished_at = null;
        count++;
      }
    }
    this.persist();
    return count;
  }

  /** Resumen del progreso actual */
  summary(): { pending: number; running: number; done: number; failed: number; total: number } {
    const counts = { pending: 0, running: 0, done: 0, failed: 0, total: 32 };
    for (const e of Object.values(this.state.estados)) {
      counts[e.status]++;
    }
    return counts;
  }
}
