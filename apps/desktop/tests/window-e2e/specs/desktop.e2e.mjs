// Real-window desktop E2E: user-visible journeys through the shipped window
// shell, driven by WebdriverIO through the official @wdio/tauri-service
// embedded WebDriver provider against hermetic loopback fixtures. One app
// session per run; each test resets to idle through the product control.
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import {
  SCENARIOS_DIR,
  deepLinkArgv,
  deliverDeepLink,
  gatewayInput,
  outputFiles,
  runOutputDir,
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

async function snapshot() {
  return browser.execute(() => {
    const q = (selector) => document.querySelector(selector);
    const text = (selector) => q(selector)?.textContent?.trim() ?? null;
    return {
      idle: !!q("#dz-url-input"),
      job: !!q(".dz-job-section"),
      completed: !!q(".dz-completed-section"),
      error: !!q(".dz-error-section"),
      deepLink: !!q("#dz-deep-link-confirm"),
      partialNote: text(".dz-partial-note"),
    };
  });
}

async function waitFor(predicate, timeout, label) {
  try {
    await browser.waitUntil(predicate, {
      timeout,
      timeoutMsg: `timed out waiting for ${label}`,
    });
  } catch (error) {
    const state = await snapshot().catch(() => null);
    throw new Error(`${error.message}: ${JSON.stringify(state)}`);
  }
}

async function configureOutputDirectory() {
  const directory = runOutputDir();
  let last = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    last = await browser.execute((dir) => {
      const input = document.querySelector("#dz-settings-output-dir");
      const panel = document.querySelector("#dz-desktop-settings");
      if (!input || !panel) {
        return { ok: false, reason: "panel-missing", hasInput: !!input, hasPanel: !!panel };
      }
      input.value = dir;
      // A change on any advanced control routes through the panel's validated
      // persist callback (which reads the hidden inputs, including the output
      // directory). #dz-settings-retries is a stable id present on every panel.
      const retries = panel.querySelector("#dz-settings-retries");
      if (!retries) {
        return { ok: false, reason: "no-persist-control" };
      }
      retries.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: input.value === dir, reason: "done", value: input.value };
    }, directory);
    if (last.ok) return;
    await browser.pause(500);
  }
  throw new Error(`desktop output-directory setting: ${JSON.stringify(last)}`);
}

async function submitUrl(url) {
  await browser.execute((value) => {
    const input = document.querySelector("#dz-url-input");
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }, url);
  await (await browser.$(".dz-button-row .dz-btn-tactile")).click();
}

async function resetToIdle() {
  await browser.execute(() => {
    const byId = (id) => document.getElementById(id);
    const button =
      byId("dz-btn-another") ??
      byId("dz-btn-reset") ??
      byId("dz-btn-start-over") ??
      byId("dz-btn-try-again");
    button?.click();
  });
  await waitFor(async () => (await snapshot()).idle, 60000, "idle after reset");
}

function clearOutput() {
  for (const file of outputFiles(runOutputDir())) {
    rmSync(file, { force: true });
  }
}

describe("Dezoomify desktop window", () => {
  before(async () => {
    await configureOutputDirectory();
  });

  afterEach(async () => {
    await resetToIdle();
  });

  it("saves the expected PNG automatically", async () => {
    clearOutput();
    await submitUrl(gatewayInput(GATEWAY_DZI));
    await waitFor(async () => {
      const state = await snapshot();
      return state.completed || state.error;
    }, 180000, "automatic save terminal");

    const terminal = await snapshot();
    assert.equal(terminal.error, false, "the save completes without a UI error");
    assert.equal(terminal.completed, true, "the completion view is shown");
    const outputs = outputFiles(runOutputDir());
    assert.equal(outputs.length, 1, "automatic save writes exactly one PNG");
    assert.ok(!outputs[0].includes(".partial."), "a complete save is not a partial sibling");
    assertSavedPyramid(readFileSync(outputs[0]), expectedHash());
  });

  it("cancelling a job leaves no output", async () => {
    clearOutput();
    await submitUrl(gatewayInput(SLOW_DZI));
    await waitFor(async () => (await snapshot()).job, 60000, "job view");
    // The throttled job keeps running through retry backoff, so the cancel
    // control is present and reaches the runtime before the job can complete.
    await (await browser.$("#dz-btn-cancel")).click();
    await waitFor(async () => {
      const state = await snapshot();
      return !state.job && !state.completed && !state.error && !state.deepLink;
    }, 60000, "cancelled view");
    assert.equal(
      outputFiles(runOutputDir()).length,
      0,
      "cancelled jobs publish no output",
    );
  });

  it("a confirmed deep link saves the expected PNG", async () => {
    clearOutput();
    await deliverDeepLink({
      env: process.env,
      link: deepLinkArgv(gatewayInput(GATEWAY_DZI)),
    });
    await waitFor(async () => (await snapshot()).deepLink, 60000, "deep-link confirmation");

    const pending = await snapshot();
    assert.equal(pending.job, false, "the link does not start before confirmation");
    assert.equal(outputFiles(runOutputDir()).length, 0, "the link does not save before confirmation");

    const confirmed = await browser.execute(() => {
      const button = Array.from(
        document.querySelectorAll("#dz-deep-link-confirm button"),
      ).find((candidate) => candidate.textContent.includes("Open image"));
      if (!button) return false;
      button.click();
      return true;
    });
    assert.equal(confirmed, true, "the confirmation dialog offers Open image");

    await waitFor(async () => {
      const state = await snapshot();
      return state.completed || state.error;
    }, 180000, "deep-link save terminal");
    const terminal = await snapshot();
    assert.equal(terminal.error, false, "the confirmed deep link completes");
    const outputs = outputFiles(runOutputDir());
    assert.equal(outputs.length, 1, "the deep link writes exactly one PNG");
    assertSavedPyramid(readFileSync(outputs[0]), expectedHash());
  });

  it("keeps a partial download as a .partial sibling", async () => {
    clearOutput();
    await submitUrl(gatewayInput(PARTIAL_DZI));
    await waitFor(async () => {
      const state = await snapshot();
      return state.completed || state.error;
    }, 180000, "partial terminal");

    const terminal = await snapshot();
    assert.equal(terminal.error, false, "a kept partial is not a hard error");
    assert.ok(terminal.partialNote, "the completion view reports missing tiles");
    const outputs = outputFiles(runOutputDir());
    assert.equal(outputs.length, 1, "exactly one partial output is published");
    assert.ok(
      outputs[0].includes(".partial."),
      "kept bytes land at the .partial sibling, never the granted path",
    );
  });
});
