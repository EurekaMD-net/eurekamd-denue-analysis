import { useEffect, useMemo, useRef } from "react";
import type { Map as MapInstance } from "maplibre-gl";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { ScatterplotLayer } from "@deck.gl/layers";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useUiStore } from "../store";
import { apiFetch } from "../api/client";

interface Props {
  map: MapInstance | null;
}

/**
 * deck.gl ScatterplotLayer overlay rendering cluster centroids on top
 * of the MapLibre canvas. Fires when both `entidad` AND `sector` are
 * set (k-means clusters require a single sector to be meaningful).
 *
 * Uses MapboxOverlay (not @deck.gl/react's <DeckGL>) so deck.gl
 * piggy-backs on MapLibre's existing canvas + camera. No second canvas
 * means no z-order shenanigans.
 */
const CLUSTER_CENTROID = z.object({
  cluster_id: z.number(),
  size: z.number(),
  centroid_lat: z.number(),
  centroid_lon: z.number(),
});

const CLUSTERS_RESULT = z.object({
  entidad: z.string(),
  scian: z.string(),
  k: z.number(),
  centroids: z.array(CLUSTER_CENTROID),
});

type ClusterCentroid = z.infer<typeof CLUSTER_CENTROID>;

export function ClusterOverlay({ map }: Props) {
  const accessToken = useUiStore((s) => s.session?.access_token ?? null);
  const entidad = useUiStore((s) => s.entidad);
  const sector = useUiStore((s) => s.sector);
  const overlayRef = useRef<MapboxOverlay | null>(null);

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
      // The backend returns { entidad, scian, k, centroids: [{cluster_id,
      // size, centroid_lat, centroid_lon, ... }, ...] }. Be liberal in
      // parsing — passthrough fields beyond the schema are tolerated.
      return CLUSTERS_RESULT.passthrough().parse(body);
    },
    enabled,
    staleTime: 60_000,
  });

  const centroids = useMemo<ClusterCentroid[]>(
    () => data?.centroids ?? [],
    [data],
  );

  // Mount the deck.gl overlay once map is ready. Layers are rebuilt
  // when centroid data changes.
  useEffect(() => {
    if (!map) return;
    if (!overlayRef.current) {
      const overlay = new MapboxOverlay({ layers: [] });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      map.addControl(overlay as any);
      overlayRef.current = overlay;
    }
    return () => {
      if (overlayRef.current && map) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          map.removeControl(overlayRef.current as any);
        } catch {
          // map may already be torn down by basemap toggle
        }
        overlayRef.current = null;
      }
    };
  }, [map]);

  // Layer rebuild on data change.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay) return;
    if (centroids.length === 0) {
      overlay.setProps({ layers: [] });
      return;
    }
    const maxSize = Math.max(...centroids.map((c) => c.size), 1);
    overlay.setProps({
      layers: [
        new ScatterplotLayer<ClusterCentroid>({
          id: "clusters",
          data: centroids,
          pickable: true,
          stroked: true,
          filled: true,
          radiusUnits: "pixels",
          radiusMinPixels: 6,
          radiusMaxPixels: 38,
          lineWidthUnits: "pixels",
          lineWidthMinPixels: 1.5,
          getPosition: (d) => [d.centroid_lon, d.centroid_lat, 0],
          getRadius: (d) => 6 + (d.size / maxSize) * 32,
          getFillColor: () => [251, 113, 133, 200], // rose-400 alpha
          getLineColor: () => [253, 224, 71, 240], // yellow-300
        }),
      ],
    });
  }, [centroids]);

  // Visual hint: when both filters set but no data yet
  if (!enabled || centroids.length === 0) return null;
  // The overlay paints into MapLibre's canvas, so this component
  // renders nothing in the DOM tree itself. The legend below is
  // optional UI surfaced by MapMode.
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
