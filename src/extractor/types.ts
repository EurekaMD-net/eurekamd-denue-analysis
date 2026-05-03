/**
 * Tipos para la API DENUE de INEGI
 * Documentación: https://www.inegi.org.mx/servicios/api_denue.html
 *
 * Source of truth: real API response captured 2026-05-03 in
 * tests/fixtures/denue-real-09-sample.json (22 fields guaranteed present).
 *
 * NOTE: DenueEstablishment was deleted — it used fabricated field names
 * (Nom_vialidad, Nom_colonia, Nom_municipio, Codigo_actividad, etc.) that
 * do NOT exist in real API responses. Use DenueRawRecord everywhere.
 */

/**
 * Verbatim shape returned by buscarEntidad / BuscarAreaAct endpoints.
 * Fields present in every real response are required. Fields that appeared
 * in older documentation but are absent from the real API are optional.
 */
export interface DenueRawRecord {
  /** Clave Única de Establecimiento Económico (always present) */
  CLEE: string;
  Id: string;
  Nombre: string;
  Razon_social: string;
  /** Descripción textual de la clase SCIAN */
  Clase_actividad: string;
  Estrato: string;
  Tipo_vialidad: string;
  Calle: string;
  Num_Exterior: string;
  Num_Interior: string;
  Colonia: string;
  CP: string;
  /** Format: "MUNICIPIO, Municipio, ESTADO" */
  Ubicacion: string;
  Telefono: string;
  Correo_e: string;
  Sitio_internet: string;
  /** Tipo de unidad económica: "Fijo" | "Semifijo" | "En via publica" */
  Tipo: string;
  Longitud: string;
  Latitud: string;
  tipo_corredor_industrial: string;
  nom_corredor_industrial: string;
  numero_local: string;
  // Fields NOT present in buscarEntidad responses (may appear in other endpoints)
  AGEB?: string;
  Manzana?: string;
  CLASE_ACTIVIDAD_ID?: string;
  EDIFICIO_PISO?: string;
  SECTOR_ACTIVIDAD_ID?: string;
  SUBSECTOR_ACTIVIDAD_ID?: string;
  RAMA_ACTIVIDAD_ID?: string;
  SUBRAMA_ACTIVIDAD_ID?: string;
  EDIFICIO?: string;
  Tipo_Asentamiento?: string;
  Fecha_Alta?: string;
  /** Geographic area code — first 2 chars = entidad clave. NOT present in buscarEntidad. */
  AreaGeo?: string;
}

export interface DenueCountResponse {
  /** Total de establecimientos para la consulta */
  Total: string;
}

export interface ExtractorConfig {
  /** Token de acceso a la API DENUE */
  token: string;
  /** Número de registros por página */
  pageSize: number;
  /** Milisegundos de espera entre requests para respetar rate limits */
  delayMs: number;
  /** Número de reintentos en caso de error */
  maxRetries: number;
  /** Directorio de salida para los archivos JSON */
  outputDir: string;
}

export type EstadoClave =
  | "01" | "02" | "03" | "04" | "05" | "06" | "07" | "08"
  | "09" | "10" | "11" | "12" | "13" | "14" | "15" | "16"
  | "17" | "18" | "19" | "20" | "21" | "22" | "23" | "24"
  | "25" | "26" | "27" | "28" | "29" | "30" | "31" | "32";

export const ESTADOS: Record<EstadoClave, string> = {
  "01": "Aguascalientes",
  "02": "Baja California",
  "03": "Baja California Sur",
  "04": "Campeche",
  "05": "Coahuila",
  "06": "Colima",
  "07": "Chiapas",
  "08": "Chihuahua",
  "09": "Ciudad de México",
  "10": "Durango",
  "11": "Guanajuato",
  "12": "Guerrero",
  "13": "Hidalgo",
  "14": "Jalisco",
  "15": "Estado de México",
  "16": "Michoacán",
  "17": "Morelos",
  "18": "Nayarit",
  "19": "Nuevo León",
  "20": "Oaxaca",
  "21": "Puebla",
  "22": "Querétaro",
  "23": "Quintana Roo",
  "24": "San Luis Potosí",
  "25": "Sinaloa",
  "26": "Sonora",
  "27": "Tabasco",
  "28": "Tamaulipas",
  "29": "Tlaxcala",
  "30": "Veracruz",
  "31": "Yucatán",
  "32": "Zacatecas",
};
