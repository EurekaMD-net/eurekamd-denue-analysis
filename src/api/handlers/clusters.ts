/**
 * GET /clusters?entidad=&scian=&k= — wrapper around clusterBySector runner.
 *
 * The runner already validates inputs with the same regex bounds as this
 * handler's pre-check. Defense in depth: validate at handler boundary too
 * so we return 400 (validation) instead of 500 (runner threw).
 */

import type { Context } from "hono";
import { HttpError } from "../middleware/error.js";
import {
  ENTIDAD_RE,
  SCIAN_RE,
  type ApiServerConfig,
  type ClusterCentroid,
} from "../types.js";
import { clusterBySector } from "../../analysis/cluster-by-sector.js";

export async function clustersHandler(
  c: Context,
  config: ApiServerConfig,
): Promise<Response> {
  const entidad = c.req.query("entidad");
  const scian = c.req.query("scian");
  const kRaw = c.req.query("k");

  if (!entidad || !ENTIDAD_RE.test(entidad)) {
    throw new HttpError(
      `entidad inválida "${entidad}"`,
      400,
      "validation.entidad",
    );
  }
  if (!scian || !SCIAN_RE.test(scian)) {
    throw new HttpError(`scian inválido "${scian}"`, 400, "validation.scian");
  }
  const k = kRaw ? parseInt(kRaw, 10) : 5;
  if (!Number.isInteger(k) || k < 1 || k > 100) {
    throw new HttpError(
      `k inválido "${kRaw ?? "(default)"}" — debe ser entero 1-100`,
      400,
      "validation.k",
    );
  }

  const result: ClusterCentroid[] = await clusterBySector(
    {
      supabaseUrl: config.supabaseUrl,
      serviceRoleKey: config.serviceRoleKey,
      dbContainer: config.dbContainer,
    },
    { entidad, scianPrefix: scian, k },
  );
  return c.json({ entidad, scian, k, clusters: result });
}
