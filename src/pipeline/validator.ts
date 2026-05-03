/**
 * Validator — Fase 3
 *
 * Valida archivos JSON del extractor ANTES de cargarlos a Supabase.
 * Previene que un archivo corrupto o con shape inesperado corrompa la DB.
 *
 * Estrategia: sample de N registros aleatorios → transform() → verificar campos críticos.
 * Si falla: el estado queda en "failed" y el loop continúa con el siguiente.
 */

import { readFileSync } from "node:fs";
import { transform } from "../db/loader.js";
import type { DenueRawRecord } from "../extractor/types.js";

export interface ValidationResult {
  valid: boolean;
  totalRecords: number;
  sampleSize: number;
  errors: string[];
}

/** Campos que DEBEN ser no-null en cada registro transformado */
const REQUIRED_FIELDS: Array<keyof ReturnType<typeof transform>> = [
  "clee",
  "nombre",
  "clase_actividad",
  "entidad",
  "latitud",
  "longitud",
];

/**
 * Valida un archivo JSON del extractor.
 *
 * @param filePath - Ruta al archivo JSON
 * @param sampleSize - Número de registros a samplear (default: 5)
 */
export function validateExtractorFile(
  filePath: string,
  sampleSize = 5
): ValidationResult {
  const errors: string[] = [];

  // 1. Parsear el JSON
  let records: DenueRawRecord[];
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return { valid: false, totalRecords: 0, sampleSize: 0, errors: ["El archivo no contiene un array JSON"] };
    }
    records = parsed as DenueRawRecord[];
  } catch (err) {
    return {
      valid: false,
      totalRecords: 0,
      sampleSize: 0,
      errors: [`Error al parsear JSON: ${(err as Error).message}`],
    };
  }

  if (records.length === 0) {
    return { valid: false, totalRecords: 0, sampleSize: 0, errors: ["El archivo contiene 0 registros"] };
  }

  // 2. Sample aleatorio
  const actualSample = Math.min(sampleSize, records.length);
  const sampled = pickRandom(records, actualSample);

  // 3. Verificar campos requeridos en cada sample
  for (let i = 0; i < sampled.length; i++) {
    const record = sampled[i]!;

    // Verificar CLEE presente (primary key)
    if (!record.CLEE || record.CLEE.trim() === "") {
      errors.push(`Sample[${i}]: CLEE vacío (Id=${record.Id ?? "(unknown)"})`);
      continue;
    }

    // Transformar y verificar campos críticos
    const row = transform(record);
    for (const field of REQUIRED_FIELDS) {
      const value = row[field];
      if (value === null || value === undefined || value === "") {
        errors.push(`Sample[${i}] CLEE=${record.CLEE}: campo '${field}' es null/vacío`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    totalRecords: records.length,
    sampleSize: actualSample,
    errors,
  };
}

function pickRandom<T>(arr: T[], n: number): T[] {
  if (n >= arr.length) return [...arr];
  const result: T[] = [];
  const used = new Set<number>();
  while (result.length < n) {
    const i = Math.floor(Math.random() * arr.length);
    if (!used.has(i)) {
      used.add(i);
      result.push(arr[i]!);
    }
  }
  return result;
}
