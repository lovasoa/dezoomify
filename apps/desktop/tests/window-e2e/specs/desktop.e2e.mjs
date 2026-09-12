// Real-window desktop E2E: user-visible journeys through the shipped window
// shell, driven by selenium-webdriver against the embedded W3C WebDriver server
// (tauri-plugin-wdio-webdriver, built via the `testing-webdriver` cargo feature)
// and hermetic loopback fixtures. One app session per run; each test resets to
// idle through the product control.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { Builder, By } from "selenium-webdriver";
import {
  SCENARIOS_DIR,
  WEBDRIVER_URL,
  closeFrontendServer,
  createRunDirs,
  deepLinkArgv,
  deliverDeepLink,
  ensureFixtureServerBuilt,
  gatewayInput,
  laneAppEnv,
  outputFiles,
  runOutputDir,
  startFixtureServer,
  startFrontendServer,
  startWindowApp,
  stopFixtureServer,
  stopWindowApp,
} from "../harness.mjs";
import { assertSavedPyramid, goldenOutputHash } from "../png-assert.mjs";

const GATEWAY_DZI = "https://fixtures.test/cli/pyramid.dzi";
// Two tiles answer 429 with Retry-After, so the job stays running through
// retry backoff long enough to cancel deterministically.
const SLOW_DZI = "https://fixtures.test/edge/throttle-429/pyramid.dzi";
const PARTIAL_DZI = "https://fixtures.test/desktop/tile-failure-keep/corrupt.dzi";

function expectedHash() {
  return goldenOutputHash(SCENARIOS_DIR);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorDetail(state) {
  return `${state.errorText}\n${state.errorDiagnostics ?? ""}`;
}

async function snapshot(driver) {
  return driver.executeScript(() => {
    const q = (selector) => document.querySelector(selector);
    const text = (selector) => q(selector)?.textContent?.trim() ?? null;
    return {
      idle: !!q("#dz-url-input"),
      job: !!q(".dz-job-section"),
      completed: !!q(".dz-completed-section"),
      error: !!q(".dz-error-section"),
      errorText: text("#dz-error-message"),
      errorDiagnostics: text("#dz-error-diagnostics"),
      deepLink: !!q("#dz-deep-link-confirm"),
      partialNote: text(".dz-partial-note"),
    };
  });
}

async function waitFor(driver, predicate, timeout, label) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await sleep(200);
  }
  const state = await snapshot(driver).catch(() => null);
  const detail = lastError ? ` (last error: ${lastError.message})` : "";
  throw new Error(`timed out waiting for ${label}${detail}: ${JSON.stringify(state)}`);
}

async function waitForDefaultOutputDirectory(driver) {
  const directory = path.basename(runOutputDir());
  let last = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      last = await driver.executeScript((expectedFolder) => {
        const panel = document.querySelector("#dz-desktop-settings");
        const folder = panel?.querySelector(".dz-quick-button");
        if (!panel || !folder) {
          return { ok: false, reason: "settings-not-mounted", hasPanel: !!panel, hasFolder: !!folder };
        }
        return { ok: folder.textContent.trim() === expectedFolder, reason: "done", value: folder.textContent.trim() };
      }, directory);
    } catch (error) {
      // The webview can still be settling right after session creation on a
      // loaded CI runner; a transient script timeout must not fail the run.
      last = { ok: false, reason: `script-error: ${error.message}` };
    }
    if (last.ok) return;
    await sleep(500);
  }
  throw new Error(`desktop default output-directory setting: ${JSON.stringify(last)}`);
}

