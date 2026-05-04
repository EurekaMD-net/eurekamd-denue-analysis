import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    // Vite 5 host-header check defense. Caddy reverse-proxies the dev
    // server so requests arrive with `Host: uncharted.eurekamd.cloud`,
    // which the default localhost-only allowlist rejects with 403.
    // Whitelist the dev subdomain explicitly.
    allowedHosts: ["uncharted.eurekamd.cloud"],
    proxy: {
      "/api": {
        target: "http://localhost:3030",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
