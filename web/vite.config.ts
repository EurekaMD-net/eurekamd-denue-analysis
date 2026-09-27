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
    // Audit 2026-09-26 #12/#190/#196: Caddy served the .map files (full
    // sourcesContent) publicly. Vite empties dist/ on build, so they go.
    sourcemap: false,
    rollupOptions: {
      output: {
        // Vendor code that rarely changes gets its own hashed chunks, so
        // a redeploy of app code doesn't re-download it (audit #179).
        // Matched by path: the object form mis-assigns the CommonJS
        // react/react-dom modules and leaves them in the router chunk.
        manualChunks(id) {
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id))
            return "react";
          if (/[\\/]node_modules[\\/]react-router(-dom)?[\\/]/.test(id))
            return "router";
          return undefined;
        },
      },
    },
  },
});
