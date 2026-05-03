/**
 * Runner: Sector Summary
 *
 * Consulta la tabla establecimientos y agrupa por clase_actividad_id,
 * retornando los top-N sectores por número de establecimientos.
 *
 * Usa la REST API de PostgREST (no docker exec) porque es una lectura
 * simple que no requiere SQL arbitrario.
 */

import type { AnalysisConfig, SectorSummaryResult, SectorCount } from "./types.js";

export interface SectorSummaryOptions {
  /** Filtrar por entidad (clave 2 dígitos, ej. "09"). null = nacional */
  entidad?: string | null;
  /** Máximo de filas a retornar (default: 20) */
  limit?: number;
}

/**
 * Obtiene el conteo de establecimientos agrupado por clase_actividad_id.
 *
 * Implementación: descarga todos los establecimientos filtrados (proyectando
 * solo clase_actividad_id + clase_actividad) y agrupa en JS.
 * PostgREST no soporta GROUP BY nativo en /rest/v1, así que usamos
 * el endpoint con select proyectado + paginación para no desbordar memoria.
 *
 * Para volúmenes > 500k se recomienda migrar a una vista materializada
 * y leer desde /rest/v1/sector_summary_mv.
 */
export async function sectorSummary(
  config: AnalysisConfig,
  options: SectorSummaryOptions = {},
): Promise<SectorSummaryResult> {
  const { supabaseUrl, serviceRoleKey } = config;
  const { entidad = null, limit = 20 } = options;

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    // Ask PostgREST for exact total count
    Prefer: "count=exact",
  };

  const PAGE_SIZE = 1000;
  const counts = new Map<string, { nombre: string | null; n: number }>();
  let offset = 0;
  let totalRows = Infinity;

  while (offset < totalRows) {
    const params = new URLSearchParams({
      select: "clase_actividad_id,clase_actividad",
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });

    if (entidad) {
      params.set("entidad", `eq.${entidad}`);
    }

    const url = `${supabaseUrl}/rest/v1/establecimientos?${params.toString()}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sectorSummary: PostgREST returned HTTP ${res.status}: ${body}`);
    }

    // Extract total count from Content-Range header on first page
    if (offset === 0) {
      const contentRange = res.headers.get("content-range");
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) {
          totalRows = parseInt(match[1]!, 10);
        }
      }
    }

    const page = (await res.json()) as Array<{
      clase_actividad_id: string | null;
      clase_actividad: string | null;
    }>;

    if (page.length === 0) break;

    for (const row of page) {
      const key = row.clase_actividad_id ?? "__unknown__";
      const existing = counts.get(key);
      if (existing) {
        existing.n += 1;
      } else {
        counts.set(key, { nombre: row.clase_actividad, n: 1 });
      }
    }

    offset += PAGE_SIZE;
    if (page.length < PAGE_SIZE) break; // Last page
  }

  // Sort by count descending, take top-N
  const rows: SectorCount[] = Array.from(counts.entries())
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, limit)
    .map(([id, { nombre, n }]) => ({
      clase_actividad_id: id,
      clase_actividad: nombre,
      count: n,
    }));

  const total = Array.from(counts.values()).reduce((s, v) => s + v.n, 0);

  return { entidad: entidad ?? null, total, rows };
}
