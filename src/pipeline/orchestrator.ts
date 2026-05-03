/**
 * Orchestrator — Fase 3
 *
 * Loop principal de extracción nacional. Itera los 32 estados con concurrencia
 * controlada. Cada estado sigue el ciclo: extract → validate → load → mark done.
 *
 * Reanudable: los estados "done" se saltan automáticamente. Los "failed" se
 * omiten en ejecución normal (usar --retry-failed para reintentarlos).
 */

import type { EstadoClave, ExtractorConfig } from "../extractor/types.js";
import { Paginator } from "../extractor/paginator.js";
import { loadRecords, readExtractorOutput, updateGeometry } from "../db/loader.js";
import type { LoaderConfig } from "../db/loader.js";
import { validateExtractorFile } from "./validator.js";
import { StateManager } from "./state-manager.js";

export interface OrchestratorConfig {
  extractorConfig: ExtractorConfig;
  loaderConfig: LoaderConfig;
  /** Número de estados en paralelo (default: 1 — seguro para rate limit de INEGI) */
  concurrency?: number;
  /** Solo procesar estos estados (subset). Si vacío, procesa todos. */
  states?: EstadoClave[];
  /** Si true, resetea estados "failed" y los reintenta */
  retryFailed?: boolean;
  /** Si true, actualiza geometrías PostGIS al final del pipeline */
  updateGeomAtEnd?: boolean;
}

export interface OrchestratorResult {
  totalDone: number;
  totalFailed: number;
  totalSkipped: number;
  totalRecordsLoaded: number;
  durationMs: number;
}

export interface EstadoRunResult {
  clave: EstadoClave;
  success: boolean;
  recordsExtracted: number;
  recordsLoaded: number;
  error?: string;
}

export class Orchestrator {
  private readonly stateManager: StateManager;

  constructor(private readonly config: OrchestratorConfig) {
    this.stateManager = new StateManager(config.extractorConfig.outputDir);
  }

  /**
   * Ejecuta el pipeline para los estados seleccionados.
   */
  async run(): Promise<OrchestratorResult> {
    const startMs = Date.now();
    const { concurrency = 1, states, retryFailed = false, updateGeomAtEnd = false } = this.config;

    // Opcionalmente resetear estados fallidos
    if (retryFailed) {
      const reset = this.stateManager.resetFailed();
      if (reset > 0) {
        process.stderr.write(`[Orchestrator] ${reset} estados reseteados a 'pending' para reintento\n`);
      }
    }

    // Determinar qué estados procesar
    const allStates = this.stateManager.getAll();
    const targets = allStates.filter((e) => {
      if (states && states.length > 0 && !states.includes(e.clave)) return false;
      return e.status === "pending";
    });

    const skipped = allStates.filter((e) => {
      if (states && states.length > 0 && !states.includes(e.clave)) return false;
      return e.status === "done";
    }).length;

    process.stderr.write(
      `[Orchestrator] ${targets.length} estados a procesar, ${skipped} ya completados, concurrencia=${concurrency}\n`
    );

    // Procesar en chunks de tamaño `concurrency`
    let totalDone = 0;
    let totalFailed = 0;
    let totalRecordsLoaded = 0;

    for (let i = 0; i < targets.length; i += concurrency) {
      const chunk = targets.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map((e) => this.processEstado(e.clave)));

      for (const r of results) {
        if (r.success) {
          totalDone++;
          totalRecordsLoaded += r.recordsLoaded;
        } else {
          totalFailed++;
        }
      }

      const summary = this.stateManager.summary();
      process.stderr.write(
        `\r[Orchestrator] Progreso: ${summary.done} ✅ / ${summary.failed} ❌ / ${summary.pending} ⏳ de ${summary.total}    `
      );
    }

    process.stderr.write("\n");

    // Actualizar geometrías al final si se pide
    if (updateGeomAtEnd && totalDone > 0) {
      process.stderr.write("[Orchestrator] Actualizando geometrías PostGIS...\n");
      await updateGeometry(this.config.loaderConfig);
    }

    return {
      totalDone,
      totalFailed,
      totalSkipped: skipped,
      totalRecordsLoaded,
      durationMs: Date.now() - startMs,
    };
  }

  /**
   * Procesa un estado: extract → validate → load → mark.
   * Nunca lanza — los errores se marcan en el state y se devuelve { success: false }.
   */
  async processEstado(clave: EstadoClave): Promise<EstadoRunResult> {
    this.stateManager.markRunning(clave);
    process.stderr.write(`[${clave}] Iniciando extracción...\n`);

    try {
      // 1. Extraer
      const paginator = new Paginator(this.config.extractorConfig);
      paginator.setProgressCallback((p) => {
        process.stderr.write(
          `\r[${clave}] Página ${p.pagina}/${p.totalPaginas} — ${p.registrosExtraidos.toLocaleString()}/${p.totalEsperado.toLocaleString()} registros  `
        );
      });

      const extractResult = await paginator.extractEstado(clave);
      process.stderr.write(`\n[${clave}] Extracción completa: ${extractResult.totalExtraido.toLocaleString()} registros → ${extractResult.outputFile}\n`);

      if (extractResult.totalExtraido === 0) {
        this.stateManager.markDone(clave, 0, 0);
        return { clave, success: true, recordsExtracted: 0, recordsLoaded: 0 };
      }

      // 2. Validar
      const validation = validateExtractorFile(extractResult.outputFile);
      if (!validation.valid) {
        const errMsg = `Validación fallida: ${validation.errors.join("; ")}`;
        process.stderr.write(`[${clave}] ❌ ${errMsg}\n`);
        this.stateManager.markFailed(clave, errMsg);
        return { clave, success: false, recordsExtracted: extractResult.totalExtraido, recordsLoaded: 0, error: errMsg };
      }

      process.stderr.write(`[${clave}] ✅ Validación OK (sample ${validation.sampleSize}/${validation.totalRecords})\n`);

      // 3. Cargar a Supabase
      const records = readExtractorOutput(extractResult.outputFile);
      const loadResult = await loadRecords(records, this.config.loaderConfig);

      if (loadResult.errors.length > 0) {
        process.stderr.write(`[${clave}] ⚠️  ${loadResult.errors.length} errores de carga\n`);
      }

      process.stderr.write(`[${clave}] ✅ Cargados: ${loadResult.inserted.toLocaleString()} registros en ${loadResult.durationMs}ms\n`);

      this.stateManager.markDone(clave, extractResult.totalExtraido, loadResult.inserted);
      return {
        clave,
        success: true,
        recordsExtracted: extractResult.totalExtraido,
        recordsLoaded: loadResult.inserted,
      };

    } catch (err) {
      const errMsg = (err as Error).message ?? String(err);
      process.stderr.write(`[${clave}] ❌ Error: ${errMsg}\n`);
      this.stateManager.markFailed(clave, errMsg);
      return { clave, success: false, recordsExtracted: 0, recordsLoaded: 0, error: errMsg };
    }
  }

  getStateManager(): StateManager {
    return this.stateManager;
  }
}
