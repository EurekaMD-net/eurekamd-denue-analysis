/**
 * Tests — sector-summary runner
 *
 * Cubre:
 * - Paginación y agregación correcta
 * - Filtro por entidad (PostgREST param)
 * - Ordenamiento por count descendente
 * - Manejo de clase_actividad_id nulo → clave "__unknown__"
 * - HTTP error propagado como excepción
 * - Content-Range header usado para cortar el loop
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

/** Crea una respuesta PostgREST simulada */
function mockResponse(
  rows: Array<{ clase_actividad_id: string | null; clase_actividad: string | null }>,
  total: number,
  offset: number,
): Response {
  const end = Math.min(offset + rows.length - 1, total - 1);
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Range": `${offset}-${end}/${total}`,
    },
  });
}

describe("sectorSummary", () => {
  it("agrega registros correctamente para una sola página", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        mockResponse(
          [
            { clase_actividad_id: "622110", clase_actividad: "Hospitales generales" },
            { clase_actividad_id: "622110", clase_actividad: "Hospitales generales" },
            { clase_actividad_id: "461110", clase_actividad: "Tiendas de abarrotes" },
          ],
          3,
          0,
        ),
      ),
    );

    const result = await sectorSummary(CONFIG);

    expect(result.total).toBe(3);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ clase_actividad_id: "622110", count: 2 });
    expect(result.rows[1]).toMatchObject({ clase_actividad_id: "461110", count: 1 });
  });

  it("respeta el límite de filas", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        mockResponse(
          [
            { clase_actividad_id: "A", clase_actividad: null },
            { clase_actividad_id: "B", clase_actividad: null },
            { clase_actividad_id: "B", clase_actividad: null },
            { clase_actividad_id: "C", clase_actividad: null },
          ],
          4,
          0,
        ),
      ),
    );

    const result = await sectorSummary(CONFIG, { limit: 2 });

    expect(result.rows).toHaveLength(2);
    // B (2 ocurrencias) > A y C (1 cada uno)
    expect(result.rows[0]!.clase_actividad_id).toBe("B");
  });

  it("filtra por entidad — incluye eq.<entidad> en la URL", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse(
        [{ clase_actividad_id: "622110", clase_actividad: "Hospitales" }],
        1,
        0,
      ),
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
        mockResponse(
          [
            { clase_actividad_id: null, clase_actividad: null },
            { clase_actividad_id: null, clase_actividad: null },
          ],
          2,
          0,
        ),
      ),
    );

    const result = await sectorSummary(CONFIG);

    expect(result.rows[0]!.clase_actividad_id).toBe("__unknown__");
    expect(result.rows[0]!.count).toBe(2);
  });

  it("pagina correctamente cuando hay más de PAGE_SIZE registros", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      clase_actividad_id: i % 2 === 0 ? "A" : "B",
      clase_actividad: null,
    }));
    const page2 = [{ clase_actividad_id: "A", clase_actividad: null }];

    vi.stubGlobal(
      "fetch",
      vi.fn()
        .mockResolvedValueOnce(mockResponse(page1, 1001, 0))
        .mockResolvedValueOnce(mockResponse(page2, 1001, 1000)),
    );

    const result = await sectorSummary(CONFIG);

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
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(mockResponse([], 0, 0)),
    );

    const result = await sectorSummary(CONFIG);
    expect(result.entidad).toBeNull();
  });

  it("retorna la entidad pasada en las opciones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(mockResponse([], 0, 0)),
    );

    const result = await sectorSummary(CONFIG, { entidad: "15" });
    expect(result.entidad).toBe("15");
  });
});
