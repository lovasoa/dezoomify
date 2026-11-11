import { defineConfig } from "vite";

export default defineConfig({
  base: "/__agent/",
  optimizeDeps: { entries: ["test/browser/page-agent.ts", "test/browser/source-view.ts"] },
  server: { host: "127.0.0.1", port: 4174, strictPort: true, cors: true, hmr: false },
});
