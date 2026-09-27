/**
 * Tests — top-municipios runner
 *
 * Cubre:
 * - Ranking correcto por conteo descendente
 * - Filtro por entidad
 * - Límite respetado
 * - Municipio nulo manejado (key vacía)
 * - HTTP error propagado
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { topMunicipios } from "./top-municipios.js";
import type { AnalysisConfig } from "./types.js";

const CONFIG: AnalysisConfig = {
  supabaseUrl: "http://localhost:8100",
  serviceRoleKey: "test-key",
};

afterEach(() => {
  vi.restoreAllMocks();
});

function mockResponse(
  rows: Array<{ clee?: string; municipio: string | null; entidad: string | null }>,
  total: number,
  offset = 0,
): Response {
  const end = rows.length === 0 ? offset : offset + rows.length - 1;
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Range": `${offset}-${end}/${total}`,
    },
  });
}

describe("topMunicipios", () => {
  it("retorna ranking correcto por conteo descendente", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        mockResponse(
          [
            { municipio: "Cuauhtémoc", entidad: "09" },
            { municipio: "Cuauhtémoc", entidad: "09" },
            { municipio: "Cuauhtémoc", entidad: "09" },
            { municipio: "Benito Juárez", entidad: "09" },
            { municipio: "Benito Juárez", entidad: "09" },
            { municipio: "Iztapalapa", entidad: "09" },
          ],
          6,
        ),
      ),
    );

    const result = await topMunicipios(CONFIG, { entidad: "09", limit: 3 });

    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]!.municipio).toBe("Cuauhtémoc");
    expect(result.rows[0]!.count).toBe(3);
    expect(result.rows[1]!.municipio).toBe("Benito Juárez");
    expect(result.rows[1]!.count).toBe(2);
    expect(result.rows[2]!.municipio).toBe("Iztapalapa");
    expect(result.rows[2]!.count).toBe(1);
  });

  it("incluye parámetro eq.<entidad> en la URL cuando se filtra", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse([], 0),
    );
    vi.stubGlobal("fetch", mockFetch);

    await topMunicipios(CONFIG, { entidad: "06" });

    const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
    expect(calledUrl).toContain("entidad=eq.06");
  });

  it("NO incluye filtro de entidad cuando es null", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce(
      mockResponse([], 0),
    );
    vi.stubGlobal("fetch", mockFetch);

    await topMunicipios(CONFIG, { entidad: null });

    const calledUrl = (mockFetch.mock.calls[0] as [string])[0];
    expect(calledUrl).not.toContain("entidad=eq");
  });

  it("limite default es 10", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(mockResponse([], 0)),
    );

    const result = await topMunicipios(CONFIG);
    expect(result.limit).toBe(10);
  });

  it("municipio nulo se maneja sin crash", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        mockResponse(
          [
            { municipio: null, entidad: "09" },
            { municipio: null, entidad: "09" },
          ],
          2,
        ),
      ),
    );

    const result = await topMunicipios(CONFIG);
    expect(result.rows[0]!.municipio).toBeNull();
    expect(result.rows[0]!.count).toBe(2);
  });

  it("lanza excepción en HTTP 403", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValueOnce(
        new Response("Forbidden", { status: 403 }),
      ),
    );

    await expect(topMunicipios(CONFIG)).rejects.toThrow(/HTTP 403/);
  });

  it("pagina por llave clee (order + gt) y pide count=exact solo en la primera página (audit #47)", async () => {
    const page1 = Array.from({ length: 1000 }, (_, i) => ({
      clee: `09${String(i).padStart(6, "0")}`,
      municipio: "Cuauhtémoc",
      entidad: "09",
    }));
    const page2 = [{ clee: "09999999", municipio: "Iztapalapa", entidad: "09" }];
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(mockResponse(page1, 1001))
      .mockResolvedValueOnce(mockResponse(page2, 1001, 1000));
    vi.stubGlobal("fetch", mockFetch);

    const result = await topMunicipios(CONFIG, { entidad: "09" });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url1, init1] = mockFetch.mock.calls[0] as [
      string,
      { headers: Record<string, string> },
    ];
    const [url2, init2] = mockFetch.mock.calls[1] as [
      string,
      { headers: Record<string, string> },
    ];
    const p1 = new URL(url1).searchParams;
    const p2 = new URL(url2).searchParams;
    expect(p1.get("order")).toBe("clee.asc");
    expect(p1.get("clee")).toBeNull();
    expect(p1.get("offset")).toBeNull();
    expect(p2.get("order")).toBe("clee.asc");
    expect(p2.get("clee")).toBe("gt.09000999");
    expect(p2.get("offset")).toBeNull();
    expect(init1.headers["Prefer"]).toBe("count=exact");
    expect(init2.headers["Prefer"]).toBeUndefined();
    expect(result.rows[0]).toMatchObject({ municipio: "Cuauhtémoc", count: 1000 });
    expect(result.rows[1]).toMatchObject({ municipio: "Iztapalapa", count: 1 });
  });
});
