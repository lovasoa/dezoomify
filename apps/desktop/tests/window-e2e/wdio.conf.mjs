// WebdriverIO configuration for the real-window desktop E2E.
//
// Follows the official Tauri recommendation: WebdriverIO with the
// `@wdio/tauri-service` embedded WebDriver provider. The embedded provider
// runs a W3C WebDriver server inside the app (tauri-plugin-wdio-webdriver,
// built via the `wdio` cargo feature), so the same config drives Linux, macOS,
// and Windows without an external tauri-driver or platform driver.
//
// Hermetic setup (fixture server, frontend server, isolated profile) runs in
// `onPrepare`, before workers start, and is inherited by workers through the
// process environment. The app is launched and torn down by the service.
import path from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APP_BIN,
  assertDisplay,
  closeFrontendServer,
  createRunDirs,
  ensureFixtureServerBuilt,
  ensureWindowShell,
  laneAppEnv,
  startFixtureServer,
  startFrontendServer,
  stopFixtureServer,
} from "./harness.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

let fixture = null;
let frontend = null;
let runDirs = null;

export const config = {
  runner: "local",
  specs: [path.join(HERE, "specs/**/*.e2e.mjs")],
  exclude: [],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: APP_BIN },
    },
  ],
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: APP_BIN,
        driverProvider: "embedded",
        startTimeout: 180000,
        commandTimeout: 120000,
        logLevel: "info",
      },
    ],
  ],
  logLevel: "info",
  bail: 0,
  waitforTimeout: 60000,
  connectionRetryTimeout: 180000,
  connectionRetryCount: 2,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 240000,
  },

  async onPrepare() {
    assertDisplay();
    ensureWindowShell();
    ensureFixtureServerBuilt();
    runDirs = createRunDirs();
    // Export the isolated profile to the app (inherited by worker processes
    // and by the service when it spawns the binary).
    Object.assign(process.env, laneAppEnv(runDirs.home));
    fixture = await startFixtureServer(runDirs.root);
    frontend = await startFrontendServer();
    process.env.DEZOOMIFY_WINDOW_E2E_ROOT = runDirs.root;
    process.env.DEZOOMIFY_WINDOW_E2E_HOME = runDirs.home;
    process.env.DEZOOMIFY_WINDOW_E2E_OUTPUT = runDirs.output;
    process.env.DEZOOMIFY_WINDOW_E2E_BASE = fixture.base;
  },

  async onComplete() {
    await closeFrontendServer(frontend);
    stopFixtureServer(fixture);
    if (runDirs) {
      try {
        rmSync(runDirs.root, { recursive: true, force: true });
      } catch {
        // Best-effort: temp dirs are reaped by the OS eventually.
      }
    }
  },
};
