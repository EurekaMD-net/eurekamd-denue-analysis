/**
 * Zod schemas mirroring src/api/types.ts on the backend. Validate every
 * response at the client boundary — defense in depth, even our own API
 * can drift.
 */

import { z } from "zod";

export const IRS_GRADO = z.enum([
  "Muy bajo",
  "Bajo",
  "Medio",
  "Alto",
  "Muy alto",
  "sin_dato",
]);
export type IrsGrado = z.infer<typeof IRS_GRADO>;

export const ENTIDAD_DROPDOWN_ENTRY = z.object({
  clave: z.string(),
  nombre: z.string(),
  loaded: z.number(),
  inegi_total: z.number().nullable(),
  status: z.enum(["green", "yellow", "red", "unverified"]),
});

export const ENTIDADES_RESULT = z.object({
  entidades: z.array(ENTIDAD_DROPDOWN_ENTRY),
});

export const SECTOR_ENTRY = z.object({
  scian: z.string(),
  name: z.string(),
  national_count: z.number(),
});

export const SECTORS_RESULT = z.object({
  sectors: z.array(SECTOR_ENTRY),
});

export const NATIONAL_TREEMAP_ENTRY = z.object({
  entidad: z.string(),
  nombre: z.string(),
  establecimientos: z.number(),
  modal_irs_grado: IRS_GRADO,
  pobreza_pct_promedio: z.number().nullable(),
});

export const NATIONAL_TREEMAP_RESULT = z.object({
  entidades: z.array(NATIONAL_TREEMAP_ENTRY),
});

export const SECTOR_GRADE_MATRIX_CELL = z.object({
  scian: z.string(),
  irs_grado: IRS_GRADO,
  count: z.number(),
});

export const SECTOR_GRADE_MATRIX_RESULT = z.object({
  cells: z.array(SECTOR_GRADE_MATRIX_CELL),
});

export const MUNICIPIO_ANALYTICS_ROW = z.object({
  cve_mun: z.string(),
  municipio: z.string().nullable(),
  poblacion: z.number().nullable(),
  establecimientos: z.number(),
  farmacias: z.number(),
  unidades_clues: z.number(),
  pobreza_pct: z.number().nullable(),
  irs_grado: IRS_GRADO.nullable(),
  irs_indice: z.number().nullable(),
});

export const MUNICIPIOS_ANALYTICS_RESULT = z.object({
  entidad: z.string(),
  municipios: z.array(MUNICIPIO_ANALYTICS_ROW),
});

export const TOP_SECTOR_ROW = z.object({
  scian: z.string(),
  name: z.string(),
  count: z.number(),
});

export const TOP_SECTORS_RESULT = z.object({
  entidad: z.string(),
  sectors: z.array(TOP_SECTOR_ROW),
});

export const SEARCH_RESULT = z.object({
  rows: z.array(z.record(z.string(), z.unknown())),
  page: z.number(),
  limit: z.number(),
  total_returned: z.number(),
});

export type EntidadesResult = z.infer<typeof ENTIDADES_RESULT>;
export type SectorsResult = z.infer<typeof SECTORS_RESULT>;
export type NationalTreemapResult = z.infer<typeof NATIONAL_TREEMAP_RESULT>;
export type SectorGradeMatrixResult = z.infer<
  typeof SECTOR_GRADE_MATRIX_RESULT
>;
export type MunicipiosAnalyticsResult = z.infer<
  typeof MUNICIPIOS_ANALYTICS_RESULT
>;
export type MunicipioAnalyticsRow = z.infer<typeof MUNICIPIO_ANALYTICS_ROW>;
export type TopSectorsResult = z.infer<typeof TOP_SECTORS_RESULT>;
export type TopSectorRow = z.infer<typeof TOP_SECTOR_ROW>;
export type SearchResult = z.infer<typeof SEARCH_RESULT>;
