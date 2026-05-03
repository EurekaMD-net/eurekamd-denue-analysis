/**
 * DENUE API Client
 * Wrapper tipado sobre la API REST del DENUE (INEGI).
 * Documentación: https://www.inegi.org.mx/servicios/api_denue.html
 */

import type { DenueRawRecord, DenueCountResponse } from "./types.js";

const BASE_URL = "https://www.inegi.org.mx/app/api/denue/v1/consulta";

// ---------------------------------------------------------------------------
// Global rate throttle — shared across ALL DenueClient instances so that
// concurrent orchestrator workers don't multiply API hit rate.
// Each call waits until at least `delayMs` has passed since the last call.
// ---------------------------------------------------------------------------
let _lastCallAt = 0;
let _globalDelayMs = 300; // default; overridden by first client constructed
// Promise chain that serializes concurrent callers — each new call queues behind the last.
let _throttleChain: Promise<void> = Promise.resolve();

/** Override the global inter-request delay (ms). Call before constructing clients. */
export function setGlobalDelay(ms: number): void {
  _globalDelayMs = ms;
}

/**
 * Serializes all fetch calls through a shared promise chain so that
 * regardless of orchestrator concurrency, total DENUE API request rate
 * is bounded to one call per _globalDelayMs.
 */
async function globalThrottle(): Promise<void> {
  // Append our wait to the end of the chain. Each caller takes the current
  // chain tail, then schedules its own slot _globalDelayMs later.
  const myTurn = _throttleChain.then(async () => {
    const now = Date.now();
    const elapsed = now - _lastCallAt;
    if (elapsed < _globalDelayMs) {
      await sleep(_globalDelayMs - elapsed);
    }
    _lastCallAt = Date.now();
  });
  // Advance the chain tail — next caller waits for myTurn to finish
  _throttleChain = myTurn;
  return myTurn;
}

/** Reset throttle state (for tests) */
export function resetThrottle(): void {
  _lastCallAt = 0;
  _throttleChain = Promise.resolve();
}

export class DenueApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly endpoint?: string
  ) {
    super(message);
    this.name = "DenueApiError";
  }
}

export class DenueClient {
  private readonly token: string;

  /**
   * @param token   - INEGI API token
   * @param delayMs - Inter-request delay in ms. Sets the GLOBAL delay shared by
   *                  all DenueClient instances, so concurrent orchestrator workers
   *                  are bounded to one API call per delayMs regardless of concurrency.
   */
  constructor(token: string, delayMs?: number) {
    if (!token || token.trim().length === 0) {
      throw new DenueApiError("Token de DENUE no puede estar vacío");
    }
    this.token = token.trim();
    if (delayMs !== undefined) {
      setGlobalDelay(delayMs);
    }
  }

  /**
   * Busca establecimientos por entidad federativa y actividad económica.
   * Soporta paginación via registroInicial / registroFinal.
   *
   * @param entidad - Clave de 2 dígitos del estado (01-32)
   * @param registroInicial - Primer registro a retornar (base 1)
   * @param registroFinal - Último registro a retornar
   * @param condicion - Keyword de búsqueda (vacío = todos)
   * @param sector - Código SCIAN o "todos"
   */
  async buscarEntidad(
    entidad: string,
    registroInicial: number,
    registroFinal: number,
    condicion: string = "",
    sector: string = "todos"
  ): Promise<DenueRawRecord[]> {
    const url = `${BASE_URL}/BuscarEntidad/${condicion}/${sector}/${entidad}/${registroInicial}/${registroFinal}/${this.token}/`;

    const response = await this.fetchWithRetry(url, 3);
    const text = await response.text();

    // La API devuelve null literal cuando no hay resultados
    if (text.trim() === "null" || text.trim() === "") {
      return [];
    }

    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) return [];
      return parsed as DenueRawRecord[];
    } catch {
      throw new DenueApiError(
        `Respuesta inesperada de la API: ${text.slice(0, 200)}`,
        undefined,
        url
      );
    }
  }

  /**
   * Cuenta el número total de establecimientos para una entidad + condición.
   * Usa este método primero para calcular cuántas páginas necesitas.
   */
  async cuantificarEntidad(
    entidad: string,
    condicion: string = "",
    sector: string = "todos"
  ): Promise<number> {
    const url = `${BASE_URL}/Cuantificar/${condicion}/${sector}/${entidad}/${this.token}/`;

    const response = await this.fetchWithRetry(url, 3);
    const text = await response.text();

    try {
      const parsed = JSON.parse(text) as DenueCountResponse[];
      if (!Array.isArray(parsed) || parsed.length === 0) return 0;
      return parseInt(parsed[0].Total, 10) || 0;
    } catch {
      throw new DenueApiError(
        `Error al parsear conteo: ${text.slice(0, 200)}`,
        undefined,
        url
      );
    }
  }

  /**
   * Obtiene la ficha completa de un establecimiento por su ID.
   */
  async ficha(id: string): Promise<DenueRawRecord | null> {
    const url = `${BASE_URL}/Ficha/${id}/${this.token}/`;

    const response = await this.fetchWithRetry(url, 3);
    const text = await response.text();

    if (text.trim() === "null" || text.trim() === "") return null;

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed[0] as DenueRawRecord;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Hace fetch con reintentos exponenciales.
   * Lanza DenueApiError si se agotan los reintentos.
   */
  private async fetchWithRetry(
    url: string,
    maxRetries: number,
    attempt = 1
  ): Promise<Response> {
    // Throttle ALL requests through the global rate limiter so that
    // concurrent callers (multiple orchestrator workers) share the delay.
    await globalThrottle();

    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(30_000),
      });

      if (!response.ok) {
        throw new DenueApiError(
          `HTTP ${response.status} en ${url}`,
          response.status,
          url
        );
      }

      return response;
    } catch (err) {
      if (attempt >= maxRetries) {
        if (err instanceof DenueApiError) throw err;
        throw new DenueApiError(
          `Error de red tras ${maxRetries} intentos: ${String(err)}`,
          undefined,
          url
        );
      }

      const backoffMs = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
      await sleep(backoffMs);
      return this.fetchWithRetry(url, maxRetries, attempt + 1);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
