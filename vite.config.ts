import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The website serves /; scripts/build-site.mjs adds the legacy app at /legacy/.
export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: /^@dezoomify\/wasm-bindings$/,
        replacement: fileURLToPath(new URL("./wasm/dezoomify-wasm.js", import.meta.url)),
      },
    ],
  },
  define: { __DEZOOMIFY_VERSION__: JSON.stringify(process.env.DEZOOMIFY_VERSION ?? "development") },
  build: {
    target: "es2022",
    outDir: "dist",
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
