// Real-window desktop E2E: three user journeys through the shipped window
// shell, driven by tauri-driver against hermetic loopback fixtures.
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  SCENARIOS_DIR,
  closeFrontend,
  deepLinkArgv,
  deliverDeepLink,
  gatewayInput,
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
  recoveryButtons: ".dz-recovery-dialog button",
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
      recoveryButtons: buttons(${JSON.stringify(SEL.recoveryButtons)}),
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

test("real window: submit, choose destination, and save the expected PNG", { timeout: 180000 }, async () => {
  const hash = expectedHash();
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    body: async ({ driver, base, fixedDest }) => {
      await submitUrl(driver, gatewayInput(base, GATEWAY_DZI));
      const discovering = await waitFor(driver, (state) => state.jobSection, 60000, "job section");
      assert.ok(discovering.step, "the submitted job reaches the real window");
      await waitFor(
        driver,
        (state) => state.recoveryButtons.some((button) => button.includes("Choose output")),
        60000,
        "destination request",
      );
      assert.equal(await clickButton(driver, SEL.recoveryButtons, "Choose output"), true);
      const terminal = await waitFor(
        driver,
        (state) => state.completed || state.error,
        120000,
        "save terminal",
      );
      assert.equal(terminal.error, false, "the save completes without a UI error");
      assert.ok(existsSync(fixedDest), "the granted destination is written");
      assertSavedPyramid(readFileSync(fixedDest), hash);
    },
  });
});

test("real window: cancel leaves no output", { timeout: 180000 }, async () => {
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "cancelled.png",
    body: async ({ driver, base, fixedDest }) => {
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
      assert.ok(!existsSync(fixedDest), "cancelled jobs do not publish output");
    },
  });
});

test("real window: confirmed deep link saves the expected PNG", { timeout: 180000 }, async () => {
  const hash = expectedHash();
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "handoff.png",
    body: async ({ driver, base, fixedDest, appEnv }) => {
      await deliverDeepLink({ appEnv, link: deepLinkArgv(gatewayInput(base, GATEWAY_DZI)) });
      const pending = await waitFor(driver, (state) => state.deepLink, 60000, "deep-link confirmation");
      assert.ok(pending.deepLinkButtons.some((button) => button.includes("Open image")));
      assert.equal(pending.jobSection, false, "the link does not start before confirmation");
      assert.ok(!existsSync(fixedDest), "the link does not save before confirmation");
      assert.equal(
        await clickButton(driver, `${SEL.deepLinkConfirm} button`, "Open image"),
        true,
      );
      await waitFor(driver, (state) => state.jobSection, 60000, "job after confirmation");
      await waitFor(
        driver,
        (state) => state.recoveryButtons.some((button) => button.includes("Choose output")),
        60000,
        "destination request",
      );
      assert.equal(await clickButton(driver, SEL.recoveryButtons, "Choose output"), true);
      const terminal = await waitFor(
        driver,
        (state) => state.completed || state.error,
        120000,
        "deep-link save terminal",
      );
      assert.equal(terminal.error, false, "the confirmed deep link completes");
      assertSavedPyramid(readFileSync(fixedDest), hash);
    },
  });
});
