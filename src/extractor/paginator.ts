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
   * @param clave      - Clave de 2 dígitos del estado (ej: "09")
   * @param condicion  - Keyword de búsqueda (vacío = todos)
   * @param sector     - Código SCIAN o "todos"
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
    let totalExtraido = 0;

    // 2. Preparar archivo de salida para escritura incremental (evita acumular en RAM)
    fs.mkdirSync(this.config.outputDir, { recursive: true });
    const filename = `${clave}_${nombre.replace(/\s+/g, "_").toLowerCase()}.json`;
    const outputFile = path.join(this.config.outputDir, filename);
    const stream = fs.createWriteStream(outputFile, { encoding: "utf-8" });
    stream.write("[\n");
    let firstRecord = true;

    // 3. Paginar — escribir cada página a disco conforme llega
    for (let pagina = 1; pagina <= totalPaginas; pagina++) {
      const registroInicial = (pagina - 1) * this.config.pageSize + 1;
      const registroFinal = Math.min(pagina * this.config.pageSize, totalEsperado);

      this.onProgress?.({
        clave,
        nombre,
        pagina,
        totalPaginas,
        registrosExtraidos: totalExtraido,
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
        for (const record of records) {
          if (!firstRecord) stream.write(",\n");
          stream.write(JSON.stringify(record));
          firstRecord = false;
        }
        totalExtraido += records.length;
      } catch (err) {
        errores++;
        const msg = err instanceof DenueApiError ? err.message : String(err);
        console.error(
          `[Paginator] Error en ${nombre} página ${pagina}/${totalPaginas}: ${msg}`
        );

        // Si el error es estructural (token inválido), cerramos el stream y abortamos
        if (err instanceof DenueApiError && err.statusCode === 401) {
          stream.end("\n]");
          throw err;
        }
        // Para otros errores, continuamos (gap aceptable)
      }

      // Rate limiting entre requests
      if (pagina < totalPaginas) {
        await sleep(this.config.delayMs);
      }
    }

    // 4. Cerrar el array JSON y el stream de forma segura
    await new Promise<void>((resolve, reject) => {
      stream.once("error", reject);
      stream.end("\n]", resolve);
    });

    return {
      estado: nombre,
      clave,
      totalEsperado,
      totalExtraido,
      paginas: totalPaginas,
      errores,
      duracionMs: Date.now() - startTime,
      outputFile,
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
