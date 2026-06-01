const { defineConfig, devices } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: "*.spec.js",
  timeout: 10000,
  expect: {
    timeout: 2000,
  },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://127.0.0.1:9877",
    channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === "darwin" ? "chrome" : undefined),
  },
  webServer: {
    command: "node fixture-server.js",
    url: "http://127.0.0.1:9877",
    reuseExistingServer: !process.env.CI,
    timeout: 5000,
  },
});
