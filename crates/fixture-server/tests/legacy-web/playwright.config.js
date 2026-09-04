const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: ".",
  testMatch: "parity.spec.js",
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  use: {
    actionTimeout: 15000,
    navigationTimeout: 15000,
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  globalSetup: "./setup.js",
  globalTeardown: "./teardown.js",
  reporter: [["list"]],
});
