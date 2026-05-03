/**
 * DENUE API Client
 * Wrapper tipado sobre la API REST del DENUE (INEGI).
 * Documentación: https://www.inegi.org.mx/servicios/api_denue.html
 */

import type { DenueEstablishment, DenueCountResponse } from "./types.js";

const BASE_URL = "https://www.inegi.org.mx/app/api/denue/v1/consulta";

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

  constructor(token: string) {
    if (!token || token.trim().length === 0) {
      throw new DenueApiError("Token de DENUE no puede estar vacío");
    }
    this.token = token.trim();
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
  ): Promise<DenueEstablishment[]> {
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
      return parsed as DenueEstablishment[];
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
  async ficha(id: string): Promise<DenueEstablishment | null> {
    const url = `${BASE_URL}/Ficha/${id}/${this.token}/`;

    const response = await this.fetchWithRetry(url, 3);
    const text = await response.text();

    if (text.trim() === "null" || text.trim() === "") return null;

    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed[0] as DenueEstablishment;
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
