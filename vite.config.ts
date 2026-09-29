import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// New website build. The deployed app serves below /beta/ while the legacy
// site remains at / (assembled by scripts/build-site.mjs).
export default defineConfig({
  base: "/beta/",
  plugins: [react()],
  resolve: {
    alias: {
      "@dezoomify/wasm-bindings": fileURLToPath(
        new URL("./wasm/dezoomify-wasm.js", import.meta.url),
      ),
    },
  },
  define: { __DEZOOMIFY_VERSION__: JSON.stringify(process.env.DEZOOMIFY_VERSION ?? "development") },
  build: {
    target: "es2022",
    outDir: "dist/beta",
    emptyOutDir: true,
    // External maps ship in prod: the project is open source and prod
    // bundles must stay one-click debuggable. Maps are fetched lazily by
    // devtools only, so page loads are unaffected.
    sourcemap: true,
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
});
