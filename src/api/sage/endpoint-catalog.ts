/**
 * Catalog of HTTP endpoints exposed to Sage's router model. Each entry
 * carries the route path, a description, and a JSON-Schema-fragment for
 * its params. The model picks an entry by name and fills params; the
 * dispatcher then calls the matching internal handler.
 *
 * The catalog is intentionally NOT the same as the server's `app.get`
 * list — only routes the LLM should be allowed to call appear here.
 * Excluded: /tiles (binary), /health (no-op), /search (free-text, the
 * LLM should compose answers itself), /establishment/:clee (single-row,
 * usually a follow-up).
 */

import type { EndpointSpec } from "./providers/provider.js";

export const SAGE_ENDPOINT_CATALOG: EndpointSpec[] = [
  {
    name: "entidades",
    description:
      "Lista las 32 entidades federativas con nombre y clave 2-digit.",
    params_schema: { type: "object", properties: {} },
  },
  {
    name: "sectors",
    description: "Lista los sectores SCIAN (códigos 2-digit y etiquetas).",
    params_schema: { type: "object", properties: {} },
  },
  {
    name: "summary-entidad",
    description:
      "Resumen DENUE por entidad: total establecimientos, top sectores, etc.",
    params_schema: {
      type: "object",
      properties: {
        clave: {
          type: "string",
          description: "Clave 2-digit de entidad ('01'..'32').",
        },
      },
      required: ["clave"],
    },
  },
  {
    name: "summary-sector",
    description: "Resumen DENUE por SCIAN 2-digit: distribución por entidad.",
    params_schema: {
      type: "object",
      properties: {
        scian: { type: "string", description: "SCIAN 2-digit." },
      },
      required: ["scian"],
    },
  },
  {
    name: "national-treemap",
    description: "Mosaico nacional: cuentas DENUE por entidad × sector top-10.",
    params_schema: { type: "object", properties: {} },
  },
  {
    name: "sector-grade-matrix",
    description:
      "Matriz SCIAN × grado de rezago social: cuántos establecimientos por celda.",
    params_schema: { type: "object", properties: {} },
  },
  {
    name: "municipios",
    description:
      "Lista de municipios de una entidad con métricas joinadas (pobreza, establecimientos, etc.).",
    params_schema: {
      type: "object",
      properties: {
        entidad: {
          type: "string",
          description: "Clave 2-digit de entidad.",
        },
      },
      required: ["entidad"],
    },
  },
  {
    name: "top-sectors",
    description:
      "Top SCIAN sectores en una entidad por conteo de establecimientos.",
    params_schema: {
      type: "object",
      properties: {
        entidad: { type: "string", description: "Clave 2-digit." },
        limit: {
          type: "number",
          description: "Cuántos sectores devolver (default 10).",
        },
      },
      required: ["entidad"],
    },
  },
  {
    name: "risk-summary",
    description:
      "SESNSP: perfil de delitos por municipio para una entidad y año. Incluye totales por subtipo, tasa per-1k, y cambio % vs año base.",
    params_schema: {
      type: "object",
      properties: {
        entidad: { type: "string" },
        ano: {
          type: "number",
          description: "Año (default: más reciente con 12 meses).",
        },
        baseline_ano: {
          type: "number",
          description: "Año base para % cambio.",
        },
      },
      required: ["entidad"],
    },
  },
  {
    name: "risk-trend",
    description: "Serie mensual SESNSP para un municipio (2015–2026).",
    params_schema: {
      type: "object",
      properties: {
        cve_mun: { type: "string", description: "5-digit cve_mun." },
      },
      required: ["cve_mun"],
    },
  },
  {
    name: "mortality-summary",
    description:
      "EDR 2024 mortalidad por municipio: tasa cruda + breakdown CIE-10.",
    params_schema: {
      type: "object",
      properties: {
        entidad: { type: "string" },
      },
      required: ["entidad"],
    },
  },
  {
    name: "mortality-trend",
    description: "Serie anual de mortalidad para un municipio.",
    params_schema: {
      type: "object",
      properties: {
        cve_mun: { type: "string" },
      },
      required: ["cve_mun"],
    },
  },
  {
    name: "state-calibrators",
    description:
      "ENIGH + ENOE calibradores estatales: ingreso percentiles, informalidad, desocupación, Engel.",
    params_schema: {
      type: "object",
      properties: {
        entidad: { type: "string" },
      },
      required: ["entidad"],
    },
  },
  {
    name: "agebs-by-municipio",
    description: "Lista AGEBs urbanas en un municipio con conteos + geometría.",
    params_schema: {
      type: "object",
      properties: {
        cve_mun: { type: "string" },
        order_by: {
          type: "string",
          description: "establecimientos | farmacias | clues | area",
        },
        limit: { type: "number" },
      },
      required: ["cve_mun"],
    },
  },
  {
    name: "ageb-detail",
    description:
      "Detalle completo de una AGEB: censo, top SCIAN, sample CLUES, rezago, farmacias licenciadas.",
    params_schema: {
      type: "object",
      properties: {
        cvegeo: { type: "string", description: "13-char CVEGEO." },
      },
      required: ["cvegeo"],
    },
  },
  {
    name: "ageb-farmacia-opportunity",
    description:
      "Ranking de AGEBs en un municipio por oportunidad de farmacia (CLUES + estab − farmacias).",
    params_schema: {
      type: "object",
      properties: {
        cve_mun: { type: "string" },
        limit: { type: "number" },
      },
      required: ["cve_mun"],
    },
  },
  {
    name: "opportunity-by-ageb",
    description: "Score genérico de oportunidad por AGEB para un SCIAN target.",
    params_schema: {
      type: "object",
      properties: {
        cve_mun: { type: "string" },
        target_scian: {
          type: "string",
          description: "Códigos SCIAN coma-separados, todos del mismo tamaño.",
        },
        order_by: { type: "string" },
        limit: { type: "number" },
        rezago_grado: {
          type: "string",
          description: "Filtro opcional, e.g. 'Alto,Muy alto'.",
        },
      },
      required: ["cve_mun", "target_scian"],
    },
  },
  {
    name: "opportunity-by-colonia",
    description:
      "Score de oportunidad por colonia (sin pobtot — score = estab/target).",
    params_schema: {
      type: "object",
      properties: {
        cve_mun: { type: "string" },
        target_scian: { type: "string" },
      },
      required: ["cve_mun", "target_scian"],
    },
  },
  {
    name: "colonias-by-municipio",
    description: "Lista colonias DENUE en un municipio.",
    params_schema: {
      type: "object",
      properties: { cve_mun: { type: "string" } },
      required: ["cve_mun"],
    },
  },
  {
    name: "licensed-pharmacies-by-municipio",
    description:
      "COFEPRIS farmacias licenciadas por municipio con contadores de controlados.",
    params_schema: {
      type: "object",
      properties: { cve_mun: { type: "string" } },
      required: ["cve_mun"],
    },
  },
  {
    name: "licensed-pharmacies-by-ageb",
    description: "COFEPRIS farmacias por AGEB con bandera de controlados.",
    params_schema: {
      type: "object",
      properties: { cvegeo: { type: "string" } },
      required: ["cvegeo"],
    },
  },
  {
    name: "manzanas-by-ageb",
    description: "Manzanas (city blocks) dentro de una AGEB urbana.",
    params_schema: {
      type: "object",
      properties: {
        cvegeo: { type: "string" },
        order_by: { type: "string" },
        limit: { type: "number" },
      },
      required: ["cvegeo"],
    },
  },
  {
    name: "colonias-by-ageb",
    description: "Colonias DENUE dentro de una AGEB.",
    params_schema: {
      type: "object",
      properties: { cvegeo: { type: "string" } },
      required: ["cvegeo"],
    },
  },
  {
    name: "airports-by-municipio",
    description: "Aeropuertos cargados al municipio + tráfico anual.",
    params_schema: {
      type: "object",
      properties: { cve_mun: { type: "string" } },
      required: ["cve_mun"],
    },
  },
  {
    name: "localities-by-municipio",
    description: "Localidades INEGI en un municipio (rural/urbana).",
    params_schema: {
      type: "object",
      properties: { cve_mun: { type: "string" } },
      required: ["cve_mun"],
    },
  },
  {
    name: "locality-detail",
    description: "Detalle de localidad.",
    params_schema: {
      type: "object",
      properties: { cve_loc: { type: "string" } },
      required: ["cve_loc"],
    },
  },
  {
    name: "municipio-detail",
    description:
      "Detalle completo de un municipio: 14 capas joineadas (censo, pobreza, rezago, CLUES, COFEPRIS, SESNSP, EDR, SINBA, CE2024, SEDATU, CNBV Panorama, CNBV Crédito).",
    params_schema: {
      type: "object",
      properties: { cve_mun: { type: "string" } },
      required: ["cve_mun"],
    },
  },
  {
    name: "entidad-detail",
    description:
      "Detalle completo de una entidad: 6 capas estatales (CNBV Panorama estatal, CNBV Crédito estatal, SICT estatal, SEDATU estatal, ENIGH, ENOE).",
    params_schema: {
      type: "object",
      properties: { clave: { type: "string" } },
      required: ["clave"],
    },
  },
];

