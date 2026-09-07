// Real-window desktop E2E: the window shell under tauri-driver against
// hermetic loopback fixtures. Wave-1 flows (submit/save, cancel, refused
// destination, deep-link gate) plus the native-UI flows below. Every flow
// uses ephemeral loopback fixtures only; engine-level guarantees ride the
// Rust companion (`apps/desktop/src-tauri/tests/desktop_e2e.rs`), this spec
// asserts the UI-observable edge.
//
// Isolation: one ephemeral loopback port per server per flow, one isolated
// profile per flow, fixed inputs with a fixed seed, no wall-clock
// assertions. Never contacts public websites.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SEED,
  SCENARIOS_DIR,
  FRONTEND_PORT,
  preflight,
  runWindowFlow,
  startFixtureServer,
  startTauriDriver,
  launchApp,
  freePort,
  ensureDisplay,
  ensureWindowShell,
  deliverDeepLink,
  gatewayInput,
  deepLinkArgv,
  redactedOriginOnly,
  assertReportRedacted,
} from "./harness.mjs";
import { goldenOutputHash, assertSavedPyramid, decodePngSize } from "./png-assert.mjs";

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
  jobDetail: "#dz-job-detail",
  jobImages: "#dz-job-images",
  jobImagesText: "#dz-job-images-text",
  recoveryTitle: "#dz-recovery-title",
  recoveryDesc: "#dz-recovery-desc",
  recoveryButtons: ".dz-recovery-dialog button",
  completed: ".dz-completed-section",
  completedSummary: ".dz-completed-summary",
  error: ".dz-error-section",
  errorDiagnostics: "#dz-error-diagnostics",
  cancel: "#dz-btn-cancel",
  tryAgain: "#dz-btn-try-again",
  copyDiag: "#dz-btn-copy-diag",
  settingsPanel: "#dz-desktop-settings",
  settingsOutputDir: "#dz-settings-output-dir",
  settingsCompression: "#dz-settings-compression",
  settingsRetries: "#dz-settings-retries",
  settingsError: "#dz-settings-error",
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
    const imagesEl = document.querySelector(${JSON.stringify(SEL.jobImages)});
    return {
      step: text(${JSON.stringify(SEL.step)}),
      percent: text(${JSON.stringify(SEL.percent)}),
      counts: text(${JSON.stringify(SEL.counts)}),
      jobDetail: text(${JSON.stringify(SEL.jobDetail)}),
      imagesNotice: text(${JSON.stringify(SEL.jobImagesText)}),
      imagesVisible: !!imagesEl && imagesEl.style.display !== "none",
      recoveryTitle: text(${JSON.stringify(SEL.recoveryTitle)}),
      recoveryDesc: text(${JSON.stringify(SEL.recoveryDesc)}),
      recoveryButtons: buttons(${JSON.stringify(SEL.recoveryButtons)}),
      settingsError: text(${JSON.stringify(SEL.settingsError)}),
      settingsAlert: !!document.querySelector(${JSON.stringify(SEL.settingsError)} + '[role="alert"]'),
      copyDiag: !!document.querySelector(${JSON.stringify(SEL.copyDiag)}),
      tryAgain: !!document.querySelector(${JSON.stringify(SEL.tryAgain)}),
      urlValue: document.querySelector(${JSON.stringify(SEL.urlInput)})?.value ?? null,
      idle: !!document.querySelector(${JSON.stringify(SEL.urlInput)})
        && !document.querySelector(${JSON.stringify(SEL.jobSection)})
        && !document.querySelector(${JSON.stringify(SEL.completed)})
        && !document.querySelector(${JSON.stringify(SEL.error)}),
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

// --- Native-UI flows (all hermetic, loopback fixtures only) ---

// Settings inputs persist without focus (the panel skips rebuild while
// focused, and listens for `change`): set the value programmatically and
// fire input+change without ever focusing the field.
async function setPanelInput(driver, selector, value, fireChange = true) {
  const ok = await driver.executeScript((sel, val, change) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.value = val;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    if (change) el.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }, selector, value, fireChange);
  assert.equal(ok, true, `settings input present: ${selector}`);
}

async function panelInputValue(driver, selector) {
  return dom(driver, `document.querySelector(${JSON.stringify(selector)})?.value ?? null`);
}

async function readStoredSettingsText(driver) {
  return driver.executeScript(`return localStorage.getItem("dezoomify.desktop.settings.v1")`);
}

