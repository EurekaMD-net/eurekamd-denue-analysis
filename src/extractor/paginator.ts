/**
 * Paginator — extrae todos los registros de un estado de forma paginada.
 * Escribe a disco de forma incremental (streaming) para evitar acumulación en RAM.
 */

import fs from "node:fs";
import path from "node:path";
import type { DenueRawRecord, ExtractorConfig, EstadoClave } from "./types.js";
import { ESTADOS } from "./types.js";
import { DenueClient, DenueApiError } from "./denue-client.js";

export interface PaginatorResult {
  estado: string;
  clave: EstadoClave;
  /** Always 0 — Cuantificar endpoint returns HTTP 501. Count comes from totalExtraido. */
  totalEsperado: number;
  totalExtraido: number;
  paginas: number;
  errores: number;
  duracionMs: number;
  outputFile: string;
}

export interface PaginatorProgress {
  clave: EstadoClave;
  nombre: string;
  pagina: number;
  totalPaginas: number;
  registrosExtraidos: number;
  totalEsperado: number;
}

export class Paginator {
  private readonly client: DenueClient;
  private readonly config: ExtractorConfig;
  private onProgress?: (progress: PaginatorProgress) => void;

  constructor(config: ExtractorConfig) {
    this.config = config;
    // Pass delayMs to set the global HTTP throttle shared across all instances
    this.client = new DenueClient(config.token, config.delayMs);
  }

  setProgressCallback(cb: (progress: PaginatorProgress) => void): void {
    this.onProgress = cb;
  }

  /**
   * Extrae todos los establecimientos de un estado.
   * Escribe el resultado a {outputDir}/{clave}_{nombre}.json de forma incremental.
   *
   * Uses open-ended pagination: fetches pages until the API returns an empty array.
   * The /Cuantificar endpoint returns HTTP 501 — do NOT call it.
   *
   * @param clave      - Clave de 2 dígitos del estado (ej: "09")
   * @param condicion  - Keyword de búsqueda o "todos" para sin filtro (default: "todos")
   */
  async extractEstado(
    clave: EstadoClave,
    condicion: string = "todos"
  ): Promise<PaginatorResult> {
    const nombre = ESTADOS[clave];
    const startTime = Date.now();
    let errores = 0;
    let totalExtraido = 0;
    let pagina = 0;

    // Prepare output file for incremental streaming writes (avoids RAM accumulation)
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    const filename = `${clave}_${nombre.replace(/\s+/g, "_").toLowerCase()}.json`;
    const outputFile = path.join(this.config.outputDir, filename);
    const stream = fs.createWriteStream(outputFile, { encoding: "utf-8" });
    stream.write("[\n");
    let firstRecord = true;

    // Open-ended pagination: keep fetching until the API returns [] or null.
    // totalPaginas is unknown upfront (Cuantificar returns 501), so we use -1 as sentinel.
    while (true) {
      pagina++;
      const registroInicial = (pagina - 1) * this.config.pageSize + 1;
      const registroFinal = pagina * this.config.pageSize;

      this.onProgress?.({
        clave,
        nombre,
        pagina,
        totalPaginas: -1,             // unknown until the loop ends
        registrosExtraidos: totalExtraido,
        totalEsperado: 0,             // unknown — Cuantificar is broken
      });

      try {
        const records = await this.client.buscarEntidad(
          clave,
          registroInicial,
          registroFinal,
          condicion
        );

        if (records.length === 0) {
          // Empty page = end of data
          break;
        }

        for (const record of records) {
          if (!firstRecord) stream.write(",\n");
          stream.write(JSON.stringify(record));
          firstRecord = false;
        }
        totalExtraido += records.length;

        // If the page came back shorter than pageSize, this is the last page
        if (records.length < this.config.pageSize) {
          break;
        }
      } catch (err) {
        errores++;
        const msg = err instanceof DenueApiError ? err.message : String(err);
        console.error(
          `[Paginator] Error en ${nombre} página ${pagina}: ${msg}`
        );

        // Structural error (invalid token) — abort immediately
        if (err instanceof DenueApiError && err.statusCode === 401) {
          stream.end("\n]");
          throw err;
        }
        // For transient errors, stop the loop (we can't know if there's more data)
        break;
      }

      // Rate limiting between requests
      await sleep(this.config.delayMs);
    }

    // Close the JSON array and stream safely
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end("\n]", resolve);
    });

    return {
      estado: nombre,
      clave,
      totalEsperado: 0,   // Cuantificar is broken — always 0
      totalExtraido,
      paginas: pagina,
      errores,
      duracionMs: Date.now() - startTime,
      outputFile,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
