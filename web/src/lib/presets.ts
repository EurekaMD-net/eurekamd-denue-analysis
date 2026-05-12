/**
 * Locust mode preset library — one-click full chart configurations to
 * seed the empty-state landing.
 *
 * Each preset references field ids from FIELD_CATALOG. Reachability is
 * decided by FIELD_CATALOG[id].columns — Locust will only render a chart
 * if the X anchor's grain has columns for all of Y (and Z if set).
 *
 * Invariant (asserted in presets.test.ts): for every preset
 *   xField.columns is non-empty (i.e. reachable)
 *   yField.columns[xField.grain] is defined
 *   zField (if present) → zField.columns[xField.grain] is defined
 */

import { findField, isFieldReachable } from "./fields";

export interface LocustPreset {
  id: string;
  title: string;
  description: string;
  x: string; // field id (must be xEligible)
  y: string;
  z?: string;
  /**
   * Some presets need a pre-selected entidad clave (e.g. muni-grain or
   * SCIAN-grain charts). Surfaced as an inline hint when the preset is
   * applied without `entidad` set.
   */
  needsEntidad?: boolean;
  exampleEntidad?: string;
}

export const LOCUST_PRESETS: LocustPreset[] = [
  // estado-grain charts — work without entidad selected.
  {
    id: "pobreza_x_establecimientos",
    title: "Pobreza × Establecimientos (estados)",
    description:
      "¿Dónde hay actividad económica DENUE en zonas de alta pobreza? Una fila por entidad.",
    x: "denue.entidad_nombre",
    y: "denue.total_establecimientos",
    z: "coneval.pobreza_pct",
  },
  {
    id: "rezago_x_establecimientos",
    title: "Rezago social × Establecimientos (estados)",
    description:
      "Distribución de unidades económicas por grado modal de rezago social.",
    x: "denue.entidad_nombre",
    y: "denue.total_establecimientos",
    z: "coneval.irs_grado",
  },

  // muni-grain charts — require entidad pre-selected.
  {
    id: "muni_pobreza_x_establecimientos",
    title: "Municipios: Pobreza × Establecimientos",
    description:
      "Por municipio dentro de una entidad. Selecciona la entidad primero (panel superior).",
    x: "denue.municipio_nombre",
    y: "denue.total_establecimientos",
    z: "coneval.pobreza_pct",
    needsEntidad: true,
    exampleEntidad: "09",
  },
  {
    id: "muni_clues_x_poblacion",
    title: "Municipios: Salud × Población",
    description:
      "Unidades CLUES contra población total — densidad de salud pública por municipio.",
    x: "denue.municipio_nombre",
    y: "clues.total",
    z: "censo.pobtot",
    needsEntidad: true,
    exampleEntidad: "09",
  },

  // SCIAN-sector chart — requires entidad.
  {
    id: "sectores_top",
    title: "Top sectores SCIAN (por entidad)",
    description:
      "Distribución de establecimientos por sector SCIAN 2-dígito dentro de una entidad.",
    x: "denue.scian_sector",
    y: "denue.total_establecimientos",
    needsEntidad: true,
    exampleEntidad: "09",
  },
];

/**
 * Runtime-validate that a preset's field ids all exist in the catalog
 * and that Y/Z are graphable against the X anchor's grain. Returns the
 * list of failure reasons; an empty list means the preset is valid.
 *
 * Used by presets.test.ts on every shipped preset, and (defensively)
 * by LocustMode.EmptyState to filter out a preset whose catalog ids
 * have been removed/renamed.
 */
export function validatePreset(p: LocustPreset): string[] {
  const errors: string[] = [];
  const x = findField(p.x);
  const y = findField(p.y);
  const z = p.z ? findField(p.z) : null;
  if (!x) errors.push(`X "${p.x}" missing from catalog`);
  if (!y) errors.push(`Y "${p.y}" missing from catalog`);
  if (p.z && !z) errors.push(`Z "${p.z}" missing from catalog`);
  if (x && !isFieldReachable(x))
    errors.push(`X "${p.x}" is unreachable (empty columns map)`);
  if (x && y && y.columns[x.grain] === undefined) {
    errors.push(`Y "${p.y}" has no column at grain "${x.grain}"`);
  }
  if (x && z && z.columns[x.grain] === undefined) {
    errors.push(`Z "${p.z}" has no column at grain "${x.grain}"`);
  }
  return errors;
}
