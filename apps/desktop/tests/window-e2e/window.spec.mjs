// Real-window desktop E2E: the window shell under tauri-driver against
// hermetic loopback fixtures. Wave-1 flows only; the per-format matrix and
// OS integration are later waves.
//
// - submit URL -> discovery -> auto-choice (pipeline defaults: first image,
//   largest fitting level) -> destination request -> E2E-hook grant -> save
//   completes with byte-exact PNG vs the `native/cli-dzi` golden;
// - cancel flow (terminal once, output removed);
// - error flow on the `desktop/destination-denied` scenario (existing output
//   refused before any work, stable `output.exists` code, sentinel untouched);
// - deep-link confirm gate via argv (`dezoomify://open?v=2&src=...`):
//   pending means zero effects, confirm saves.
//
// Engine-level guarantees (monotonic seq, exactly-once terminal, no tile
// bytes in IPC) are proven by the Rust companion
// (`apps/desktop/src-tauri/tests/desktop_e2e.rs`); this spec asserts their
// UI-observable edge: monotonic progress counts, exactly one terminal
// section, stable error codes (never message text), and redacted reports.
//
// Isolation: one ephemeral loopback port per server per flow, one isolated
// profile per flow, fixed inputs with a fixed seed, no wall-clock
// assertions. Never contacts public websites.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  SEED,
  SCENARIOS_DIR,
  preflight,
  runWindowFlow,
  deliverDeepLink,
  gatewayInput,
  deepLinkArgv,
  redactedOriginOnly,
  assertReportRedacted,
} from "./harness.mjs";
import { goldenOutputHash, assertSavedPyramid } from "./png-assert.mjs";

const GATEWAY_DZI = "https://fixtures.test/cli/pyramid.dzi";

let shared = null;

before(async () => {
  shared = await preflight();
});

after(async () => {
  if (shared) {
    shared.frontend.close();
    shared = null;
  }
});

function expectedHash() {
  const hash = goldenOutputHash(SCENARIOS_DIR);
  assert.match(hash, /^sha256:[0-9a-f]{64}$/, "golden pins a real digest");
  return hash;
}

// Stable selectors from the shared UI (`packages/shared-ui/src/view.ts`)
// plus the desktop aux panel (`apps/desktop/src/main.tsx`).
const SEL = {
  urlInput: "#dz-url-input",
  submit: ".dz-button-row .dz-btn-tactile",
  step: "#dz-job-step-text",
  percent: "#dz-job-percent",
  counts: "#dz-job-counts",
  jobSection: ".dz-job-section",
  recoveryTitle: "#dz-recovery-title",
  recoveryButtons: ".dz-recovery-dialog button",
  completed: ".dz-completed-section",
  completedSummary: ".dz-completed-summary",
  error: ".dz-error-section",
  errorDiagnostics: "#dz-error-diagnostics",
  cancel: "#dz-btn-cancel",
  deepLinkConfirm: "#dz-deep-link-confirm",
};

async function dom(driver, js) {
  return driver.executeScript(`return (${js})`).catch(() => null);
}

async function snapshot(driver) {
  const deepLinkButtonsSel = `${SEL.deepLinkConfirm} button`;
  return driver.executeScript(`return (() => {
    const text = (s) => {
      const el = document.querySelector(s);
      return el ? (el.textContent || "").trim().slice(0, 300) : null;
    };
    const buttons = (s) => Array.from(document.querySelectorAll(s))
      .map((b) => ((b.textContent || "").trim()));
    return {
      step: text(${JSON.stringify(SEL.step)}),
      percent: text(${JSON.stringify(SEL.percent)}),
      counts: text(${JSON.stringify(SEL.counts)}),
      recoveryTitle: text(${JSON.stringify(SEL.recoveryTitle)}),
      recoveryButtons: buttons(${JSON.stringify(SEL.recoveryButtons)}),
      completed: !!document.querySelector(${JSON.stringify(SEL.completed)}),
      completedSummary: text(${JSON.stringify(SEL.completedSummary)}),
      error: !!document.querySelector(${JSON.stringify(SEL.error)}),
      errorDiagnostics: text(${JSON.stringify(SEL.errorDiagnostics)}),
      jobSection: !!document.querySelector(${JSON.stringify(SEL.jobSection)}),
      deepLink: !!document.querySelector(${JSON.stringify(SEL.deepLinkConfirm)}),
      deepLinkButtons: buttons(${JSON.stringify(deepLinkButtonsSel)}),
    };
  })()`);
}

