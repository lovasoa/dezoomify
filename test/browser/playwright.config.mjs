import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../..",
  testMatch: [
    "**/packages/page-agent/test/browser/*.spec.mjs",
    "**/packages/shared-ui/test/browser/*.spec.mjs",
    "**/apps/extension/tests/browser/*.spec.mjs",
  ],
  fullyParallel: true,
  workers: 2,
  timeout: 30000,
  use: { baseURL: "http://127.0.0.1:4174", trace: "retain-on-failure" },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
    { name: "firefox", use: { browserName: "firefox" } },
  ],
  webServer: {
    command: "pnpm exec vite --config test/browser/vite.config.mjs",
    cwd: "../..",
    url: "http://127.0.0.1:4174/__agent/test/browser/index.html",
  },
  reporter: "list",
});
