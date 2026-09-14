import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Desktop Vite shell for the Tauri app.
// Tauri development uses a fixed local origin. Production bundles disable
// source maps unless release policy explicitly permits sanitized maps.
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
    sourcemap: false,
    target: "es2022",
    outDir: "dist",
  },
});
