// Real-window desktop E2E: three user journeys through the shipped window
// shell, driven by tauri-driver against hermetic loopback fixtures.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  SCENARIOS_DIR,
  closeFrontend,
  deepLinkArgv,
  deliverDeepLink,
  gatewayInput,
  outputFiles,
  preflight,
  runWindowFlow,
} from "./harness.mjs";
import { assertSavedPyramid, goldenOutputHash } from "./png-assert.mjs";

const GATEWAY_DZI = "https://fixtures.test/cli/pyramid.dzi";
const SEL = {
  cancel: "#dz-btn-cancel",
  completed: ".dz-completed-section",
  deepLinkConfirm: "#dz-deep-link-confirm",
  error: ".dz-error-section",
  jobSection: ".dz-job-section",
  step: "#dz-job-step-text",
  submit: ".dz-button-row .dz-btn-tactile",
  urlInput: "#dz-url-input",
};

let shared = null;

before(async () => {
  shared = await preflight();
});

after(async () => {
  if (shared) await closeFrontend(shared.frontend);
});

function expectedHash() {
  const hash = goldenOutputHash(SCENARIOS_DIR);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/, "golden pins a real digest");
  return hash;
}

async function snapshot(driver) {
  return driver.executeScript(`return (() => {
    const text = (s) => document.querySelector(s)?.textContent?.trim() ?? null;
    const buttons = (s) => Array.from(document.querySelectorAll(s))
      .map((button) => button.textContent.trim());
    return {
      completed: !!document.querySelector(${JSON.stringify(SEL.completed)}),
      deepLink: !!document.querySelector(${JSON.stringify(SEL.deepLinkConfirm)}),
      deepLinkButtons: buttons(${JSON.stringify(`${SEL.deepLinkConfirm} button`)}),
      error: !!document.querySelector(${JSON.stringify(SEL.error)}),
      jobSection: !!document.querySelector(${JSON.stringify(SEL.jobSection)}),
      step: text(${JSON.stringify(SEL.step)}),
    };
  })()`);
}

async function waitFor(driver, wanted, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const state = await snapshot(driver);
    if (wanted(state)) return state;
    if (Date.now() - start > timeoutMs) {
      assert.fail(`timed out waiting for ${label}: ${JSON.stringify(state)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

async function submitUrl(driver, input) {
  await driver.executeScript((url) => {
    const el = document.querySelector("#dz-url-input");
    el.focus();
    el.value = url;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, input);
  await driver.findElement({ css: SEL.submit }).click();
}

async function clickButton(driver, selector, text) {
  return driver.executeScript((sel, wanted) => {
    const button = Array.from(document.querySelectorAll(sel))
      .find((candidate) => candidate.textContent.includes(wanted));
    if (!button) return false;
    button.click();
    return true;
  }, selector, text);
}

test("real window: automatic submit and save produce the expected PNG", { timeout: 180000 }, async () => {
  const hash = expectedHash();
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    body: async ({ driver, base, outputDir }) => {
      await submitUrl(driver, gatewayInput(base, GATEWAY_DZI));
      const discovering = await waitFor(driver, (state) => state.jobSection, 60000, "job section");
      assert.ok(discovering.step, "the submitted job reaches the real window");
      const terminal = await waitFor(
        driver,
        (state) => state.completed || state.error,
        120000,
        "automatic save terminal",
      );
      assert.equal(terminal.error, false, "the save completes without a UI error");
      const outputs = outputFiles(outputDir);
      assert.equal(outputs.length, 1, "automatic save writes exactly one PNG");
      assertSavedPyramid(readFileSync(outputs[0]), hash);
    },
  });
});

test("real window: cancel leaves no output", { timeout: 180000 }, async () => {
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    body: async ({ driver, base, outputDir }) => {
      await submitUrl(driver, gatewayInput(base, GATEWAY_DZI));
      await waitFor(driver, (state) => state.jobSection, 60000, "job section");
      await driver.findElement({ css: SEL.cancel }).click();
      const settled = await waitFor(
        driver,
        (state) => !state.jobSection && !state.completed && !state.error,
        60000,
        "cancelled job",
      );
      assert.equal(settled.error, false);
      assert.equal(outputFiles(outputDir).length, 0, "cancelled jobs do not publish output");
    },
  });
});

test("real window: confirmed deep link saves the expected PNG", { timeout: 180000 }, async () => {
  const hash = expectedHash();
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    body: async ({ driver, base, outputDir, appEnv }) => {
      await deliverDeepLink({ appEnv, link: deepLinkArgv(gatewayInput(base, GATEWAY_DZI)) });
      const pending = await waitFor(driver, (state) => state.deepLink, 60000, "deep-link confirmation");
      assert.ok(pending.deepLinkButtons.some((button) => button.includes("Open image")));
      assert.equal(pending.jobSection, false, "the link does not start before confirmation");
      assert.equal(outputFiles(outputDir).length, 0, "the link does not save before confirmation");
      assert.equal(
        await clickButton(driver, `${SEL.deepLinkConfirm} button`, "Open image"),
        true,
      );
      const terminal = await waitFor(
        driver,
        (state) => state.completed || state.error,
        120000,
        "deep-link automatic save terminal",
      );
      assert.equal(terminal.error, false, "the confirmed deep link completes");
      const outputs = outputFiles(outputDir);
      assert.equal(outputs.length, 1, "deep-link automatic save writes exactly one PNG");
      assertSavedPyramid(readFileSync(outputs[0]), hash);
    },
  });
});
