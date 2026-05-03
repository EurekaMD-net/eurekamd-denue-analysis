/**
 * Tipos compartidos para los runners de análisis DENUE.
 */

/** Config de conexión a Supabase (reutiliza el mismo patrón que LoaderConfig) */
export interface AnalysisConfig {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Nombre del contenedor Docker de Postgres (para docker exec / psql) */
  dbContainer?: string;
}

// ---------------------------------------------------------------------------
// Sector summary runner
// ---------------------------------------------------------------------------

export interface SectorCount {
  clase_actividad_id: string;
  clase_actividad: string | null;
  count: number;
}

export interface SectorSummaryResult {
  entidad: string | null;
  total: number;
  rows: SectorCount[];
}

// ---------------------------------------------------------------------------
// Top municipios runner
// ---------------------------------------------------------------------------

export interface MunicipioCount {
  municipio: string | null;
  entidad: string | null;
  count: number;
}

export interface TopMunicipiosResult {
  entidad: string | null;
  limit: number;
  rows: MunicipioCount[];
}

// ---------------------------------------------------------------------------
// GeoJSON export runner
// ---------------------------------------------------------------------------

export interface GeoJsonFeature {
  type: "Feature";
  geometry: {
    type: "Point";
    coordinates: [number, number]; // [longitud, latitud]
  } | null;
  properties: Record<string, unknown>;
}

export interface GeoJsonFeatureCollection {
  type: "FeatureCollection";
  features: GeoJsonFeature[];
}
