/**
 * Runner: GeoJSON Export
 *
 * Exporta establecimientos como GeoJSON FeatureCollection.
 * Cada establecimiento con latitud/longitud se convierte en un Feature Point.
 * Establecimientos sin coordenadas tienen geometry: null (GeoJSON válido).
 *
 * Usa la vista establecimientos_geo (solo registros con geom) cuando el
 * flag withGeomOnly=true (default). Para exportar TODOS incluyendo los
 * sin coordenadas, usar withGeomOnly=false.
 */

import type {
  AnalysisConfig,
  GeoJsonFeature,
  GeoJsonFeatureCollection,
} from "./types.js";

export interface GeoJsonExportOptions {
  /** Filtrar por entidad (clave 2 dígitos). null = todos */
  entidad?: string | null;
  /** Solo exportar establecimientos con geometría (default: true) */
  withGeomOnly?: boolean;
  /** Máximo de features a exportar. null = sin límite */
  limit?: number | null;
}

export interface GeoJsonExportResult {
  collection: GeoJsonFeatureCollection;
  total: number;
  withoutGeometry: number;
}

/** Columnas a proyectar (sin geom — usamos latitud/longitud para construir Point) */
const COLUMNS = [
  "clee",
  "denue_id",
  "nombre",
  "razon_social",
  "clase_actividad_id",
  "clase_actividad",
  "estrato",
  "tipo_unidad",
  "calle",
  "num_exterior",
  "num_interior",
  "colonia",
  "cp",
  "municipio",
  "entidad",
  "ubicacion",
  "telefono",
  "correo_e",
  "sitio_internet",
  "latitud",
  "longitud",
  "fecha_alta",
].join(",");

/** Convierte una fila de Supabase a GeoJSON Feature */
function rowToFeature(row: Record<string, unknown>): GeoJsonFeature {
  const lat = row["latitud"] != null ? Number(row["latitud"]) : null;
  const lon = row["longitud"] != null ? Number(row["longitud"]) : null;

  const hasCoords =
    lat !== null &&
    lon !== null &&
    !isNaN(lat) &&
    !isNaN(lon);

  // Exclude lat/lon from properties — they're in geometry
  const { latitud: _lat, longitud: _lon, ...props } = row;

  return {
    type: "Feature",
    geometry: hasCoords
      ? { type: "Point", coordinates: [lon!, lat!] }
      : null,
    properties: props,
  };
}

/**
 * Exporta establecimientos como GeoJSON FeatureCollection.
 *
 * Pagina sobre /rest/v1/establecimientos en lotes de 1000.
 * Para entidades grandes (CDMX ~600k) esto puede tardar varios minutos.
 */
export async function exportGeoJson(
  config: AnalysisConfig,
  options: GeoJsonExportOptions = {},
): Promise<GeoJsonExportResult> {
  const { supabaseUrl, serviceRoleKey } = config;
  const { entidad = null, withGeomOnly = true, limit = null } = options;

  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
    Prefer: "count=exact",
  };

  const PAGE_SIZE = 1000;
  const features: GeoJsonFeature[] = [];
  let offset = 0;
  let totalRows = Infinity;
  let withoutGeometry = 0;

  while (offset < totalRows) {
    const remaining = limit !== null ? limit - features.length : PAGE_SIZE;
    if (remaining <= 0) break;

    const pageLimit = Math.min(PAGE_SIZE, remaining);

    const params = new URLSearchParams({
      select: COLUMNS,
      limit: String(pageLimit),
      offset: String(offset),
    });

    if (entidad) {
      params.set("entidad", `eq.${entidad}`);
    }

    if (withGeomOnly) {
      // latitud IS NOT NULL AND longitud IS NOT NULL
      params.set("latitud", "not.is.null");
      params.set("longitud", "not.is.null");
    }

    const url = `${supabaseUrl}/rest/v1/establecimientos?${params.toString()}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`exportGeoJson: PostgREST returned HTTP ${res.status}: ${body}`);
    }

    if (offset === 0) {
      const contentRange = res.headers.get("content-range");
      if (contentRange) {
        const match = contentRange.match(/\/(\d+)$/);
        if (match) totalRows = parseInt(match[1]!, 10);
      }
    }

    const page = (await res.json()) as Array<Record<string, unknown>>;
    if (page.length === 0) break;

    for (const row of page) {
      const feature = rowToFeature(row);
      features.push(feature);
      if (feature.geometry === null) withoutGeometry++;
    }

    offset += PAGE_SIZE;
    if (page.length < pageLimit) break;
  }

  return {
    collection: {
      type: "FeatureCollection",
      features,
    },
    total: features.length,
    withoutGeometry,
  };
}
