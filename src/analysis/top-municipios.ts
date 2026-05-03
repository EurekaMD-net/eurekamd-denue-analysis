/**
 * Runner: Top Municipios
 *
 * Retorna los municipios con más establecimientos para una entidad dada
 * (o a nivel nacional si entidad=null).
 */

import type { AnalysisConfig, TopMunicipiosResult, MunicipioCount } from "./types.js";

export interface TopMunicipiosOptions {
  /** Filtrar por entidad (clave 2 dígitos). null = nacional */
  entidad?: string | null;
  /** Cuántos municipios retornar (default: 10) */
  limit?: number;
}

/**
 * Obtiene el ranking de municipios por número de establecimientos.
 *
 * Mismo patrón que sectorSummary: proyecta solo municipio+entidad y agrega en JS.
 * Para tablas > 1M rows se recomienda una vista materializada.
 */
export async function topMunicipios(
  config: AnalysisConfig,
  options: TopMunicipiosOptions = {},
): Promise<TopMunicipiosResult> {
  const { supabaseUrl, serviceRoleKey } = config;
  const { entidad = null, limit = 10 } = options;

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "count=exact",
  };

  const PAGE_SIZE = 1000;
  const counts = new Map<string, { entidadKey: string | null; n: number }>();
  let offset = 0;
  let totalRows = Infinity;

  while (offset < totalRows) {
    const params = new URLSearchParams({
      select: "municipio,entidad",
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
      throw new Error(`topMunicipios: PostgREST returned HTTP ${res.status}: ${body}`);
    }

    if (offset === 0) {
      const contentRange = res.headers.get("content-range");
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) totalRows = parseInt(match[1]!, 10);
      }
    }

    const page = (await res.json()) as Array<{
      municipio: string | null;
      entidad: string | null;
    }>;

    if (page.length === 0) break;

    for (const row of page) {
      const key = `${row.entidad ?? ""}|${row.municipio ?? ""}`;
      const existing = counts.get(key);
      if (existing) {
        existing.n += 1;
      } else {
        counts.set(key, { entidadKey: row.entidad, n: 1 });
      }
    }

    offset += PAGE_SIZE;
    if (page.length < PAGE_SIZE) break;
  }

  const rows: MunicipioCount[] = Array.from(counts.entries())
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, limit)
    .map(([key, { entidadKey, n }]) => {
      const parts = key.split("|");
      return {
        municipio: parts[1] || null,
        entidad: entidadKey,
        count: n,
      };
    });

  return { entidad: entidad ?? null, limit, rows };
}
