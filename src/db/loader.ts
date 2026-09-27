/**
 * DENUE Loader — Fase 2
 * Inserta / upserta registros JSON del extractor en Supabase (PostgreSQL + PostGIS).
 *
 * Estrategia de upsert: ON CONFLICT (clee) DO UPDATE.
 * Esto permite recargar el mismo archivo sin duplicar registros.
 */

import { readFileSync } from "fs";
import { execFileSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { assertSafeContainer } from "../api/handlers/_safe-container.js";
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

const CLASE_CATALOG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "scian_clase_catalog.json",
);
let claseCatalog: Record<string, string> | null = null;

/**
 * SCIAN clase code for a Clase_actividad label, from the catalog built by
 * scripts/gen-scian-clase-catalog.ts. The label is current; CLEE chars 6-11
 * keep the class from registration and miss every later reclassification
 * (audit #131: ~12% of CDMX rows, e.g. an abarrotes store stored as 464111
 * pharmacy). null when the label is absent or not in the catalog.
 */
function claseFromLabel(label: string | null): string | null {
  if (!label) return null;
  claseCatalog ??= (
    JSON.parse(readFileSync(CLASE_CATALOG_PATH, "utf-8")) as {
      clases: Record<string, string>;
    }
  ).clases;
  return Object.hasOwn(claseCatalog, label) ? claseCatalog[label]! : null;
}

/** Transforma un registro crudo DENUE en una fila normalizada */
export function transform(raw: DenueRawRecord): EstablecimientoRow {
  // One source for the whole SCIAN hierarchy: the API code if an endpoint
  // returns it, else the label's catalog code, else CLEE. The sector /
  // subsector / rama / subrama ids are that code's prefixes, so they can
  // never disagree with clase_actividad_id.
  const clase =
    clean(raw.CLASE_ACTIVIDAD_ID) ??
    claseFromLabel(clean(raw.Clase_actividad)) ??
    deriveScian(raw.CLEE, 6);
  return {
    clee: raw.CLEE,
    denue_id: clean(raw.Id),
    nombre: clean(raw.Nombre),
    razon_social: clean(raw.Razon_social),
    clase_actividad_id: clase,
    clase_actividad: clean(raw.Clase_actividad),
    sector_actividad_id: clase?.slice(0, 2) ?? null,
    subsector_actividad_id: clase?.slice(0, 3) ?? null,
    rama_actividad_id: clase?.slice(0, 4) ?? null,
    subrama_actividad_id: clase?.slice(0, 5) ?? null,
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
    // ageb is the 13-char CVEGEO (ENT+MUN+LOC+AGEB), populated by the
    // spatial-join script `scripts/backfill-ageb.ts` after ingest. The
    // DENUE API only returns the 4-char cve_ageb (locality-local, not
    // national-unique) — mixing 4-char API values with 13-char spatial
    // values would break joins to Censo 2020 / CONEVAL. Always start NULL.
    ageb: null,
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
 * Formato DENUE: "LOCALIDAD, Municipio, ESTADO" (audit #40: the first segment
 * is the locality, not the municipio). Locality and state are upper case and
 * the municipio is mixed case — true for every 3-segment row in a 305k-row
 * sample — and locality and municipio names can themselves contain commas
 * ("EL SAUZ (SAUZ ALTO, SAUZ BAJO), Pedro Escobedo, QUERÉTARO"), so the
 * municipio is the mixed-case segments before the state. The SQL backfill
 * scripts/migrations/014-estab-scian-municipio-backfill.sql mirrors this.
 */
function extractMunicipio(ubicacion: string | null): string | null {
  if (!ubicacion) return null;
  const parts = ubicacion.split(",").map((p) => p.trim());
  if (parts.length < 3) return parts[0] || null;
  const mixed = parts.slice(0, -1).filter((p) => p !== p.toUpperCase());
  return (mixed.length > 0 ? mixed.join(", ") : parts[1]) || null;
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
    // - ageb se omite: PostgREST's merge-duplicates becomes ON CONFLICT DO
    //   UPDATE SET <every payload column>, so sending ageb:null would wipe the
    //   13-char CVEGEO written by scripts/backfill-ageb.ts (audit #142).
    //   Columns absent from the payload are left untouched on conflict.
    // - raw_json se pasa como objeto (no string) para que PostgREST lo trate como JSONB
    const payload = chunk.map(({ ageb: _ageb, ...row }) => row);

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
        // return=minimal: only the count is used, and echoing every row back
        // (raw_json included) doubled the transfer (audit #51).
        Prefer: "resolution=merge-duplicates,return=minimal",
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

    result.inserted += chunk.length;
  }

  result.durationMs = Date.now() - startMs;
  return result;
}

/**
 * Actualiza la columna geom a partir de latitud/longitud ya almacenadas.
 * Se ejecuta después de cada carga.
 *
 * Rewrites geom wherever it is missing OR no longer matches latitud/longitud:
 * the upsert never sends geom, so a re-loaded establishment that moved kept
 * its old point (audit #42). Runs psql via docker exec with argv (no shell)
 * after validating the container name (audit #43/#161), under a timeout, and
 * throws on failure so the caller's run fails instead of reporting success
 * with rows that tiles / radius search / clusters cannot see.
 */
export async function updateGeometry(
  config: LoaderConfig,
): Promise<{ updated: number }> {
  void config;
  const sql = `
    UPDATE establecimientos
    SET geom = ST_SetSRID(ST_MakePoint(longitud::float8, latitud::float8), 4326)
    WHERE latitud IS NOT NULL
      AND longitud IS NOT NULL
      AND (geom IS NULL
           OR NOT ST_Equals(geom, ST_SetSRID(ST_MakePoint(longitud::float8, latitud::float8), 4326)))
  `;

  const container = process.env["SUPABASE_DB_CONTAINER"] ?? "supabase-db";
  assertSafeContainer(container);
  const output = execFileSync(
    "docker",
    [
      "exec",
      container,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-c",
      sql,
    ],
    { encoding: "utf-8", timeout: 60 * 60 * 1000 }, // 1h cap — full-table on 6.1M
  );
  // Output típico: "UPDATE 29"
  const match = output.match(/UPDATE (\d+)/);
  if (!match) {
    throw new Error(`updateGeometry: unexpected psql output "${output.trim()}"`);
  }
  const updated = parseInt(match[1]!, 10);
  console.log(`✅ Geometrías actualizadas: ${updated} registros`);
  return { updated };
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
