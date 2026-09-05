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
  globalSetup: "./setup.js",
  globalTeardown: "./teardown.js",
  reporter: [["list"]],
});
