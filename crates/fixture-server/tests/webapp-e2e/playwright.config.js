const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: ["webapp.spec.js", "liveweb.spec.js"],
  timeout: 90000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    actionTimeout: 20000,
    navigationTimeout: 20000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
    command: "node setup.js",
    wait: {
      stderr: /fixture server listening at (?<DEZOOMIFY_E2E_ADDR>http:\/\/127\.0\.0\.1:\d+)/,
    },
    gracefulShutdown: { signal: "SIGTERM", timeout: 5000 },
    stdout: "ignore",
    timeout: 10 * 60 * 1000,
    env: {
      NODE_NO_WARNINGS: "1",
      VITE_CONFIG_NATIVE_IGNORE_WARNING: "true",
    },
  },
  reporter: "dot",
});
