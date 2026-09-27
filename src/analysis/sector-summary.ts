/**
 * Runner: Sector Summary
 *
 * Lee mv_sector_summary (una fila por entidad + sector + clase_actividad_id,
 * scripts/migrations/021-summary-mvs.sql) y retorna los top-N
 * clase_actividad_id por número de establecimientos.
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
 * Implementación: pagina mv_sector_summary (~30k filas a nivel nacional, en
 * vez de 6.1M establecimientos — audit #47) ordenado por su llave única, de
 * modo que las páginas no se traslapan, y suma `total` por
 * clase_actividad_id en JS (a nivel nacional una clase aparece una vez por
 * entidad).
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
  };

  const PAGE_SIZE = 1000;
  const counts = new Map<string, { nombre: string | null; n: number }>();
  let offset = 0;

  for (;;) {
    const params = new URLSearchParams({
      select: "clase_actividad_id,clase_actividad,total",
      order: "entidad.asc,sector_actividad_id.asc,clase_actividad_id.asc",
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });

    if (entidad) {
      params.set("entidad", `eq.${entidad}`);
    }

    const url = `${supabaseUrl}/rest/v1/mv_sector_summary?${params.toString()}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`sectorSummary: PostgREST returned HTTP ${res.status}: ${body}`);
    }

    const page = (await res.json()) as Array<{
      clase_actividad_id: string | null;
      clase_actividad: string | null;
      total: number | string;
    }>;

    for (const row of page) {
      const key = row.clase_actividad_id ?? "__unknown__";
      const n = Number(row.total);
      const existing = counts.get(key);
      if (existing) {
        existing.n += n;
      } else {
        counts.set(key, { nombre: row.clase_actividad, n });
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