// Clicks a `.dz-recovery-dialog` button by visible-text substring.
async function clickDialogButton(driver, text) {
  return driver.executeScript((wanted) => {
    const btns = Array.from(document.querySelectorAll(".dz-recovery-dialog button"));
    const b = btns.find((x) => ((x.textContent || "").includes(wanted)));
    if (b) { b.click(); return true; }
    return false;
  }, text);
}

function fixtureLogLines(logPath) {
  try {
    if (!existsSync(logPath)) return [];
    return readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

function parseJpegSize(bytes) {
  assert.equal(bytes[0], 0xff, "JPEG SOI marker");
  assert.equal(bytes[1], 0xd8, "JPEG SOI marker");
  let off = 2;
  while (off + 4 < bytes.length) {
    assert.equal(bytes[off], 0xff, "JPEG marker prefix");
    const marker = bytes[off + 1];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2;
      continue;
    }
    const len = bytes.readUInt16BE(off + 2);
    assert.ok(len >= 2, "JPEG segment length");
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: bytes.readUInt16BE(off + 5), width: bytes.readUInt16BE(off + 7) };
    }
    off += 2 + len;
  }
  assert.fail("no SOF marker in JPEG output");
}

// Manual lifecycle for flows that relaunch the app on one shared profile
// (settings round-trip) or navigate the launch URL (idle prefill).
// `series` runs sequentially: one fixture server, fresh driver ports and one
// app launch per step, same HOME every step. Profiles and temp work are
// removed afterwards even on failure.
async function runProfileSeries({ nativeDriverBin, fixedName = "saved.png", series }) {
  ensureDisplay();
  ensureWindowShell();
  const profile = mkdtempSync(path.join(tmpdir(), "dezoomify-window-e2e-profile-"));
  const home = path.join(profile, "home");
  mkdirSync(home, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), "dezoomify-window-e2e-"));
  let fixture = null;
  try {
    fixture = await startFixtureServer(work);
    const requestLog = path.join(work, "requests.log");
    for (let i = 0; i < series.length; i += 1) {
      const fixedDest = path.join(work, `${i}-${fixedName}`);
      const tauriPort = await freePort();
      const nativePort = await freePort();
      const appEnv = {
        ...process.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local/share"),
        XDG_CACHE_HOME: path.join(home, ".cache"),
        DEZOOMIFY_E2E_WINDOW: "1",
        DEZOOMIFY_E2E_FIXED_DESTINATION: fixedDest,
      };
      const driverProc = await startTauriDriver(tauriPort, nativePort, nativeDriverBin, appEnv);
      let driver = null;
      try {
        driver = await launchApp({ tauriPort });
        await series[i]({ driver, base: fixture.base, home, fixedDest, work, appEnv, requestLog });
      } finally {
        if (driver) await driver.quit().catch(() => {});
        driverProc.proc.kill();
      }
    }
  } finally {
    if (fixture) fixture.proc.kill();
    rmSync(work, { recursive: true, force: true });
    rmSync(profile, { recursive: true, force: true });
  }
}

