import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Desktop Vite shell for the Tauri app.
// Tauri development uses a fixed local origin. Production bundles ship
// external source maps: the project is open source and prod bundles must
// stay one-click debuggable. Maps are fetched lazily by devtools only.
// The Rust/wasm core stays lean (no DWARF) so the downloaded bytes stay
// small; only the TypeScript bundles map back to sources.
export default defineConfig({
  plugins: [react()],
  define: {
    __DEZOOMIFY_VERSION__: JSON.stringify(process.env.DEZOOMIFY_VERSION ?? "0.0.0"),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    sourcemap: true,
    target: "es2022",
    outDir: "dist",
  },
});