async function submitUrl(driver, url) {
  await driver.executeScript((value) => {
    const input = document.querySelector("#dz-url-input");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, url);
  await (await driver.findElement(By.css(".dz-button-row .dz-btn-tactile"))).click();
}

async function resetToIdle(driver) {
  await driver.executeScript(() => {
    const byId = (id) => document.getElementById(id);
    const button =
      byId("dz-btn-another") ??
      byId("dz-btn-reset") ??
      byId("dz-btn-start-over") ??
      byId("dz-btn-try-again");
    button?.click();
  });
  await waitFor(driver, async () => (await snapshot(driver)).idle, 60000, "idle after reset");
}

function clearOutput() {
  for (const file of outputFiles(runOutputDir())) {
    rmSync(file, { force: true });
  }
}

describe("Dezoomify desktop window", () => {
  let driver = null;
  let app = null;
  let fixture = null;
  let frontend = null;
  let runDirs = null;

  async function teardown() {
    if (driver) {
      try {
        await driver.quit();
      } catch {
        // The session may already be gone.
      }
      driver = null;
    }
    await stopWindowApp(app);
    if (app) {
      const logs = app.logs().trim();
      if (logs) process.stderr.write(`window E2E app log:\n${logs.slice(-4000)}\n`);
    }
    app = null;
    await closeFrontendServer(frontend);
    frontend = null;
    if (fixture) {
      const requestLog = existsSync(fixture.requestLog)
        ? readFileSync(fixture.requestLog, "utf8")
        : "";
      const logs = `${fixture.logs()}\n${requestLog}`.trim();
      if (logs) process.stderr.write(`window E2E fixture log:\n${logs.slice(-4000)}\n`);
    }
    stopFixtureServer(fixture);
    fixture = null;
    if (runDirs) {
      try {
        rmSync(runDirs.root, { recursive: true, force: true });
      } catch {
        // Best-effort: temp dirs are reaped by the OS eventually.
      }
      runDirs = null;
    }
  }

  before(async () => {
    try {
      runDirs = createRunDirs();
      process.env.DEZOOMIFY_WINDOW_E2E_ROOT = runDirs.root;
      process.env.DEZOOMIFY_WINDOW_E2E_HOME = runDirs.home;
      process.env.DEZOOMIFY_WINDOW_E2E_OUTPUT = runDirs.output;
      // The deep-link forwarder inherits the isolated profile too.
      Object.assign(process.env, laneAppEnv(runDirs.home));
      ensureFixtureServerBuilt();
      fixture = await startFixtureServer(runDirs.root);
      process.env.DEZOOMIFY_WINDOW_E2E_BASE = fixture.base;
      // The debug shell loads its embedded devUrl, so the frontend server must
      // be listening before the app starts.
      frontend = await startFrontendServer();
      app = await startWindowApp(runDirs.home);
      driver = await new Builder()
        .usingServer(WEBDRIVER_URL)
        .withCapabilities({ browserName: "wry" }) // accepted/ignored by the embedded server
        .build();
      // Generous script/page timeouts: the webview may still be settling on a
      // loaded CI runner, and the product's own startup can block the loop.
      await driver.manage().setTimeouts({ script: 120000, pageLoad: 180000, implicit: 0 });
      await waitForDefaultOutputDirectory(driver);
    } catch (error) {
      await teardown();
      throw error;
    }
  });

  after(async () => {
    await teardown();
  });

  afterEach(async () => {
    await resetToIdle(driver);
  });

  it("saves the expected PNG automatically", async () => {
    clearOutput();
    await submitUrl(driver, gatewayInput(GATEWAY_DZI));
    await waitFor(
      driver,
      async () => {
        const state = await snapshot(driver);
        return state.completed || state.error;
      },
      180000,
      "automatic save terminal",
    );

    const terminal = await snapshot(driver);
    assert.equal(terminal.error, false, `the save completes without a UI error: ${errorDetail(terminal)}`);
    assert.equal(terminal.completed, true, "the completion view is shown");
    const outputs = outputFiles(runOutputDir());
    assert.equal(outputs.length, 1, "automatic save writes exactly one PNG");
    assert.ok(!outputs[0].includes(".partial."), "a complete save is not a partial sibling");
    assertSavedPyramid(readFileSync(outputs[0]), expectedHash());
  });

  it("cancelling a job leaves no output", async () => {
    clearOutput();
    await submitUrl(driver, gatewayInput(SLOW_DZI));
    await waitFor(driver, async () => (await snapshot(driver)).job, 60000, "job view");
    // The throttled job keeps running through retry backoff, so the cancel
    // control is present and reaches the runtime before the job can complete.
    await (await driver.findElement(By.css("#dz-btn-cancel"))).click();
    await waitFor(
      driver,
      async () => {
        const state = await snapshot(driver);
        return !state.job && !state.completed && !state.error && !state.deepLink;
      },
      60000,
      "cancelled view",
    );
    assert.equal(outputFiles(runOutputDir()).length, 0, "cancelled jobs publish no output");
  });

  it("a confirmed deep link saves the expected PNG", async () => {
    clearOutput();
    await deliverDeepLink({
      env: process.env,
      link: deepLinkArgv(gatewayInput(GATEWAY_DZI)),
    });
    await waitFor(
      driver,
      async () => (await snapshot(driver)).deepLink,
      60000,
      "deep-link confirmation",
    );

    const pending = await snapshot(driver);
    assert.equal(pending.job, false, "the link does not start before confirmation");
    assert.equal(outputFiles(runOutputDir()).length, 0, "the link does not save before confirmation");

    const confirmed = await driver.executeScript(() => {
      const button = Array.from(document.querySelectorAll("#dz-deep-link-confirm button")).find(
        (candidate) => candidate.textContent.includes("Open image"),
      );
      if (!button) return false;
      button.click();
      return true;
    });
    assert.equal(confirmed, true, "the confirmation dialog offers Open image");

    await waitFor(
      driver,
      async () => {
        const state = await snapshot(driver);
        return state.completed || state.error;
      },
      180000,
      "deep-link save terminal",
    );
    const terminal = await snapshot(driver);
    assert.equal(terminal.error, false, `the confirmed deep link completes: ${errorDetail(terminal)}`);
    const outputs = outputFiles(runOutputDir());
    assert.equal(outputs.length, 1, "the deep link writes exactly one PNG");
    assertSavedPyramid(readFileSync(outputs[0]), expectedHash());
  });

  it("keeps a partial download as a .partial sibling", async () => {
    clearOutput();
    await submitUrl(driver, gatewayInput(PARTIAL_DZI));
    await waitFor(
      driver,
      async () => {
        const state = await snapshot(driver);
        return state.completed || state.error;
      },
      180000,
      "partial terminal",
    );

    const terminal = await snapshot(driver);
    assert.equal(terminal.error, false, `a kept partial is not a hard error: ${errorDetail(terminal)}`);
    assert.ok(terminal.partialNote, "the completion view reports missing tiles");
    const outputs = outputFiles(runOutputDir());
    assert.equal(outputs.length, 1, "exactly one partial output is published");
    assert.ok(
      outputs[0].includes(".partial."),
      "kept bytes land at the .partial sibling, never the granted path",
    );
  });
});