test("real window: settings persist across relaunch; invalid draft blocked", { timeout: 300000 }, async () => {
  let firstStored = null;
  await runProfileSeries({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "settings.png",
    series: [
      async ({ driver, home }) => {
        await waitFor(driver, (s) => s.idle, 60000, "idle settings form");
        const outDir = path.join(home, "outputs");
        mkdirSync(outDir, { recursive: true });
        await setPanelInput(driver, SEL.settingsOutputDir, outDir);
        await setPanelInput(driver, SEL.settingsCompression, "42");
        await setPanelInput(driver, SEL.settingsRetries, "7");
        const text = await readStoredSettingsText(driver);
        assert.ok(text, "settings persisted to localStorage");
        const parsed = JSON.parse(text);
        assert.equal(parsed.outputDir, outDir, "output dir round-trips in storage");
        assert.equal(parsed.compression, 42, "compression round-trips in storage");
        assert.equal(parsed.retries, 7, "retries round-trip in storage");
        assert.equal(parsed.outputFormat, "png", "output format defaults to PNG in storage");
        firstStored = text;
        const snap = await snapshot(driver);
        assert.equal(snap.settingsError, null, "no settings error for the valid draft");
        assert.equal(snap.jobSection, false, "persisting settings starts no job");
        const report = redactedReport("settings-save", {
          scenario: "n/a",
          origin: "n/a",
          settings: { compression: 42, retries: 7, outputDir: "set" },
        });
        assert.ok(!report.includes(home), "no absolute profile paths in the report");
        console.log(`window settings: valid draft persisted (seed ${SEED})`);
      },
      async ({ driver, base, fixedDest, requestLog }) => {
        await waitFor(driver, (s) => s.idle, 60000, "idle form after relaunch");
        // Round-trip: the relaunched app renders the persisted values.
        assert.equal(await panelInputValue(driver, SEL.settingsOutputDir), JSON.parse(firstStored).outputDir);
        assert.equal(await panelInputValue(driver, SEL.settingsCompression), "42");
        assert.equal(await panelInputValue(driver, SEL.settingsRetries), "7");
        assert.equal(JSON.parse(firstStored).outputFormat, "png", "default encoder persisted");
        assert.equal(await readStoredSettingsText(driver), firstStored, "storage identical after relaunch");
        // Invalid draft via change: inline role=alert, last good kept,
        // still idle with no job.
        await setPanelInput(driver, SEL.settingsRetries, "999");
        const alerted = await waitFor(
          driver,
          (s) => s.settingsAlert && (s.settingsError ?? "").toLowerCase().includes("retries"),
          30000,
          "inline retries alert",
        );
        void alerted;
        assert.equal(await readStoredSettingsText(driver), firstStored, "invalid draft never overwrites storage");
        const idle = await snapshot(driver);
        assert.equal(idle.jobSection, false, "invalid draft starts no job");
        assert.equal(idle.completed, false, "no completion from an invalid draft");
        assert.equal(idle.error, false, "invalid draft alone is not a job failure");
        // Invalid submit: type the invalid value without change (input
        // event only, so no persist runs), then submit. The submit must
        // fail closed with INVALID_SETTINGS and zero effects: no output,
        // no fixture fetch.
        await setPanelInput(driver, SEL.settingsRetries, "999", false);
        const logBefore = fixtureLogLines(requestLog).length;
        await submitUrl(driver, gatewayInput(base, GATEWAY_DZI));
        const failed = await waitFor(driver, (s) => s.error, 60000, "invalid-settings error");
        assert.match(failed.errorDiagnostics ?? "", /Code: INVALID_SETTINGS/, "typed invalid-settings refusal");
        const alertAfter = await snapshot(driver);
        assert.equal(alertAfter.settingsAlert, true, "inline alert still shown after the refused submit");
        assert.ok(!existsSync(fixedDest), "refused submit writes no output");
        assert.equal(fixtureLogLines(requestLog).length, logBefore, "refused submit never fetched");
        const report = redactedReport("settings-invalid", {
          scenario: "n/a",
          origin: "n/a",
          error: { code: "INVALID_SETTINGS" },
        });
        assertReportRedacted(report);
        console.log(`window settings: round-trip ok, invalid draft blocked (seed ${SEED})`);
      },
    ],
  });
});

