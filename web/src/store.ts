import { create } from "zustand";

const API_KEY_STORAGE = "denue-analyzer.api-key";

export type Mode = "map" | "locust";

export interface UiState {
  apiKey: string | null;
  setApiKey: (key: string) => void;
  clearApiKey: () => void;

  entidad: string | null;
  setEntidad: (clave: string | null) => void;

  sector: string | null;
  setSector: (scian: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  apiKey:
    typeof window !== "undefined"
      ? window.localStorage.getItem(API_KEY_STORAGE)
      : null,
  setApiKey: (key) => {
    window.localStorage.setItem(API_KEY_STORAGE, key);
    set({ apiKey: key });
  },
  clearApiKey: () => {
    window.localStorage.removeItem(API_KEY_STORAGE);
    set({ apiKey: null });
  },

  entidad: null,
  setEntidad: (clave) => set({ entidad: clave }),

  sector: null,
  setSector: (scian) => set({ sector: scian }),
}));
