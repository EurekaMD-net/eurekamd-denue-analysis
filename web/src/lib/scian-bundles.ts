/**
 * Pre-curated SCIAN bundles for Mapview mode.
 *
 * Each bundle is a named cluster of SCIAN codes that the map paints as
 * a single DENUE-point layer. Bundle definitions are operator-editable
 * — adding/removing one here doesn't require a backend change.
 *
 * SCIAN codes can be 2 to 6 digits. The map filters DENUE points by
 * `sector LIKE '<code>%'` so a 4-digit code matches all of its 5- and
 * 6-digit sub-classes.
 */

export interface ScianBundle {
  id: string;
  label: string;
  /** SCIAN codes (any depth 2..6). All match on prefix. */
  codes: string[];
  /** Brief Spanish description shown on hover/select. */
  description: string;
}

export const SCIAN_BUNDLES: ScianBundle[] = [
  {
    id: "salud_minorista",
    label: "Salud minorista",
    codes: ["4641", "46451", "46411"],
    description: "Farmacias, ópticas, medicamentos al por menor.",
  },
  {
    id: "salud_servicios",
    label: "Salud servicios",
    codes: ["6211", "6212", "6213", "6221", "6222"],
    description: "Consultorios, clínicas, hospitales.",
  },
  {
    id: "financiero_retail",
    label: "Financiero retail",
    codes: ["5221", "5222", "5223"],
    description: "Banca múltiple, banca de desarrollo, sucursales.",
  },
  {
    id: "comercio_diario",
    label: "Comercio diario",
    codes: ["4611", "4612"],
    description: "Abarrotes, frutas, verduras, carnicerías.",
  },
  {
    id: "comercio_especializado",
    label: "Comercio especializado",
    codes: ["4671", "4673", "4658", "4659", "4631"],
    description: "Ferreterías, juguetes, papelerías, ropa.",
  },
  {
    id: "hospitalidad",
    label: "Hospitalidad",
    codes: ["7223", "7212", "7224"],
    description: "Restaurantes, hoteles, bares.",
  },
  {
    id: "educacion_particular",
    label: "Educación particular",
    codes: ["6111", "6112", "6113", "6114", "6115", "6116"],
    description: "Escuelas particulares de todos los niveles.",
  },
  {
    id: "servicios_profesionales",
    label: "Servicios profesionales",
    codes: ["5411", "5412", "5413", "5416"],
    description: "Legales, contables, arquitectura, consultoría.",
  },
  {
    id: "belleza_personal",
    label: "Belleza & cuidado personal",
    codes: ["8121"],
    description: "Salones, spas, estéticas.",
  },
  {
    id: "manufactura_ligera",
    label: "Manufactura ligera",
    codes: ["3118", "3115", "3119", "3141", "3152"],
    description: "Panaderías, lácteos, otras alimentos, textiles ligeros.",
  },
];

export function findBundle(id: string): ScianBundle | undefined {
  return SCIAN_BUNDLES.find((b) => b.id === id);
}
