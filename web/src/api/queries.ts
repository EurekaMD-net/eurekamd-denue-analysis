/**
 * TanStack Query hooks for every endpoint the frontend touches. Each hook
 * runs the raw fetch through `apiFetch` (which injects X-Api-Key) and then
 * validates the body against a Zod schema — defense in depth.
 */

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { z } from "zod";
import { useUiStore } from "../store";
import { apiFetch } from "./client";
import {
  ENTIDADES_RESULT,
  MUNICIPIOS_ANALYTICS_RESULT,
  NATIONAL_TREEMAP_RESULT,
  SEARCH_RESULT,
  SECTOR_GRADE_MATRIX_RESULT,
  SECTORS_RESULT,
  TOP_SECTORS_RESULT,
  type EntidadesResult,
  type MunicipiosAnalyticsResult,
  type NationalTreemapResult,
  type SearchResult,
  type SectorGradeMatrixResult,
  type SectorsResult,
  type TopSectorsResult,
} from "./types";

async function fetchJson<S extends z.ZodTypeAny>(
  path: string,
  schema: S,
  accessToken: string | null,
): Promise<z.infer<S>> {
  const res = await apiFetch(path, {}, accessToken);
  const body: unknown = await res.json();
  return schema.parse(body);
}

/** Loads 32-entry dropdown source. Cached 5 minutes by TanStack default. */
export function useEntidades(): UseQueryResult<EntidadesResult> {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  return useQuery({
    queryKey: ["entidades"],
    queryFn: () => fetchJson("/entidades", ENTIDADES_RESULT, accessToken),
    enabled: accessToken !== null,
  });
}

export function useSectors(): UseQueryResult<SectorsResult> {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  return useQuery({
    queryKey: ["sectors"],
    queryFn: () => fetchJson("/sectors", SECTORS_RESULT, accessToken),
    enabled: accessToken !== null,
  });
}

export function useNationalTreemap(): UseQueryResult<NationalTreemapResult> {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  return useQuery({
    queryKey: ["analytics", "national-treemap"],
    queryFn: () =>
      fetchJson("/analytics/national-treemap", NATIONAL_TREEMAP_RESULT, accessToken),
    enabled: accessToken !== null,
  });
}

export function useSectorGradeMatrix(): UseQueryResult<SectorGradeMatrixResult> {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  return useQuery({
    queryKey: ["analytics", "sector-grade-matrix"],
    queryFn: () =>
      fetchJson(
        "/analytics/sector-grade-matrix",
        SECTOR_GRADE_MATRIX_RESULT,
        accessToken,
      ),
    enabled: accessToken !== null,
  });
}

export function useMunicipiosAnalytics(
  entidad: string | null,
): UseQueryResult<MunicipiosAnalyticsResult> {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  return useQuery({
    queryKey: ["analytics", "municipios", entidad],
    queryFn: () =>
      fetchJson(
        `/analytics/municipios?entidad=${encodeURIComponent(entidad ?? "")}`,
        MUNICIPIOS_ANALYTICS_RESULT,
        accessToken,
      ),
    enabled: accessToken !== null && entidad !== null,
  });
}

export function useTopSectorsByEntidad(
  entidad: string | null,
  limit = 10,
): UseQueryResult<TopSectorsResult> {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  return useQuery({
    queryKey: ["analytics", "top-sectors", entidad, limit],
    queryFn: () =>
      fetchJson(
        `/analytics/top-sectors?entidad=${encodeURIComponent(
          entidad ?? "",
        )}&limit=${limit}`,
        TOP_SECTORS_RESULT,
        accessToken,
      ),
    enabled: accessToken !== null && entidad !== null,
  });
}

/**
 * Debounced search — only fires when q has at least 3 chars.
 * Caller is responsible for debounce upstream (we just gate on length).
 */
export function useSearch(q: string): UseQueryResult<SearchResult> {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  const enabled = accessToken !== null && q.trim().length >= 3;
  return useQuery({
    queryKey: ["search", q],
    queryFn: () =>
      fetchJson(
        `/search?q=${encodeURIComponent(q)}&limit=20`,
        SEARCH_RESULT,
        accessToken,
      ),
    enabled,
    staleTime: 30_000,
  });
}

/** Convenience: filter a sector-grade matrix by SCIAN. */
export function cellsForScian(
  matrix: SectorGradeMatrixResult,
  scian: string,
): SectorGradeMatrixResult["cells"] {
  return matrix.cells.filter((c) => c.scian === scian);
}
