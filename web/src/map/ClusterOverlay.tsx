import { useEffect, useMemo } from "react";
import type { Map as MapInstance } from "maplibre-gl";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useUiStore } from "../store";
import { apiFetch } from "../api/client";

interface Props {
  map: MapInstance | null;
}

/**
 * MapLibre geojson source + circle layer rendering k-means cluster
 * centroids on the map. Fires when both `entidad` AND `sector` are set
 * (k-means clusters require a single sector to be meaningful).
 *
 * At most k=10 circles, so MapLibre's own circle layer is enough; no
 * second WebGL pipeline (deck.gl) is needed.
 */
const CLUSTER_CENTROID = z.object({
  cluster_id: z.number(),
  lon: z.number(),
  lat: z.number(),
  size: z.number(),
});

const CLUSTERS_RESULT = z.object({
  entidad: z.string(),
  scian: z.string(),
  k: z.number(),
  centroids: z.array(CLUSTER_CENTROID),
});

type ClusterCentroid = z.infer<typeof CLUSTER_CENTROID>;

/** Parses the GET /clusters body: { entidad, scian, k, centroids:
 * [{cluster_id, lon, lat, size}] }. Extra fields are tolerated. */
export function parseClustersResult(body: unknown) {
  return CLUSTERS_RESULT.passthrough().parse(body);
}

export const CLUSTER_SOURCE_ID = "clusters";
export const CLUSTER_LAYER_ID = "clusters-circle";

/** Centroids as a FeatureCollection. `size_norm` (size / max size, 0..1)
 * drives circle-radius so the layer paint never needs rebuilding. */
export function centroidsToGeoJSON(
  centroids: ClusterCentroid[],
): GeoJSON.FeatureCollection<GeoJSON.Point> {
  const maxSize = Math.max(...centroids.map((c) => c.size), 1);
  return {
    type: "FeatureCollection",
    features: centroids.map((c) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [c.lon, c.lat] },
      properties: {
        cluster_id: c.cluster_id,
        size: c.size,
        size_norm: c.size / maxSize,
      },
    })),
  };
}

/** Minimal slice of the MapLibre Map API this module touches. */
type ClusterMap = Pick<
  MapInstance,
  | "isStyleLoaded"
  | "getSource"
  | "addSource"
  | "getLayer"
  | "addLayer"
  | "moveLayer"
  | "on"
  | "off"
>;

/**
 * Ensures the cluster source + layer exist on the current style and
 * pushes `centroids` into it. No-op until the style is loaded. Keeps the
 * layer on top, since MapShell re-adds its data layers on filter change.
 */
export function syncClusterLayer(
  map: ClusterMap,
  centroids: ClusterCentroid[],
): void {
  if (!map.isStyleLoaded()) return;
  const data = centroidsToGeoJSON(centroids);
  const src = map.getSource(CLUSTER_SOURCE_ID) as
    | { setData: (d: GeoJSON.FeatureCollection) => void }
    | undefined;
  if (src) {
    src.setData(data);
  } else {
    map.addSource(CLUSTER_SOURCE_ID, { type: "geojson", data });
  }
  if (!map.getLayer(CLUSTER_LAYER_ID)) {
    map.addLayer({
      id: CLUSTER_LAYER_ID,
      type: "circle",
      source: CLUSTER_SOURCE_ID,
      paint: {
        "circle-radius": [
          "interpolate",
          ["linear"],
          ["get", "size_norm"],
          0,
          6,
          1,
          38,
        ],
        "circle-color": "rgba(251,113,133,0.78)", // rose-400
        "circle-stroke-color": "rgba(253,224,71,0.94)", // yellow-300
        "circle-stroke-width": 1.5,
      },
    });
  } else {
    map.moveLayer(CLUSTER_LAYER_ID);
  }
}

/**
 * Draws `centroids` now if the style is ready, and again on every
 * 'load' / 'style.load' so the layer survives map recreation, a style
 * swap, and data that arrives before the map finished loading.
 * Returns the listener cleanup.
 */
export function attachClusterLayer(
  map: ClusterMap,
  centroids: ClusterCentroid[],
): () => void {
  const apply = () => syncClusterLayer(map, centroids);
  apply();
  map.on("load", apply);
  map.on("style.load", apply);
  return () => {
    map.off("load", apply);
    map.off("style.load", apply);
  };
}

export function ClusterOverlay({ map }: Props) {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  const entidad = useUiStore((s) => s.entidad);
  const sector = useUiStore((s) => s.sector);

  const enabled = accessToken !== null && entidad !== null && sector !== null;

  const { data } = useQuery({
    queryKey: ["clusters", entidad, sector],
    queryFn: async () => {
      const res = await apiFetch(
        `/clusters?entidad=${encodeURIComponent(entidad ?? "")}` +
          `&scian=${encodeURIComponent(sector ?? "")}&k=10`,
        {},
        accessToken,
      );
      const body: unknown = await res.json();
      return parseClustersResult(body);
    },
    enabled,
    staleTime: 60_000,
  });

  const centroids = useMemo<ClusterCentroid[]>(
    () => data?.centroids ?? [],
    [data],
  );

  // Keyed on [map, centroids]: a recreated map (basemap toggle, token
  // refresh) re-runs this and redraws the unchanged centroids.
  useEffect(() => {
    if (!map) return;
    return attachClusterLayer(map, centroids);
  }, [map, centroids]);

  // The layer paints into MapLibre's canvas, so this component renders
  // nothing in the DOM tree itself.
  return null;
}

/** Shared between MapMode (status badge) and ClusterOverlay (gating). */
export function clusterOverlayActive(
  entidad: string | null,
  sector: string | null,
): boolean {
  return entidad !== null && sector !== null;
}

// Re-export the parsed result type for downstream consumers.
export type { ClusterCentroid };
