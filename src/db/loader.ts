/**
 * DENUE Loader — Fase 2
 * Inserta / upserta registros JSON del extractor en Supabase (PostgreSQL + PostGIS).
 *
 * Estrategia de upsert: ON CONFLICT (clee) DO UPDATE.
 * Esto permite recargar el mismo archivo sin duplicar registros.
 */

import { readFileSync } from "fs";
import type { DenueRawRecord } from "../extractor/types.js";

export type { DenueRawRecord };

/** Registro normalizado listo para insertar en la tabla */
export interface EstablecimientoRow {
  clee: string;
  denue_id: string | null;
  nombre: string | null;
  razon_social: string | null;
  clase_actividad_id: string | null;
  clase_actividad: string | null;
  sector_actividad_id: string | null;
  subsector_actividad_id: string | null;
  rama_actividad_id: string | null;
  subrama_actividad_id: string | null;
  estrato: string | null;
  tipo_unidad: string | null;
  tipo_vialidad: string | null;
  calle: string | null;
  num_exterior: string | null;
  num_interior: string | null;
  colonia: string | null;
  tipo_asentamiento: string | null;
  cp: string | null;
  municipio: string | null;
  entidad: string | null;
  ubicacion: string | null;
  edificio: string | null;
  edificio_piso: string | null;
  numero_local: string | null;
  ageb: string | null;
  manzana: string | null;
  corredor_industrial: string | null;
  nom_corredor_industrial: string | null;
  area_geo: string | null;
  telefono: string | null;
  correo_e: string | null;
  sitio_internet: string | null;
  latitud: number | null;
  longitud: number | null;
  fecha_alta: string | null;
  raw_json: DenueRawRecord;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convierte string vacío o "null" a null */
function clean(val: string | undefined | null): string | null {
  if (!val || val.trim() === "" || val.trim().toLowerCase() === "null")
    return null;
  return val.trim();
}

/** Parsea coordenada — retorna null si no es número válido */
function parseCoord(val: string | undefined | null): number | null {
  if (!val || val.trim() === "") return null;
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

/** Parsea fecha ISO o DD/MM/YYYY → YYYY-MM-DD para PostgreSQL */
function parseDate(val: string | undefined | null): string | null {
  if (!val || val.trim() === "") return null;
  // Formato DD/MM/YYYY
  const ddmmyyyy = val.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (ddmmyyyy) return `${ddmmyyyy[3]}-${ddmmyyyy[2]}-${ddmmyyyy[1]}`;
  // Ya está en ISO
  if (/^\d{4}-\d{2}-\d{2}/.test(val)) return val.slice(0, 10);
  return null;
}

/**
 * Extrae la clave de entidad (2 dígitos) del CLEE.
 * CLEE format: 2-digit entidad + 3-digit municipio + ... (always present in real API).
 * AreaGeo is NOT returned by buscarEntidad — do not use it for entidad extraction.
 *
 * IMPORTANTE — comportamiento por diseño (verificado 2026-05-03):
 * BuscarEntidad/<X>/... puede devolver registros cuyo CLEE NO empieza con X.
 * Son sucursales que OPERAN físicamente en X pero cuya registración canónica
 * (CLEE primary key) está en otra entidad. Ejemplos en producción:
 * - "CAC NANACAMILPA" (sucursal CFE en Tlaxcala, CLEE 21... = Puebla)
 * - "FIRST CASH SUCURSAL 827 GTO" (sucursal en Tlaxcala, CLEE 01... = Aguascalientes)
 *
 * Extraemos por prefijo CLEE (no por la entidad consultada) para que la entidad
 * almacenada sea la canónica. Resultado: ~0.02-0.03% de cada extracción
 * estatal queda asignado a otra entidad. Esto es CORRECTO, no un bug.
 * Verificado: Tlaxcala 19/98,711 (0.019%), Colima 11/41,756 (0.026%).
 */
function extractEntidad(clee: string | undefined | null): string | null {
  if (!clee || clee.length < 2) return null;
  return clee.slice(0, 2);
}

/**
 * Derive a SCIAN code of `length` digits from CLEE chars 6..6+length.
 * CLEE structure: <2:entidad><3:municipio><6:clase_actividad>... — so
 * the SCIAN class is at chars 6-11 (1-indexed) i.e. slice(5, 5+length).
 *
 * BuscarEntidad doesn't return CLASE_ACTIVIDAD_ID/SECTOR_ACTIVIDAD_ID/etc.,
 * so without this fallback every row stores NULL for the SCIAN hierarchy.
 * Returns null if CLEE is too short or the slice isn't all digits.
 */
function deriveScian(
  clee: string | undefined | null,
  length: number,
): string | null {
  if (!clee || clee.length < 5 + length) return null;
  const slice = clee.slice(5, 5 + length);
  if (!/^[0-9]+$/.test(slice)) return null;
  return slice;
}

/**
 * Derive area_geo (CVE_MUN_5 = CVE_ENT||CVE_MUN, INEGI standard) from CLEE
 * chars 1-5. This is the join key for CONEVAL, SESNSP, CE 2024, Datatur,
 * CLUES — every municipal-level government dataset on the v0.2.x roadmap.
 *
 * BuscarEntidad doesn't return AreaGeo, so without this fallback every
 * row stores NULL and no municipal join works. Returns null only if CLEE
 * is too short (<5 chars) — no numeric guard since INEGI municipality
 * codes are always 5 digits and CLEEs in this corpus are 27-28 chars.
 */
function deriveAreaGeo(clee: string | undefined | null): string | null {
  if (!clee || clee.length < 5) return null;
  const slice = clee.slice(0, 5);
  if (!/^[0-9]{5}$/.test(slice)) return null;
  return slice;
}

/** Transforma un registro crudo DENUE en una fila normalizada */
export function transform(raw: DenueRawRecord): EstablecimientoRow {
  return {
    clee: raw.CLEE,
    denue_id: clean(raw.Id),
    nombre: clean(raw.Nombre),
    razon_social: clean(raw.Razon_social),
    clase_actividad_id:
      clean(raw.CLASE_ACTIVIDAD_ID) ?? deriveScian(raw.CLEE, 6),
    clase_actividad: clean(raw.Clase_actividad),
    sector_actividad_id:
      clean(raw.SECTOR_ACTIVIDAD_ID) ?? deriveScian(raw.CLEE, 2),
    subsector_actividad_id:
      clean(raw.SUBSECTOR_ACTIVIDAD_ID) ?? deriveScian(raw.CLEE, 3),
    rama_actividad_id: clean(raw.RAMA_ACTIVIDAD_ID) ?? deriveScian(raw.CLEE, 4),
    subrama_actividad_id:
      clean(raw.SUBRAMA_ACTIVIDAD_ID) ?? deriveScian(raw.CLEE, 5),
    estrato: clean(raw.Estrato),
    tipo_unidad: clean(raw.Tipo),
    tipo_vialidad: clean(raw.Tipo_vialidad),
    calle: clean(raw.Calle),
    num_exterior: clean(raw.Num_Exterior),
    num_interior: clean(raw.Num_Interior),
    colonia: clean(raw.Colonia),
    tipo_asentamiento: clean(raw.Tipo_Asentamiento),
    cp: clean(raw.CP),
    municipio: extractMunicipio(clean(raw.Ubicacion)),
    entidad: extractEntidad(raw.CLEE),
    ubicacion: clean(raw.Ubicacion),
    edificio: clean(raw.EDIFICIO),
    edificio_piso: clean(raw.EDIFICIO_PISO),
    numero_local: clean(raw.numero_local),
    ageb: clean(raw.AGEB),
    manzana: clean(raw.Manzana),
    corredor_industrial: clean(raw.tipo_corredor_industrial),
    nom_corredor_industrial: clean(raw.nom_corredor_industrial),
    area_geo: clean(raw.AreaGeo) ?? deriveAreaGeo(raw.CLEE),
    telefono: clean(raw.Telefono),
    correo_e: clean(raw.Correo_e),
    sitio_internet: clean(raw.Sitio_internet),
    latitud: parseCoord(raw.Latitud),
    longitud: parseCoord(raw.Longitud),
    fecha_alta: parseDate(raw.Fecha_Alta),
    raw_json: raw,
  };
}

/**
 * Extrae el nombre del municipio del campo Ubicacion.
 * Formato típico: "MUNICIPIO, ESTADO" o "MUNICIPIO"
 */
function extractMunicipio(ubicacion: string | null): string | null {
  if (!ubicacion) return null;
  const parts = ubicacion.split(",");
  return parts[0].trim() || null;
}

// ---------------------------------------------------------------------------
// Cliente Supabase REST (sin dependencias externas)
// Usamos la API PostgREST directamente con fetch nativo de Node 18+
// ---------------------------------------------------------------------------

export interface LoaderConfig {
  supabaseUrl: string; // ej. "http://localhost:8100"
  serviceRoleKey: string; // JWT service_role
  batchSize?: number; // registros por batch (default: 100)
}

export interface LoadResult {
  inserted: number;
  errors: Array<{ clee: string; error: string }>;
  durationMs: number;
}

/**
 * Carga un array de registros DENUE en Supabase via upsert.
 * Usa chunking para no saturar la API con payloads enormes.
 */
export async function loadRecords(
  records: DenueRawRecord[],
  config: LoaderConfig,
): Promise<LoadResult> {
  const { supabaseUrl, serviceRoleKey, batchSize = 100 } = config;
  const startMs = Date.now();

  // Filter out records with empty CLEE — a missing primary key would fail the upsert
  // and poison the entire batch. Log and skip so one bad row doesn't abort a 100-row chunk.
  const validRecords = records.filter((r) => {
    if (!r.CLEE || r.CLEE.trim() === "") {
      console.warn(
        `[Loader] Skipping record with empty CLEE: Id=${r.Id ?? "(unknown)"}`,
      );
      return false;
    }
    return true;
  });

  const rows = validRecords.map(transform);
  const result: LoadResult = { inserted: 0, errors: [], durationMs: 0 };

  // Chunk en lotes
  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);

    // Construir payload para upsert.
    // - geom NO está en EstablecimientoRow — Postgres lo calcula con updateGeometry()
    // - raw_json se pasa como objeto (no string) para que PostgREST lo trate como JSONB
    const payload = chunk;

    // ?on_conflict=clee is required for PostgREST upsert on a non-PK unique column.
    // The table uses id (bigserial) as PK and clee as UNIQUE. Without this param,
    // PostgREST ignores Prefer: resolution=merge-duplicates and issues a plain INSERT,
    // returning HTTP 409 on duplicate CLEE. Verified on PostgREST 12.2.3.
    const url = `${supabaseUrl}/rest/v1/establecimientos?on_conflict=clee`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Marcar todos los registros del chunk como error
      for (const row of chunk) {
        result.errors.push({ clee: row.clee, error: errorText });
      }
      continue;
    }