async function waitFor(driver, wanted, timeoutMs, label) {
  const start = Date.now();
  for (;;) {
    const snap = await snapshot(driver);
    if (snap && wanted(snap)) return snap;
    if (Date.now() - start > timeoutMs) {
      assert.fail(`timed out waiting for ${label}: ${JSON.stringify(snap)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
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

// Clicks the "Choose output" recovery action. Returns true only when the
// button was present and clicked (executeScript needs an explicit return).
async function clickChooseOutput(driver) {
  return dom(driver, `(() => {
    const btns = Array.from(document.querySelectorAll(${JSON.stringify(SEL.recoveryButtons)}));
    const b = btns.find((x) => ((x.textContent || "").includes("Choose output")));
    if (b) { b.click(); return true; }
    return false;
  })()`);
}

// Progress samples collected while a save runs: acquired/total pairs plus
// percents. Must stay monotonic; engine-level seq monotonicity rides the
// Rust companion, this is the UI-observable edge.
function sampleCounts(samples, snap) {
  const counts = /(\d+)\s+of\s+(\d+)\s+tiles/.exec(snap.counts ?? "");
  if (counts) samples.push({ current: Number(counts[1]), total: Number(counts[2]) });
  const percent = /(\d+)%/.exec(snap.percent ?? "");
  if (percent) samples.push({ percent: Number(percent[1]) });
}

function assertCountsMonotonic(samples) {
  let current = -1;
  let total = -1;
  let percent = -1;
  for (const sample of samples) {
    if (typeof sample.current === "number") {
      assert.ok(sample.current >= current, `acquired counts monotonic: ${sample.current} after ${current}`);
      current = sample.current;
    }
    if (typeof sample.total === "number") {
      assert.ok(sample.total >= total, `total counts monotonic: ${sample.total} after ${total}`);
      total = sample.total;
    }
    if (typeof sample.percent === "number") {
      assert.ok(sample.percent >= percent, `percent monotonic: ${sample.percent} after ${percent}`);
      percent = sample.percent;
    }
  }
}

function redactedReport(flow, fields) {
  const report = { seed: SEED, flow, ...fields };
  const text = JSON.stringify(report, null, 2);
  assertReportRedacted(text);
  return text;
}

test("real window: submit, destination grant, byte-exact save", { timeout: 180000 }, async () => {
  const hash = expectedHash();
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      await submitUrl(driver, input);
      const discovery = await waitFor(driver, (s) => s.jobSection, 60000, "job section");
      assert.ok((discovery.step ?? "").length > 0, "a step is shown while discovering");
      // Discovery completes into the destination request; image and level
      // ride the pipeline defaults (first image, largest fitting level).
      await waitFor(driver, (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")), 60000, "destination request");
      assert.equal((await snapshot(driver)).recoveryTitle, "Choose where to save");
      const samples = [];
      assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
      const terminal = await (async () => {
        const start = Date.now();
        for (;;) {
          const snap = await snapshot(driver);
          sampleCounts(samples, snap);
          if (snap.completed || snap.error) return snap;
          if (Date.now() - start > 120000) assert.fail(`save never reached a terminal: ${JSON.stringify(snap)}`);
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      assert.equal(terminal.error, false, "no error section on the save flow");
      assertCountsMonotonic(samples);
      assert.match(terminal.completedSummary ?? "", /512 by 512/, "completed summary names the geometry");
      assert.ok(existsSync(fixedDest), "output written to the fixed destination");
      assertSavedPyramid(readFileSync(fixedDest), hash);
      const text = redactedReport("save", {
        scenario: "native/cli-dzi",
        origin: redactedOriginOnly(input),
        save: { width: 512, height: 512, outputHash: hash },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`window save: 512x512 ${hash} (seed ${SEED})`);
    },
  });
});

test("real window: cancel ends the job once with no output", { timeout: 180000 }, async () => {
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "cancelled.png",
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      await submitUrl(driver, input);
      await waitFor(driver, (s) => s.jobSection, 60000, "job section");
      await driver.findElement({ css: SEL.cancel }).click();
      const cancelled = await waitFor(
        driver,
        (s) => !s.jobSection && !s.completed && !s.error,
        60000,
        "cancelled notice",
      );
      void cancelled;
      const bodyText = await dom(driver, "document.body.innerText.slice(0, 2000)");
      assert.match(bodyText ?? "", /Save cancelled/, "cancelled notice is shown");
      // Exactly one terminal at UI level: neither completed nor error
      // sections may appear after the cancel.
      await new Promise((r) => setTimeout(r, 3000));
      const settled = await snapshot(driver);
      assert.equal(settled.completed, false, "no completion after cancel");
      assert.equal(settled.error, false, "no error after cancel");
      assert.ok(!existsSync(fixedDest), "uncommitted output removed on cancel");
      const text = redactedReport("cancel", {
        scenario: "native/cli-dzi",
        origin: redactedOriginOnly(input),
        cancel: { state: "cancelled", cleaned: true },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`window cancel: terminal once, output removed (seed ${SEED})`);
    },
  });
});

test("real window: existing destination is refused with a stable code", { timeout: 180000 }, async () => {
  const sentinel = Buffer.from("sentinel-bytes-never-overwritten");
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "blocked.png",
    preCreateDest: sentinel,
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      await submitUrl(driver, input);
      await waitFor(driver, (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")), 60000, "destination request");
      assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
      const failed = await waitFor(driver, (s) => s.error, 60000, "error section");
      // Stable code, never message text.
      assert.match(failed.errorDiagnostics ?? "", /Code: output\.exists/, "typed destination refusal");
      assert.deepEqual(readFileSync(fixedDest), sentinel, "refused destination left untouched before any work");
      const text = redactedReport("error", {
        scenario: "desktop/destination-denied",
        origin: redactedOriginOnly(input),
        error: { code: "output.exists" },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`window error: output.exists refused before any work (seed ${SEED})`);
    },
  });
});

test("real window: deep link waits for confirm, then saves", { timeout: 180000 }, async () => {
  const hash = expectedHash();
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "handoff.png",
    body: async ({ driver, base, fixedDest, work, appEnv }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      // OS-style delivery: a second process forwards the link argv to the
      // running window, which shows the confirm gate.
      await deliverDeepLink({ appEnv, link: deepLinkArgv(input) });
      // Pending: the confirm gate is visible and nothing has run.
      const pending = await waitFor(driver, (s) => s.deepLink, 60000, "deep-link confirm gate");
      assert.ok((pending.deepLinkButtons ?? []).some((b) => b.includes("Open image")), "confirm action offered");
      assert.equal(pending.jobSection, false, "no job runs while the link is pending");
      assert.ok(!existsSync(fixedDest), "no output while the link is pending");
      await new Promise((r) => setTimeout(r, 3000));
      const still = await snapshot(driver);
      assert.equal(still.jobSection, false, "still no job after the pending settle");
      assert.ok(!existsSync(fixedDest), "still no output while pending");
      // Confirm: the ordinary flow resumes against the confirmed source.
      const confirmedSel = `${SEL.deepLinkConfirm} button`;
      const confirmed = await dom(driver, `(() => {
        const btns = Array.from(document.querySelectorAll(${JSON.stringify(confirmedSel)}));
        const b = btns.find((x) => ((x.textContent || "").includes("Open image")));
        if (b) { b.click(); return true; }
        return false;
      })()`);
      assert.equal(confirmed, true, "confirm action clicked");
      await waitFor(driver, (s) => s.jobSection, 60000, "job section after confirm");
      await waitFor(driver, (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")), 60000, "destination request");
      assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
      const terminal = await waitFor(driver, (s) => s.completed || s.error, 120000, "confirmed save terminal");
      assert.equal(terminal.error, false, "no error section on the confirmed save");
      assert.match(terminal.completedSummary ?? "", /512 by 512/, "completed summary names the geometry");
      assertSavedPyramid(readFileSync(fixedDest), hash);
      const text = redactedReport("deep-link", {
        scenario: "native/cli-dzi",
        origin: redactedOriginOnly(input),
        deepLink: { version: 2, confirmed: true },
        save: { width: 512, height: 512, outputHash: hash },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`window deep-link: confirm-gated save ${hash} (seed ${SEED})`);
    },
  });
});