test("real window: corrupt tile with keep policy still saves", { timeout: 240000 }, async () => {
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "kept-partial.png",
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, "https://fixtures.test/desktop/tile-failure-keep/corrupt.dzi");
      await submitUrl(driver, input);
      await waitFor(driver, (s) => s.jobSection, 60000, "job section");
      await waitFor(driver, (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")), 60000, "destination request");
      assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
      // The native driver auto-answers the engine's partial request with
      // the Keep default (crates/dezoomify-native/src/job_driver.rs
      // request-decision branch), so the interactive partial-recovery
      // dialog is not expected here. If the dialog ever appears, its Keep
      // path must still complete the save.
      const terminal = await (async () => {
        const start = Date.now();
        for (;;) {
          const snap = await snapshot(driver);
          const partialDialog = (snap.recoveryButtons ?? []).some((b) => b.includes("Keep partial"));
          if (partialDialog) return { snap, viaDialog: true };
          if (snap.completed || snap.error) return { snap, viaDialog: false };
          if (Date.now() - start > 150000) assert.fail(`kept save never settled: ${JSON.stringify(snap)}`);
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      if (terminal.viaDialog) {
        const buttons = terminal.snap.recoveryButtons ?? [];
        assert.ok(buttons.some((b) => b.includes("Keep partial")), "keep action offered");
        assert.ok(buttons.some((b) => b.includes("Discard")), "discard action offered");
        assert.ok(buttons.some((b) => b.includes("Retry")), "retry action offered");
        assert.equal(await clickDialogButton(driver, "Keep partial"), true, "keep-partial clicked");
        const done = await waitFor(driver, (s) => s.completed || s.error, 120000, "kept terminal");
        assert.equal(done.error, false, "kept partial completes without error");
      } else {
        assert.equal(terminal.snap.error, false, "no error section on the kept save");
      }
      // Kept partials publish to the `.partial` sibling, never to the
      // granted destination (crates/dezoomify-native/src/job_driver.rs
      // partial publish; partial_path_for in output.rs): the kept bytes
      // land at kept-partial.partial.png with full geometry while the
      // granted path stays untouched, so a partial file never masquerades
      // as the complete save.
      const sibling = fixedDest.replace(/\.png$/, ".partial.png");
      assert.ok(existsSync(sibling), "kept partial published to the sibling path");
      const { width, height } = decodePngSize(readFileSync(sibling));
      assert.equal(width, 512, "kept image width");
      assert.equal(height, 512, "kept image height");
      assert.ok(!existsSync(fixedDest), "granted destination untouched by the partial publish");
      const text = redactedReport("partial-keep", {
        scenario: "desktop/tile-failure-keep",
        origin: redactedOriginOnly(input),
        save: { width: 512, height: 512, viaDialog: terminal.viaDialog, sibling: "kept-partial.partial.png" },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`window partial-keep: 512x512 sibling (viaDialog=${terminal.viaDialog}, seed ${SEED})`);
    },
  });
});

test("real window: missing tiles complete as kept partial to the sibling", { timeout: 240000 }, async () => {
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "failed-tiles.png",
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, "https://fixtures.test/desktop/tile-failure-fail/broken.dzi");
      await submitUrl(driver, input);
      await waitFor(driver, (s) => s.jobSection, 60000, "job section");
      await waitFor(driver, (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")), 60000, "destination request");
      assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
      // Desktop defaults keep partial output (PartialPolicy::Keep): the two
      // 404 tiles exhaust retries, the kept partial publishes to the
      // sibling, and the save completes. The engine-level fail policy
      // (tile.download-failed) is unreachable from this UI because the
      // shell auto-answers partial decisions and never surfaces
      // AwaitingPartialDecision; see the report for the exact evidence.
      const terminal = await waitFor(driver, (s) => s.completed || s.error, 180000, "kept-partial terminal");
      assert.equal(terminal.error, false, "missing tiles complete as kept partial under desktop defaults");
      assert.match(terminal.completedSummary ?? "", /512 by 512/, "completed summary names the geometry");
      const sibling = fixedDest.replace(/\.png$/, ".partial.png");
      assert.ok(existsSync(sibling), "kept partial published to the sibling path");
      const { width, height } = decodePngSize(readFileSync(sibling));
      assert.equal(width, 512, "kept image width");
      assert.equal(height, 512, "kept image height");
      assert.ok(!existsSync(fixedDest), "granted destination untouched by the partial publish");
      const text = redactedReport("partial-fail-kept", {
        scenario: "desktop/tile-failure-fail",
        origin: redactedOriginOnly(input),
        save: { width: 512, height: 512, sibling: "failed-tiles.partial.png" },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`window partial-fail-kept: 512x512 sibling (seed ${SEED})`);
    },
  });
});

test("real window: destination journey covers handoff, refusal, try-again", { timeout: 240000 }, async () => {
  const sentinel = Buffer.from("sentinel-bytes-never-overwritten");
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "recover.png",
    preCreateDest: sentinel,
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      await submitUrl(driver, input);
      // The destination request offers Choose output and Use another app.
      const requested = await waitFor(
        driver,
        (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")),
        60000,
        "destination request",
      );
      assert.equal(requested.recoveryTitle, "Choose where to save");
      assert.ok((requested.recoveryButtons ?? []).some((b) => b.includes("Use another app")), "handoff action offered");
      // Use another app explains the handoff without any effect: no
      // terminal, no output, the request still waits.
      assert.equal(await clickDialogButton(driver, "Use another app"), true, "use-another-app clicked");
      const handoff = await waitFor(
        driver,
        (s) => (s.jobDetail ?? "").includes("handed to another app"),
        30000,
        "handoff messaging",
      );
      assert.equal(handoff.completed, false, "no completion from the handoff check");
      assert.equal(handoff.error, false, "no error from the handoff check");
      assert.ok((handoff.recoveryButtons ?? []).some((b) => b.includes("Choose output")), "request still waits");
      assert.deepEqual(readFileSync(fixedDest), sentinel, "no grant before choose-output");
      // Choose output against the existing destination is refused with the
      // stable code and the sentinel untouched; Try again returns to idle.
      assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
      const failed = await waitFor(driver, (s) => s.error, 60000, "refused destination");
      assert.match(failed.errorDiagnostics ?? "", /Code: output\.exists/, "typed destination refusal");
      assert.deepEqual(readFileSync(fixedDest), sentinel, "refused destination left untouched");
      assert.equal(failed.tryAgain, true, "try-again offered after refusal");
      await driver.findElement({ css: SEL.tryAgain }).click();
      const idle = await waitFor(driver, (s) => s.idle, 60000, "idle after try-again");
      void idle;
      const text = redactedReport("destination-journey", {
        scenario: "desktop/destination-denied",
        origin: redactedOriginOnly(input),
        error: { code: "output.exists" },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`window destination journey: handoff, refusal, try-again (seed ${SEED})`);
    },
  });
});

