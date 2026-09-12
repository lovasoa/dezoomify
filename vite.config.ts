import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// New website build. The deployed app serves below /beta/ while the legacy
// site remains at / (assembled by scripts/build-site.mjs). The app's host
// effects (worker, fetch policy, canvas assembly) stay in `src/`; Vite only
// bundles the module graph and hashes assets.
export default defineConfig({
  base: "/beta/",
  plugins: [react()],
  build: {
    target: "es2022",
    outDir: "dist/beta",
    emptyOutDir: true,
    // No inline module-preload polyfill: the deployed CSP is script-src 'self'.
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        index: "index.html",
        privacy: "privacy.html",
        terms: "terms.html",
      },
    },
  },
  worker: {
    format: "es",
  },
});
