/**
 * Client for /analytics/layers/values (Mapview client-side join feed).
 *
 * Returns { grain, layers, values } where `values` is keyed by polygon
 * ID (cve_mun or cvegeo). Frontend joins each DENUE point's polygon
 * key onto this map to look up its bivariate/trivariate color.
 */

import { useQuery } from "@tanstack/react-query";
import { useUiStore } from "../store";
import { apiFetch } from "./client";

export interface LayerValuesResult {
  grain: "muni" | "ageb";
  layers: string[];
  values: Record<string, Record<string, number | null>>;
}

export function useLayerValues(
  grain: "muni" | "ageb",
  layers: string[],
  entidad: string | null,
) {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  const layersKey = [...layers].sort().join(",");
  return useQuery({
    queryKey: ["layers-values", grain, layersKey, entidad],
    queryFn: async () => {
      const sp = new URLSearchParams({ grain, layers: layers.join(",") });
      if (entidad) sp.set("entidad", entidad);
      const res = await apiFetch(`/analytics/layers/values?${sp}`, {}, accessToken);
      return res.json() as Promise<LayerValuesResult>;
    },
    enabled: accessToken !== null && layers.length > 0 && layers.length <= 3,
    staleTime: 5 * 60 * 1000,
  });
}
