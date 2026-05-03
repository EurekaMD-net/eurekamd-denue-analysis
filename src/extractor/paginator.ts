/**
 * Paginator — extrae todos los registros de un estado de forma paginada.
 * Maneja rate limiting, progreso y escritura incremental a disco.
 */

import fs from "node:fs";
import path from "node:path";
import type { DenueEstablishment, ExtractorConfig, EstadoClave } from "./types.js";
import { ESTADOS } from "./types.js";
import { DenueClient, DenueApiError } from "./denue-client.js";

export interface PaginatorResult {
  estado: string;
  clave: EstadoClave;
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
    this.client = new DenueClient(config.token);
  }

  setProgressCallback(cb: (progress: PaginatorProgress) => void): void {
    this.onProgress = cb;
  }

  /**
   * Extrae todos los establecimientos de un estado.
   * Escribe el resultado a {outputDir}/{clave}_{nombre}.json
   *
   * @param clave - Clave de 2 dígitos del estado (ej: "09")
   * @param condicion - Keyword de búsqueda (vacío = todos)
   * @param sector - Código SCIAN o "todos"
   */
  async extractEstado(
    clave: EstadoClave,
    condicion: string = "",
    sector: string = "todos"
  ): Promise<PaginatorResult> {
    const nombre = ESTADOS[clave];
    const startTime = Date.now();
    let errores = 0;

    // 1. Contar total de registros
    const totalEsperado = await this.client.cuantificarEntidad(clave, condicion, sector);

    if (totalEsperado === 0) {
      return {
        estado: nombre,
        clave,
        totalEsperado: 0,
        totalExtraido: 0,
        paginas: 0,
        errores: 0,
        duracionMs: Date.now() - startTime,
        outputFile: "",
      };
    }

    const totalPaginas = Math.ceil(totalEsperado / this.config.pageSize);
    const allRecords: DenueEstablishment[] = [];

    // 2. Paginar
    for (let pagina = 1; pagina <= totalPaginas; pagina++) {
      const registroInicial = (pagina - 1) * this.config.pageSize + 1;
      const registroFinal = Math.min(pagina * this.config.pageSize, totalEsperado);

      this.onProgress?.({
        clave,
        nombre,
        pagina,
        totalPaginas,
        registrosExtraidos: allRecords.length,
        totalEsperado,
      });

      try {
        const records = await this.client.buscarEntidad(
          clave,
          registroInicial,
          registroFinal,
          condicion,
          sector
        );
        allRecords.push(...records);
      } catch (err) {
        errores++;
        const msg = err instanceof DenueApiError ? err.message : String(err);
        console.error(
          `[Paginator] Error en ${nombre} página ${pagina}/${totalPaginas}: ${msg}`
        );

        // Si el error es estructural (token inválido), abortamos
        if (err instanceof DenueApiError && err.statusCode === 401) {
          throw err;
        }
        // Para otros errores, continuamos (gap aceptable)
      }

      // Rate limiting entre requests
      if (pagina < totalPaginas) {
        await sleep(this.config.delayMs);
      }
    }

    // 3. Escribir a disco
    const outputFile = this.writeOutput(clave, nombre, allRecords);

    return {
      estado: nombre,
      clave,
      totalEsperado,
      totalExtraido: allRecords.length,
      paginas: totalPaginas,
      errores,
      duracionMs: Date.now() - startTime,
      outputFile,
    };
  }

  private writeOutput(
    clave: string,
    nombre: string,
    records: DenueEstablishment[]
  ): string {
    fs.mkdirSync(this.config.outputDir, { recursive: true });

    const filename = `${clave}_${nombre.replace(/\s+/g, "_").toLowerCase()}.json`;
    const filepath = path.join(this.config.outputDir, filename);

    fs.writeFileSync(filepath, JSON.stringify(records, null, 2), "utf-8");

    return filepath;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
