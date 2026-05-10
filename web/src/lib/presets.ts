/**
 * Locust mode preset library — six one-click full chart configurations
 * to seed the empty-state landing.
 *
 * Each preset references field ids from FIELD_CATALOG (web/src/lib/fields.ts).
 */

export interface LocustPreset {
  id: string;
  title: string;
  description: string;
  x: string; // field id
  y: string;
  z?: string;
}

export const LOCUST_PRESETS: LocustPreset[] = [
  {
    id: "pobreza_x_establecimientos",
    title: "Pobreza × Establecimientos",
    description:
      "¿Dónde hay actividad económica DENUE en zonas de alta pobreza?",
    x: "denue.entidad_nombre",
    y: "denue.total_establecimientos",
    z: "coneval.pobreza_pct",
  },
  {
    id: "rezago_x_establecimientos",
    title: "Rezago social × Establecimientos",
    description: "Distribución de unidades económicas por grado de rezago.",
    x: "denue.entidad_nombre",
    y: "denue.total_establecimientos",
    z: "coneval.irs_grado",
  },
  {
    id: "homicidios_x_mortalidad",
    title: "Crimen × Mortalidad",
    description: "Homicidios dolosos contra mortalidad total por municipio.",
    x: "sesnsp.homicidio_doloso",
    y: "edr.total_defunciones",
  },
  {
    id: "cobertura_x_poblacion",
    title: "Cobertura salud × Población",
    description: "% sin cobertura institucional vs. pobtot a nivel AGEB.",
    x: "censo.pobtot_ageb",
    y: "censo.pct_sin_cobertura_salud",
  },
  {
    id: "informalidad_x_densidad",
    title: "Informalidad × Densidad económica",
    description:
      "Tasa ENOE de informalidad contra establecimientos DENUE por entidad.",
    x: "enoe.pct_informal",
    y: "denue.total_establecimientos",
  },
  {
    id: "subsidio_x_credito",
    title: "Subsidio SEDATU × Crédito CNBV",
    description:
      "Mezcla pública/privada de financiamiento vivienda por municipio.",
    x: "sedatu.monto_total",
    y: "cnbv.monto_total",
  },
];