/**
 * Schema-summary the router sees when contemplating SQL fallback. Column
 * names are real (verified from pg_attribute 2026-05-10). Lines are kept
 * short so the prompt fits the 32k smallest-supported window.
 *
 * Conventions documented inline:
 *   - cve_mun: 5-digit TEXT, zero-padded. cve_mun LIKE 'XX999' or 'XX998' are
 *     SESNSP catch-all rows — exclude with NOT LIKE '%99[89]'.
 *   - cve_ent: 2-digit TEXT, zero-padded.
 *   - cvegeo: 13-char TEXT for AGEB. cofepris_farmacias_by_ageb uses
 *     `cvegeo_ageb` as the key column.
 *   - All pct_* columns are 0–100 (not 0–1).
 *   - mv_delitos_municipal_yearly.ano spans 2015–2026; the current year is
 *     partial, so filter `ano < EXTRACT(YEAR FROM CURRENT_DATE)::int` for
 *     fully-reported aggregates.
 */
export const SAGE_SQL_SCHEMA_SUMMARY = `
Read-only views available to Sage SQL (denue_sage role).

# Per-municipio (5-digit cve_mun TEXT). Drop SESNSP catch-all rows with
#   AND cve_mun NOT LIKE '%999' AND cve_mun NOT LIKE '%998'.

censo_municipios(cve_mun, entidad, mun, nom_mun, nom_ent, pobtot, pobfem, pobmas, p_60ymas, p_15ymas, p_18ymas, pea, pocupada, graproes, tvivhab, tvivpar, vph_inter, vph_autom, phog_ind, pob_afro, psinder, pder_imss, pder_iste, pder_segp, pafil_ipriv)
coneval_pobreza_municipal(cve_mun, clave_entidad, entidad_federativa, municipio, poblacion, pobreza_pct, pobreza_personas, pobreza_extrema_pct, pobreza_moderada_pct, vulnerable_carencias_pct, vulnerable_ingreso_pct, no_pobre_no_vul_pct, carencia_rezago_edu_pct, carencia_acceso_salud_pct, carencia_seg_social_pct, carencia_calidad_vivienda_pct, carencia_serv_basicos_pct, carencia_alimentacion_pct, pob_lp_ingreso_pct)
coneval_irs_municipal(cve_mun, cve_ent, entidad, municipio, pob_total, analfabeta_15ymas_pct, no_asisten_escuela_6a14_pct, edu_basica_incompleta_pct, sin_derechohab_salud_pct, viv_piso_tierra_pct, viv_sin_excusado_pct, viv_sin_agua_pct, viv_sin_drenaje_pct, viv_sin_electricidad_pct, irs_indice, irs_grado, irs_lugar_nacional)
sinba_morbidity_municipal(cve_mun, anio, casos_dm2_promedio, casos_hta_promedio, casos_obesidad_promedio, clues_reportando)
cofepris_farmacias_by_municipio(cve_mun, total_licenciadas, con_estupefacientes, con_psicotropicos, con_vacunas, con_toxoides, con_sueros_antitoxinas, con_hemoderivados, hospitalarias, boticas, droguerias)
mv_delitos_municipal_yearly(cve_mun, ano, robo_negocio, homicidio_doloso, extorsion, patrimoniales, violentos, total_delitos)
  -- 2026 is partial; for stable aggregates use ano < EXTRACT(YEAR FROM CURRENT_DATE)::int.
mv_mortalidad_municipal_yearly(cve_mun, ano, total_defunciones, def_menores_1ano, def_circulatorio, def_neoplasias, def_endocrinas, def_externas)
ce2024_municipal(cve_mun, cve_ent, sector, subsector, rama, subrama, clase, id_estrato, ue, personal_ocupado_total, valor_agregado_censal_bruto, ingresos_totales, remuneraciones, produccion_bruta_total)
sedatu_financing_by_municipio(cve_mun, cve_ent, periodo, acciones_total, monto_total, monto_per_accion_avg, top_organismo_code, top_organismo_nombre, pct_vivienda_nueva, pct_mejoramientos, pct_femenino, pct_credito_individual)
cnbv_panorama_municipal(cve_mun, clave_municipio_num, nom_ent, nom_mun, rezago_social, poblacion_total, poblacion_adulta, sucursales_total, cajeros_total, tpv_total, cuentas_total, creditos_total, tx_tpv_total, remesas_mdd, periodo)
cnbv_credito_by_municipio(cve_mun, cve_ent, periodo, acciones_total, monto_total, monto_per_accion_avg, top_intermediario_code, top_intermediario_nombre, top_intermediario_share, pct_vivienda_nueva, pct_femenino, pct_indigena, pct_economica, pct_popular, pct_tradicional, pct_media, pct_residencial, pct_residencial_plus)
sict_traffic_by_municipio(cve_mun, cve_ent, station_count, tdpa_total, tdpa_max, tdpa_mean, pct_motos, pct_autos, pct_buses, pct_camiones, route_count)
aeropuertos_by_municipio(cve_mun, cve_ent, num_airports_active_2026, mar_flights_recent_avg, mar_flights_2019_baseline, mar_flights_2026, pct_change_vs_2019)
clues(clave_clues, institucion, institucion_nombre, entidad, cve_mun, cve_loc, municipio_nombre, localidad_nombre, tipologia, tipo_establecimiento, unidad_nombre, nivel_atencion_nombre, estatus, lat, lon)

# Per-AGEB (13-char cvegeo TEXT)
censo_ageb(cvegeo, entidad, mun, loc, ageb, nom_loc, pobtot, pobfem, pobmas, p_60ymas, p_15ymas, p_18ymas, pea, pocupada, graproes, tvivhab, tvivpar, vph_inter, vph_autom, psinder, pder_imss, pder_iste, pafil_ipriv)
  -- pct_sin_cobertura_salud is computed as (psinder::float / pobtot) * 100 WHEN pobtot > 0.
censo_manzana(cvegeo_ageb, entidad, mun, loc, ageb, mza, pobtot, pobfem, pobmas, tvivpar, vph_inter, vph_autom)
coneval_grs_ageb(cvegeo, pobtot, vivpar_hab, ind_analfabeta, ind_no_escuela_6_14, ind_basica_incompleta, ind_sin_salud, ind_hacinamiento, ind_sin_agua, ind_sin_excusado, ind_sin_drenaje, ind_sin_luz, ind_piso_tierra, ind_sin_internet, grado)
cofepris_farmacias_by_ageb(cvegeo_ageb, total_licenciadas, con_controlados)

# Per-entidad (2-digit cve_ent TEXT)
censo_entidades(cve_ent, entidad, nom_ent, pobtot, pobfem, pobmas, p_60ymas, p_15ymas, pea, pocupada, graproes, phog_ind, pob_afro, psinder, pder_imss, pder_iste, pafil_ipriv)
bienestar_estatal_latest(cve_ent, nom_ent_bienestar, beneficiarios, intervenciones, dependencias, padrones, programas, anio, trimestre)
cnbv_panorama_estatal(cve_ent, nom_ent, poblacion_total, poblacion_adulta, sucursales_total, cajeros_total, tpv_total, cuentas_total, creditos_total, tx_tpv_total, remesas_mdd, condusef_reclamaciones, periodo)
cnbv_credito_estado_grain_2025(cve_ent, entidad, ano, mes, modalidad, linea_credito, sexo, edad_rango, vivienda_valor, poblacion_indigena, zona, monto, acciones, intermediario_financiero)
sedatu_financiamientos_estado_grain_2025(cve_ent, entidad, ano, mes, organismo, modalidad, destino, tipo, sexo, edad_rango, vivienda_valor, acciones, monto)
sict_traffic_by_estado(cve_ent, station_count, tdpa_total, tdpa_max, tdpa_mean, pct_motos, pct_autos, pct_buses, pct_camiones, route_count)
cnbv_credito_by_estado(cve_ent, periodo, acciones_total, monto_total, monto_per_accion_avg, top_intermediario_code, top_intermediario_nombre, pct_vivienda_nueva, pct_femenino, pct_indigena)
sedatu_financing_by_estado(cve_ent, periodo, acciones_total, monto_total, monto_per_accion_avg, top_organismo_code, top_organismo_nombre, pct_vivienda_nueva, pct_femenino, pct_credito_individual)

# Aggregate MVs (national-grain)
mv_national_treemap(entidad, establecimientos, modal_irs_grado, pobreza_pct_promedio)
mv_sector_grade_matrix(scian, irs_grado, count)
mv_coverage(entidad, loaded, first_loaded_at, last_updated_at, with_geom, with_telefono, with_correo_e)

# Joining
#   cve_mun = LEFT(cvegeo, 5) for AGEB → muni rollups.
#   cve_ent = LEFT(cve_mun, 2).
#   All keys are TEXT with zero-padding.
`.trim();
