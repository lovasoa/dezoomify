const path = require("path");
const { defineConfig, devices } = require("@playwright/test");

// Oklahoma State omits this intermediate; browsers recover it, Node does not.
process.env.NODE_EXTRA_CA_CERTS = process.env.NODE_EXTRA_CA_CERTS ||
  path.join(__dirname, "certs", "incommon-rsa-server-ca-2.pem");

module.exports = defineConfig({
  testDir: ".",
  testMatch: "live-compat.spec.js",
  fullyParallel: true,
  globalTimeout: process.env.CI ? 60 * 60 * 1000 : undefined,
  retries: process.env.CI ? 20 : 0,
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
