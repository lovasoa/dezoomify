const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: "live-compat.spec.js",
  fullyParallel: true,
  timeout: 30000,
  workers: 4,
  expect: {
    timeout: 5000,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:9878",
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === "darwin" ? "chrome" : undefined),
  },
  webServer: {
    command: "node live-server.js",
    url: "http://127.0.0.1:9878",
    reuseExistingServer: !process.env.CI,
    timeout: 5000,
  },
});
