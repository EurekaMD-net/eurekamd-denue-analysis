/**
 * Tests — sector-summary runner
 *
 * Cubre:
 * - Lee mv_sector_summary (no establecimientos) con orden estable (audit #47)
 * - Suma `total` por clase_actividad_id a través de entidades
 * - Paginación por la llave única del MV
 * - Filtro por entidad (PostgREST param)
 * - Ordenamiento por count descendente
 * - Manejo de clase_actividad_id nulo → clave "__unknown__"
 * - HTTP error propagado como excepción
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { sectorSummary } from "./sector-summary.js";
import type { AnalysisConfig } from "./types.js";

const CONFIG: AnalysisConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-key",
};

afterEach(() => {
  vi.restoreAllMocks();
});

type MvRow = {
  clase_actividad_id: string | null;
  clase_actividad: string | null;
  total: number | string;
};

/** Crea una respuesta PostgREST simulada de mv_sector_summary */
function mockResponse(rows: MvRow[]): Response {
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("sectorSummary", () => {
  it("lee mv_sector_summary ordenado por su llave única, sin count=exact (audit #47)", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(mockResponse([]));
    vi.stubGlobal("fetch", mockFetch);

    await sectorSummary(CONFIG);

    const [calledUrl, init] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    expect(calledUrl).toContain("/rest/v1/mv_sector_summary?");
    expect(calledUrl).not.toContain("/establecimientos");
    const params = new URL(calledUrl).searchParams;
    expect(params.get("order")).toBe(
      "entidad.asc,sector_actividad_id.asc,clase_actividad_id.asc",
    );
    expect(init.headers["Prefer"]).toBeUndefined();
  });

  it("suma total por clase_actividad_id a través de entidades", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        mockResponse([
          { clase_actividad_id: "622110", clase_actividad: "Hospitales generales", total: 2 },
          { clase_actividad_id: "461110", clase_actividad: "Tiendas de abarrotes", total: "1" },
          { clase_actividad_id: "622110", clase_actividad: "Hospitales generales", total: 3 },
        ]),
      ),
    );

    const result = await sectorSummary(CONFIG);

    expect(result.total).toBe(6);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      clase_actividad_id: "622110",
      clase_actividad: "Hospitales generales",
      count: 5,
    });
    expect(result.rows[1]).toMatchObject({ clase_actividad_id: "461110", count: 1 });
  });

  it("respeta el límite de filas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        mockResponse([
          { clase_actividad_id: "A", clase_actividad: null, total: 1 },
          { clase_actividad_id: "B", clase_actividad: null, total: 2 },
          { clase_actividad_id: "C", clase_actividad: null, total: 1 },
        ]),
      ),
    );

    const result = await sectorSummary(CONFIG, { limit: 2 });

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]!.clase_actividad_id).toBe("B");
  });

  it("filtra por entidad — incluye eq.<entidad> en la URL", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse([{ clase_actividad_id: "622110", clase_actividad: "Hospitales", total: 1 }]),
    );
    vi.stubGlobal("fetch", mockFetch);

    await sectorSummary(CONFIG, { entidad: "09" });

    const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain("entidad=eq.09");
  });

  it("clase_actividad_id nula se agrupa bajo __unknown__", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        mockResponse([
          { clase_actividad_id: null, clase_actividad: null, total: 1 },
          { clase_actividad_id: null, clase_actividad: null, total: 1 },
        ]),
      ),
    );

    const result = await sectorSummary(CONFIG);

    expect(result.rows[0]!.clase_actividad_id).toBe("__unknown__");
    expect(result.rows[0]!.count).toBe(2);
  });

  it("pagina correctamente cuando hay más de PAGE_SIZE filas en el MV", async () => {
    const page1: MvRow[] = Array.from({ length: 1000 }, (_, i) => ({
      clase_actividad_id: i % 2 === 0 ? "A" : "B",
      clase_actividad: null,
      total: 1,
    }));
    const page2: MvRow[] = [{ clase_actividad_id: "A", clase_actividad: null, total: 1 }];

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(page1))
      .mockResolvedValueOnce(mockResponse(page2));
    vi.stubGlobal("fetch", mockFetch);

    const result = await sectorSummary(CONFIG);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const second = new URL((mockFetch.mock.calls[1] as [string])[0]).searchParams;
    expect(second.get("offset")).toBe("1000");
    // Page1: 500 A + 500 B. Page2: 1 A = 501 A total
    expect(result.total).toBe(1001);
    expect(result.rows[0]!.clase_actividad_id).toBe("A");
    expect(result.rows[0]!.count).toBe(501);
    expect(result.rows[1]!.count).toBe(500);
  });

  it("lanza excepción en HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("Unauthorized", { status: 401 }),
      ),
    );

    await expect(sectorSummary(CONFIG)).rejects.toThrow(/HTTP 401/);
  });

  it("retorna entidad null cuando no se filtra", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockResponse([])));

    const result = await sectorSummary(CONFIG);
    expect(result.entidad).toBeNull();
  });

  it("retorna la entidad pasada en las opciones", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockResponse([])));

    const result = await sectorSummary(CONFIG, { entidad: "15" });
    expect(result.entidad).toBe("15");
  });
});