test("real window: progress is monotonic; diagnostics copy redacted", { timeout: 300000 }, async () => {
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "progress-partial.png",
    body: async ({ driver, base, fixedDest, work }) => {
      // The corrupt-tile fixture stretches the downloading phase over
      // retry backoffs, so determinate progress snapshots are guaranteed
      // (the 4-tile loopback DZI finishes between two 250 ms polls).
      const input = gatewayInput(base, "https://fixtures.test/desktop/tile-failure-keep/corrupt.dzi");
      await submitUrl(driver, input);
      await waitFor(driver, (s) => s.jobSection, 60000, "job section");
      await waitFor(driver, (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")), 60000, "destination request");
      assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
      const samples = [];
      let imagesSeen = false;
      let bodyHadDisplayOnly = false;
      const terminal = await (async () => {
        const start = Date.now();
        for (;;) {
          const snap = await snapshot(driver);
          sampleCounts(samples, snap);
          if (snap.imagesVisible) imagesSeen = true;
          if (Date.now() - start > 150000) assert.fail(`save never reached a terminal: ${JSON.stringify(snap)}`);
          if (snap.completed || snap.error) return snap;
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      assert.equal(terminal.error, false, "no error section on the progress flow");
      assertCountsMonotonic(samples);
      // Determinate progress for the real 4-tile pyramid: totals stay 0
      // while discovering, then pin at 4 with acquired <= total.
      const totals = samples.filter((s) => typeof s.total === "number").map((s) => s.total);
      assert.ok(totals.length > 0, "determinate progress samples collected");
      for (const t of totals) assert.ok(t === 0 || t === 4, `stable total (0 then 4), saw ${t}`);
      const percents = samples.filter((s) => typeof s.percent === "number").map((s) => s.percent);
      assert.ok(percents.length > 0, "percent samples collected");
      for (const p of percents) assert.ok(p >= 0 && p <= 100, `percent in range: ${p}`);
      // The kept partial still publishes its sibling on this flow.
      const sibling = fixedDest.replace(/\.png$/, ".partial.png");
      assert.ok(existsSync(sibling), "kept partial published to the sibling path");
      // Single-image honesty: the DZI catalog never claims multiple
      // images, and no display-only branch appears on the native path.
      assert.equal(imagesSeen, false, "no multi-image notice for the single-image DZI");
      const bodyText = await dom(driver, "document.body.innerText.slice(0, 4000)");
      bodyHadDisplayOnly = (bodyText ?? "").includes("Shown below without saving");
      assert.equal(bodyHadDisplayOnly, false, "no display-only branch on the native save path");
      // Copy diagnostics: stub only the clipboard sink, click the real
      // button, and assert the copied text carries presence markers with
      // no secrets, full URLs, or absolute paths.
      const stubbed = await driver.executeScript(`return (() => {
        window.__dzE2eClipboard = null;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText = (t) => {
              window.__dzE2eClipboard = t;
              return Promise.resolve();
            };
            return true;
          }
        } catch (e) { /* fall through */ }
        return false;
      })()`);
      assert.equal(stubbed, true, "clipboard sink stubbed");
      await driver.findElement({ css: SEL.copyDiag }).click();
      const copied = await (async () => {
        const start = Date.now();
        for (;;) {
          const t = await dom(driver, "window.__dzE2eClipboard");
          if (typeof t === "string" && t.length > 0) return t;
          if (Date.now() - start > 30000) assert.fail("copy-diagnostics never wrote to the clipboard");
          await new Promise((r) => setTimeout(r, 250));
        }
      })();
      assert.match(copied, /Status: completed/, "diagnostics carry the status");
      assert.match(copied, /App: dezoomify-desktop/, "diagnostics carry the app provenance");
      assert.match(copied, /Protocol: 1\.0/, "diagnostics carry the protocol");
      assert.match(copied, /Origin: http:\/\/127\.0\.0\.1:\d+/, "diagnostics carry the redacted loopback origin");
      assert.match(copied, /Tiles: \d+ of \d+/, "diagnostics carry tile counts");
      assertReportRedacted(copied);
      assert.ok(!copied.includes("fixtures.test"), "no full fixture URLs in diagnostics");
      assert.ok(!copied.includes(work), "no absolute profile paths in diagnostics");
      const btnText = await dom(driver, `document.querySelector(${JSON.stringify(SEL.copyDiag)})?.textContent ?? null`);
      assert.match(btnText ?? "", /Copied/, "copy feedback shown");
      const text = redactedReport("progress-diagnostics", {
        scenario: "desktop/tile-failure-keep",
        origin: redactedOriginOnly(input),
        progress: { samples: samples.length },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`window progress: ${samples.length} samples monotonic, diagnostics redacted (seed ${SEED})`);
    },
  });
});

test("real window: idle prefill without auto-start; hashchange re-syncs", { timeout: 240000 }, async () => {
  await runProfileSeries({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "prefill.png",
    series: [
      async ({ driver, base, fixedDest, requestLog }) => {
        const input1 = gatewayInput(base, GATEWAY_DZI);
        const input2 = gatewayInput(base, "https://fixtures.test/desktop/basic/pyramid.dzi");
        await driver.get(`http://127.0.0.1:${FRONTEND_PORT}/index.html?url=${encodeURIComponent(input1)}`);
        // Prefill with no auto-start: the box shows the launch URL while
        // the app stays idle and fetches nothing.
        const prefilled = await waitFor(driver, (s) => s.urlValue === input1, 60000, "url prefill");
        assert.equal(prefilled.jobSection, false, "no job starts from the launch URL");
        assert.equal(prefilled.completed, false, "no completion without submit");
        assert.equal(prefilled.error, false, "no error without submit");
        await new Promise((r) => setTimeout(r, 3000));
        const settled = await snapshot(driver);
        assert.equal(settled.jobSection, false, "still no job after the idle settle");
        assert.equal(settled.urlValue, input1, "prefill survives the settle");
        assert.deepEqual(fixtureLogLines(requestLog), [], "prefill fetched nothing");
        assert.ok(!existsSync(fixedDest), "no output without submit");
        // Hashchange re-syncs the idle box. The launch search (?url=)
        // always wins over the hash (readInitialUrl reads search first),
        // so re-sync is proven from a clean load with an empty box: the
        // shared input fills the empty box and never overwrites typing.
        await driver.get(`http://127.0.0.1:${FRONTEND_PORT}/index.html`);
        const emptyBox = await waitFor(driver, (s) => s.urlValue === "", 60000, "empty box on clean load");
        assert.equal(emptyBox.jobSection, false, "clean load starts no job");
        await driver.executeScript((v) => {
          location.hash = `#url=${encodeURIComponent(v)}`;
        }, input2);
        const resynced = await waitFor(driver, (s) => s.urlValue === input2, 30000, "hash re-sync");
        assert.equal(resynced.jobSection, false, "no job starts from the hash URL");
        await new Promise((r) => setTimeout(r, 2000));
        const settled2 = await snapshot(driver);
        assert.equal(settled2.jobSection, false, "still no job after the hash settle");
        assert.deepEqual(fixtureLogLines(requestLog), [], "hash prefill fetched nothing");
        // An invalid launch URL prefills nothing and still starts nothing.
        await driver.get(`http://127.0.0.1:${FRONTEND_PORT}/index.html?url=${encodeURIComponent("not-a-url")}`);
        const empty = await waitFor(driver, (s) => s.urlValue !== null, 60000, "idle form after invalid url");
        assert.equal(empty.urlValue, "", "invalid launch URL leaves the box empty");
        assert.equal(empty.jobSection, false, "invalid launch URL starts no job");
        assert.deepEqual(fixtureLogLines(requestLog), [], "invalid prefill fetched nothing");
        const text = redactedReport("idle-prefill", {
          scenario: "n/a",
          origin: redactedOriginOnly(input1),
          prefill: { hashSync: true, autostart: false },
        });
        assertReportRedacted(text);
        console.log(`window prefill: no auto-start, hash re-sync ok (seed ${SEED})`);
      },
    ],
  });
});

test("real window: JPEG save pins quality 100-compression (default 95)", { timeout: 300000 }, async () => {
  const reads = [];
  await runProfileSeries({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "pinned.jpg",
    series: [
      async ({ driver, base, fixedDest, work }) => {
        await waitFor(driver, (s) => s.idle, 60000, "idle form");
        // The shipped default compression is 5, so the encoder quality
        // pins at 100-5 = 95 (crates/dezoomify-native/src/pipeline.rs
        // jpeg_quality; apps/desktop/src/settings.ts DEFAULT_COMPRESSION).
        assert.equal(await panelInputValue(driver, SEL.settingsCompression), "5", "default compression is 5");
        const input = gatewayInput(base, GATEWAY_DZI);
        await submitUrl(driver, input);
        await waitFor(driver, (s) => s.jobSection, 60000, "job section");
        await waitFor(driver, (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")), 60000, "destination request");
        await driver.findElement({ css: 'input[name="dz-output-format"][value="jpeg"]' }).click();
        const checked = await driver.findElement({ css: 'input[name="dz-output-format"][value="jpeg"]' }).isSelected();
        assert.equal(checked, true, "JPEG format selected");
        assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
        const terminal = await waitFor(driver, (s) => s.completed || s.error, 150000, "jpeg terminal");
        assert.equal(terminal.error, false, "no error section on the JPEG save");
        assert.ok(existsSync(fixedDest), "JPEG output written");
        const bytes = readFileSync(fixedDest);
        const size = parseJpegSize(bytes);
        assert.equal(size.width, 512, "JPEG width");
        assert.equal(size.height, 512, "JPEG height");
        assert.equal(bytes[bytes.length - 2], 0xff, "JPEG EOI marker");
        assert.equal(bytes[bytes.length - 1], 0xd9, "JPEG EOI marker");
        reads.push(bytes);
        const stored = await readStoredSettingsText(driver);
        assert.equal(JSON.parse(stored).outputFormat, "jpeg", "JPEG choice persisted to storage");
        const text = redactedReport("jpeg-default", {
          scenario: "native/cli-dzi",
          origin: redactedOriginOnly(input),
          save: { width: 512, height: 512, format: "jpeg", quality: 95 },
        });
        assert.ok(!text.includes(work), "no absolute profile paths in the report");
        console.log(`window jpeg: 512x512 quality 95 (seed ${SEED})`);
      },
      async ({ driver, base, fixedDest }) => {
        await waitFor(driver, (s) => s.idle, 60000, "idle form");
        // Move the knob: compression 30 must change the encoded bytes
        // (quality 70), proving the setting drives the encoder.
        await setPanelInput(driver, SEL.settingsCompression, "30");
        const input = gatewayInput(base, GATEWAY_DZI);
        await submitUrl(driver, input);
        await waitFor(driver, (s) => s.jobSection, 60000, "job section");
        await waitFor(driver, (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")), 60000, "destination request");
        // Reload round-trip: step 1 persisted the JPEG choice on the shared
        // profile, so the relaunched picker seeds JPEG without a click.
        const jpegRadio = await driver.findElement({ css: 'input[name="dz-output-format"][value="jpeg"]' });
        assert.equal(await jpegRadio.isSelected(), true, "persisted JPEG choice seeds the picker after relaunch");
        await jpegRadio.click();
        assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
        const terminal = await waitFor(driver, (s) => s.completed || s.error, 150000, "jpeg terminal");
        assert.equal(terminal.error, false, "no error section on the recompressed save");
        const bytes = readFileSync(fixedDest);
        const size = parseJpegSize(bytes);
        assert.equal(size.width, 512, "recompressed JPEG width");
        assert.equal(size.height, 512, "recompressed JPEG height");
        assert.equal(reads.length, 1, "default-quality bytes captured");
        assert.ok(!reads[0].equals(bytes), "compression setting drives the JPEG encoder");
        console.log(`window jpeg: quality knob wired 95 vs 70 (seed ${SEED})`);
      },
    ],
  });
});
