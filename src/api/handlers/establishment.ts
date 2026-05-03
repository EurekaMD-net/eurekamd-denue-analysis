/**
 * GET /establishment/:clee — single record lookup.
 *
 * CLEE format: 20-30 alphanumeric chars (DENUE pattern). Validated before
 * sending to PostgREST so a malformed CLEE returns 400 instead of 200 with
 * empty rows.
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import {
  CLEE_RE,
  type ApiServerConfig,
  type EstablishmentResult,
} from "../types.js";

export async function establishmentHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const clee = c.req.param("clee");
  if (!clee || !CLEE_RE.test(clee)) {
    throw new HttpError(`CLEE inválido "${clee}"`, 400, "validation.clee");
  }

  const url = `${config.supabaseUrl}/rest/v1/establecimientos?clee=eq.${encodeURIComponent(clee)}&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new HttpError(
      `PostgREST returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      502,
      "postgrest.error",
    );
  }
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  if (rows.length === 0) {
    throw new HttpError(
      `Establecimiento "${clee}" no encontrado`,
      404,
      "not_found",
    );
  }

  const result: EstablishmentResult = { clee, data: rows[0]! };
  return c.json(result);
}
