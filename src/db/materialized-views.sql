-- =============================================================================
-- DENUE Analysis — Materialized Views
-- Apply with: psql $DATABASE_URL < src/db/materialized-views.sql
-- Refresh with: REFRESH MATERIALIZED VIEW CONCURRENTLY mv_sector_summary;
--               REFRESH MATERIALIZED VIEW CONCURRENTLY mv_coverage;
-- =============================================================================

-- -----------------------------------------------------------------------------
-- mv_sector_summary
-- Top sectores por clase_actividad_id, opcionalmente por entidad.
-- Use: SELECT * FROM mv_sector_summary WHERE entidad = '09' ORDER BY total DESC;
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_sector_summary AS
SELECT
  entidad,
  clase_actividad_id,
  clase_actividad,
  COUNT(*)::BIGINT AS total
FROM establecimientos
GROUP BY entidad, clase_actividad_id, clase_actividad
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_sector_summary_pk
  ON mv_sector_summary (entidad, clase_actividad_id);

-- -----------------------------------------------------------------------------
-- mv_coverage
-- Cobertura por entidad: cuántos registros están cargados en la BD.
-- inegi_total es null — no hay fuente autoritativa embebida; actualizar manualmente
-- con UPDATE mv_coverage SET inegi_total = N WHERE entidad = 'XX' si se dispone.
-- Nota: los MVs son de solo lectura en PostgreSQL; la columna queda como
-- referencia para una tabla separada si se requiere comparación con INEGI.
-- -----------------------------------------------------------------------------
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_coverage AS
SELECT
  entidad,
  COUNT(*)::BIGINT                                   AS loaded,
  MIN(created_at)                                    AS first_loaded_at,
  MAX(updated_at)                                    AS last_updated_at,
  COUNT(*) FILTER (WHERE geom IS NOT NULL)::BIGINT   AS with_geom,
  COUNT(*) FILTER (WHERE telefono IS NOT NULL AND telefono <> '')::BIGINT AS with_telefono,
  COUNT(*) FILTER (WHERE correo_e IS NOT NULL AND correo_e <> '')::BIGINT AS with_correo_e
FROM establecimientos
GROUP BY entidad
WITH DATA;

CREATE UNIQUE INDEX IF NOT EXISTS mv_coverage_pk
  ON mv_coverage (entidad);

-- Grant read access to the anon/authenticated roles (Supabase standard)
GRANT SELECT ON mv_sector_summary TO anon, authenticated;
GRANT SELECT ON mv_coverage TO anon, authenticated;
