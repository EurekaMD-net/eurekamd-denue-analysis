/**
 * Tipos para la API DENUE de INEGI
 * Documentación: https://www.inegi.org.mx/servicios/api_denue.html
 */

export interface DenueEstablishment {
  /** ID único del establecimiento en DENUE */
  Id: string;
  /** Nombre comercial del establecimiento */
  Nombre: string;
  /** Razón social registrada */
  Razon_social: string;
  /** Clase de actividad económica (SCIAN descriptivo) */
  Clase_actividad: string;
  /** Código SCIAN de 6 dígitos */
  Codigo_actividad: string;
  /** Estrato por número de empleados */
  Estrato: string;
  /** Tipo de vialidad (CALLE, AVENIDA, etc.) */
  Tipo_vialidad: string;
  /** Nombre de la vialidad */
  Nom_vialidad: string;
  /** Número exterior */
  Num_exterior: string;
  /** Número interior */
  Num_interior: string;
  /** Nombre de la colonia */
  Nom_colonia: string;
  /** Nombre del municipio */
  Nom_municipio: string;
  /** Nombre del estado */
  Nom_estado: string;
  /** Código postal */
  Codigo_postal: string;
  /** Ubicación geográfica completa */
  Ubicacion: string;
  /** Teléfono (cuando disponible) */
  Telefono: string;
  /** Correo electrónico (cuando disponible) */
  Correo_e: string;
  /** Sitio web (cuando disponible) */
  Www: string;
  /** Longitud geográfica */
  Longitud: string;
  /** Latitud geográfica */
  Latitud: string;
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