    const returned = (await response.json()) as unknown[];
    result.inserted += returned.length;
  }

  result.durationMs = Date.now() - startMs;
  return result;
}

/**
 * Actualiza la columna geom a partir de latitud/longitud ya almacenadas.
 * Se ejecuta una sola vez después de la carga inicial.
 *
 * Requiere que exista la función RPC `exec_sql` en Supabase, o usa
 * docker exec como fallback si la env var SUPABASE_DB_CONTAINER está definida.
 */
export async function updateGeometry(
  config: LoaderConfig,
): Promise<{ updated: number }> {
  const { supabaseUrl, serviceRoleKey } = config;

  const sql = `
    UPDATE establecimientos
    SET geom = ST_SetSRID(ST_MakePoint(longitud::float8, latitud::float8), 4326)
    WHERE latitud IS NOT NULL
      AND longitud IS NOT NULL
      AND geom IS NULL
  `;

  // Intentar via docker exec (disponible en el VPS)
  const container = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  const { execSync } = await import("child_process");
  try {
    const psqlCmd = `docker exec ${container} psql -U postgres -d postgres -c "${sql.replace(/\n\s+/g, " ").trim()}"`;
    const output = execSync(psqlCmd, { encoding: "utf-8" });
    // Output típico: "UPDATE 29"
    const match = output.match(/UPDATE (\d+)/);
    const updated = match ? parseInt(match[1]!, 10) : 0;
    console.log(`✅ Geometrías actualizadas: ${updated} registros`);
    return { updated };
  } catch (err) {
    // Fallback: instrucción manual
    console.warn(
      "⚠️  No se pudo ejecutar geometry update via docker exec:",
      (err as Error).message,
    );
    console.log("Ejecuta manualmente:");
    console.log(
      `  docker exec ${container} psql -U postgres -d postgres -c "${sql.replace(/\n\s+/g, " ").trim()}"`,
    );
    void supabaseUrl;
    void serviceRoleKey;
    return { updated: 0 };
  }
}

// ---------------------------------------------------------------------------
// Función de utilidad: leer JSON del extractor desde disco
// ---------------------------------------------------------------------------
export function readExtractorOutput(filePath: string): DenueRawRecord[] {
  const raw = readFileSync(filePath, "utf-8");
  const data = JSON.parse(raw) as unknown;
  if (!Array.isArray(data)) {
    throw new Error(`El archivo ${filePath} no contiene un array JSON`);
  }
  return data as DenueRawRecord[];
}
