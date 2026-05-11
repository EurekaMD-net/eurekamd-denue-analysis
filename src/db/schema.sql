-- =============================================================================
-- DENUE Analysis — Schema v1
-- Supabase / PostgreSQL + PostGIS
-- =============================================================================

-- Habilitar extensión espacial (idempotente)
CREATE EXTENSION IF NOT EXISTS postgis;

-- -----------------------------------------------------------------------------
-- Tabla principal de establecimientos DENUE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS establecimientos (
  -- Clave primaria interna
  id               BIGSERIAL PRIMARY KEY,

  -- Identificador único del directorio DENUE
  clee             TEXT UNIQUE NOT NULL,       -- Clave DENUE (CLEE)
  denue_id         TEXT,                        -- Id numérico del registro

  -- Datos del negocio
  nombre           TEXT,
  razon_social     TEXT,

  -- Clasificación SCIAN
  clase_actividad_id    TEXT,                  -- código 6 dígitos (ej. 622311)
  clase_actividad       TEXT,                  -- nombre de la clase
  sector_actividad_id   TEXT,
  subsector_actividad_id TEXT,
  rama_actividad_id     TEXT,
  subrama_actividad_id  TEXT,

  -- Tamaño
  estrato          TEXT,                        -- rango de empleados (ej. "11 a 30 personas")
  tipo_unidad      TEXT,                        -- Fijo / Semifijo / etc.

  -- Domicilio
  tipo_vialidad    TEXT,
  calle            TEXT,
  num_exterior     TEXT,
  num_interior     TEXT,
  colonia          TEXT,
  tipo_asentamiento TEXT,
  cp               TEXT,
  municipio        TEXT,                        -- nombre del municipio/delegación
  entidad          TEXT,                        -- clave de entidad (ej. "09")
  ubicacion        TEXT,                        -- texto completo (estado, municipio)
  edificio         TEXT,
  edificio_piso    TEXT,
  numero_local     TEXT,
  ageb             TEXT,                        -- 13-char CVEGEO (ENT+MUN+LOC+AGEB). Filled by scripts/backfill-ageb.ts via PostGIS spatial join against ageb_polygons (loaded from INEGI Marco Geoestadístico 2020). Joins to Censo 2020 / CONEVAL.
  manzana          TEXT,
  corredor_industrial TEXT,
  nom_corredor_industrial TEXT,

  -- Contacto
  telefono         TEXT,
  correo_e         TEXT,
  sitio_internet   TEXT,

  -- Coordenadas
  latitud          NUMERIC(10, 7),
  longitud         NUMERIC(10, 7),
  geom             GEOMETRY(Point, 4326),       -- punto espacial WGS84

  -- Área geográfica
  area_geo         TEXT,                        -- CVE_ENT||CVE_MUN (5 dígitos, ej. "09012") — INEGI standard municipal join key for CONEVAL/SESNSP/CE 2024/Datatur/CLUES. Backfilled from CLEE chars 1-5 in src/db/loader.ts:deriveAreaGeo().

  -- Fechas
  fecha_alta       DATE,

  -- Registro completo sin parsear (para auditoría / campos futuros)
  raw_json         JSONB,

  -- Metadatos de carga
  created_at       TIMESTAMPTZ DEFAULT NOW(),
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

-- -----------------------------------------------------------------------------
-- Índices
-- -----------------------------------------------------------------------------

-- Búsqueda por entidad/estado
CREATE INDEX IF NOT EXISTS idx_estab_entidad
  ON establecimientos(entidad);

-- Búsqueda por municipio dentro de entidad
CREATE INDEX IF NOT EXISTS idx_estab_area_geo
  ON establecimientos(area_geo);

-- Búsqueda por actividad económica
CREATE INDEX IF NOT EXISTS idx_estab_clase_actividad
  ON establecimientos(clase_actividad_id);

-- Búsqueda por sector (2 dígitos SCIAN)
CREATE INDEX IF NOT EXISTS idx_estab_sector
  ON establecimientos(sector_actividad_id);

-- v0.3.1 RH-5: índices por nivel intermedio SCIAN para que /tiles con
-- bundles multi-SCIAN (códigos 3/4/5 dígitos) use index scan en vez de
-- seq scan sobre 16M filas. Migración en vivo aplicada CONCURRENTLY el
-- 2026-05-11 — este archivo es la fuente canónica para nuevos despliegues.
CREATE INDEX IF NOT EXISTS idx_estab_subsector
  ON establecimientos(subsector_actividad_id);
CREATE INDEX IF NOT EXISTS idx_estab_rama
  ON establecimientos(rama_actividad_id);
CREATE INDEX IF NOT EXISTS idx_estab_subrama
  ON establecimientos(subrama_actividad_id);

-- Índice espacial GIST para consultas geográficas
CREATE INDEX IF NOT EXISTS idx_estab_geom
  ON establecimientos USING GIST(geom);

-- Índice para texto libre (nombre)
CREATE INDEX IF NOT EXISTS idx_estab_nombre
  ON establecimientos USING gin(to_tsvector('spanish', coalesce(nombre, '')));

-- -----------------------------------------------------------------------------
-- Trigger: actualizar updated_at automáticamente
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_estab_updated_at ON establecimientos;
CREATE TRIGGER trg_estab_updated_at
  BEFORE UPDATE ON establecimientos
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- -----------------------------------------------------------------------------
-- Vista útil: establecimientos con coordenadas como GeoJSON
-- -----------------------------------------------------------------------------
CREATE OR REPLACE VIEW establecimientos_geo AS
SELECT
  id,
  clee,
  nombre,
  clase_actividad_id,
  clase_actividad,
  estrato,
  municipio,
  entidad,
  colonia,
  cp,
  telefono,
  correo_e,
  sitio_internet,
  latitud,
  longitud,
  ST_AsGeoJSON(geom)::jsonb AS geojson,
  fecha_alta
FROM establecimientos
WHERE geom IS NOT NULL;
