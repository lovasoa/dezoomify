// Real-window desktop E2E: data-driven full-download matrix, one case per
// site format (registry order in
// `crates/dezoomify-core/src/core/registry.rs`). Proves byte-exact output on
// Linux through the real window shell under tauri-driver against hermetic
// loopback fixtures. Portable by construction (loopback only, fixed inputs,
// fixed seed, no wall-clock assertions); macOS/Windows CI proof is a later
// wave.
//
// Ownership: this file is disjoint from `window.spec.mjs` (native-feature
// flows). It duplicates the small DOM/polling helpers below instead of
// importing them from `window.spec.mjs`, and imports the harness plus the
// PNG golden helpers read-only (no edits to shared files). All new logic
// (JPEG/TIFF byte asserts, format matrix, radio selection) lives here.
//
// Coverage (evidenced 2026-09-07 by driving the same native pipeline via the
// CLI against the same fixture server; the window runs below re-prove it):
// - PASS (full download, byte-exact): `deepzoom` (PNG/JPEG/TIFF encoder
//   paths), `generic` (PNG, probed X/Y template).
// - SKIP with an explicit mechanical reason: the other 16 formats have no
//   deterministic local tile chain servable on loopback. Two failure
//   classes, both structural to the gateway submit the desktop uses
//   (`{origin}/fetch?url=<inner>`: tile URLs must stay gateway-wrapped or
//   match a fixture route):
//   (a) URL-shape discovery gates that cannot see the inner URL through the
//       gateway outer path (`/fetch`): custom, google_arts_and_culture,
//       zoomify, xlimage, fsi, vls, arcgis.
//   (b) discovery succeeds but tile URLs are absolute/unserved on loopback
//       (fixtures.test is unresolvable; `{{origin}}`-absolute tiles hit the
//       fixture static 404), so every tile 404s and only a blank 0-tile
//       partial remains: iiif, krpano, iipimage, topviewer, lizardtech,
//       hungaricana, wmts, pnav. bulk_text has no served URL-list input at
//       all (its download path needs a loopback:// deferred responder).
//   Adding tile chains would need new scenario payloads plus manifest.json
//   entries (shared, sibling-owned); deliberately out of scope here.
// - Encoder matrix: PNG (deepzoom, generic), JPEG (deepzoom), TIFF
//   (deepzoom) pass. `iiif-dir` (extensionless destination) is a documented
//   skip: the backend accepts format=iiif-dir (see the
//   `desktop/basic-iiif-dir` pipeline scenario) but the window UI in this
//   tree exposes only png/jpeg/tiff radios, so no DOM path can request it.
//
// Lane wiring: `cargo xtask test desktop --e2e-window` runs
// `window.spec.mjs` then this file sequentially (`crates/xtask/src/desktop.rs`),
// each in its own process so the fixed frontend port is never double-bound.
// This file also runs standalone with the same staged environment the lane
// prepares:
//   DISPLAY=:99 DEZOOMIFY_WINDOW_E2E_APP_BIN=$PWD/target/e2e-window/dezoomify-desktop \
//     DEZOOMIFY_WINDOW_E2E_DIST=$PWD/target/e2e-window/dist \
//     node --test apps/desktop/tests/window-e2e/formats.spec.mjs
// It is also import-safe: the preflight below reuses
// `globalThis.__dezoomifyWindowE2eShared` when a future importer sets it, so
// a later wave can fold this matrix into one process without rebinding the
// fixed frontend port.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  SEED,
  SCENARIOS_DIR,
  preflight,
  runWindowFlow,
  gatewayInput,
  redactedOriginOnly,
  assertReportRedacted,
} from "./harness.mjs";
import { goldenOutputHash, sha256Hex, assertSavedPyramid } from "./png-assert.mjs";

// ---------------------------------------------------------------------------
// Pinned inputs and goldens (all loopback; never public network).
// ---------------------------------------------------------------------------

// DZI pyramid shared by the deepzoom PNG/JPEG/TIFF encoder cases.
const GATEWAY_DZI = "https://fixtures.test/cli/pyramid.dzi";
// Generic X/Y template shared by the generic case (same quadrant tiles as
// the DZI pyramid, so the same PNG golden applies).
const GATEWAY_PROBE_TEMPLATE = "https://fixtures.test/probe/{{X}}/{{Y}}.png";

// JPEG golden for the DZI pyramid at the desktop default (compression 5 =>
// quality 95, same default the CLI uses): produced by the shared native
// pipeline over loopback fixtures; the window run below re-proves
// byte-exactness through the real shell instead of trusting it.
const EXPECTED_JPEG_HASH = "sha256:d33f06c199f90b0cfaa281066f4bcf98423a24ce29dabf7ae227e2f27f6bc1e7";
// TIFF golden, same provenance as the JPEG golden (default deflate tier).
const EXPECTED_TIFF_HASH = "sha256:ede4363cc018c9c22b8dfa35a95702a3ec8ce7c43d4844eb5e5c1b2d1f2adc1e";
const EXPECTED_WIDTH = 512;
const EXPECTED_HEIGHT = 512;

function probeGridGoldenHash() {
  const raw = readFileSync(
    path.join(SCENARIOS_DIR, "native/cli-probe-grid/expected/result.json"),
    "utf8",
  );
  const hash = JSON.parse(raw).outputHash;
  assert.match(hash, /^sha256:[0-9a-f]{64}$/, "probe-grid golden pins a real digest");
  return hash;
}

// ---------------------------------------------------------------------------
// DOM helpers (duplicated from window.spec.mjs; disjoint ownership means no
// shared-helper edits).
// ---------------------------------------------------------------------------

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
  formatRadio: "#dz-output-format-group input[name=\"dz-output-format\"]",
};

async function dom(driver, js) {
  return driver.executeScript(`return (${js})`).catch(() => null);
}

async function snapshot(driver) {
  return driver.executeScript(`return (() => {
    const text = (s) => {
      const el = document.querySelector(s);
      return el ? (el.textContent || "").trim().slice(0, 300) : null;
    };
    const buttons = (s) => Array.from(document.querySelectorAll(s))
      .map((b) => ((b.textContent || "").trim()));
    const checkedFormat = (() => {
      const el = document.querySelector(${JSON.stringify(SEL.formatRadio + ":checked")});
      return el ? el.value : null;
    })();
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
      checkedFormat,
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

async function clickChooseOutput(driver) {
  return dom(driver, `(() => {
    const btns = Array.from(document.querySelectorAll(${JSON.stringify(SEL.recoveryButtons)}));
    const b = btns.find((x) => ((x.textContent || "").includes("Choose output")));
    if (b) { b.click(); return true; }
    return false;
  })()`);
}

// Selects one encoder radio in the desktop aux panel. Fails closed (returns
// false) when the UI offers no such radio, so a missing selector surfaces
// as a hard failure at the call site rather than a silent PNG default.
async function selectOutputFormat(driver, value) {
  // The selector travels as a script argument (not interpolation) so no
  // quoting construct can confuse the parser or the page.
  const selector = SEL.formatRadio + '[value="' + value + '"]';
  return driver.executeScript(function (sel) {
    const el = document.querySelector(sel);
    if (!el) return "missing";
    el.click();
    return el.checked ? "checked" : "unchecked";
  }, selector).catch(() => null);
}

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

// ---------------------------------------------------------------------------
// Byte asserts for the encoder matrix (self-contained; PNG reuses the
// shared golden helpers read-only).
// ---------------------------------------------------------------------------

function assertJpegSize(bytes, width, height) {
  assert.ok(bytes.length > 2 && bytes[0] === 0xff && bytes[1] === 0xd8, "JPEG SOI magic");
  let offset = 2;
  for (;;) {
    assert.ok(offset + 4 <= bytes.length, "JPEG SOF found before EOI");
    assert.equal(bytes[offset], 0xff, "JPEG marker prefix");
    let marker = bytes[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = bytes[offset + 1];
    }
    if (marker === 0xd9) assert.fail("JPEG ended without a start-of-frame");
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    assert.ok(length >= 2 && offset + 2 + length <= bytes.length, "JPEG segment in bounds");
    const isSof = (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc);
    if (isSof) {
      const h = bytes.readUInt16BE(offset + 5);
      const w = bytes.readUInt16BE(offset + 7);
      assert.equal(w, width, "JPEG width");
      assert.equal(h, height, "JPEG height");
      return;
    }
    offset += 2 + length;
  }
}

function assertTiffSize(bytes, width, height) {
  assert.ok(bytes.length > 8, "TIFF header present");
  const little = bytes[0] === 0x49 && bytes[1] === 0x49;
  const big = bytes[0] === 0x4d && bytes[1] === 0x4d;
  assert.ok(little || big, "TIFF byte-order magic");
  const u16 = (at) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
  const u32 = (at) => (little ? bytes.readUInt32LE(at) : bytes.readUInt32BE(at));
  assert.equal(u16(2), 42, "TIFF version magic");
  const ifd = u32(4);
  assert.ok(ifd + 2 <= bytes.length, "TIFF IFD in bounds");
  const count = u16(ifd);
  let seenW = null;
  let seenH = null;
  for (let i = 0; i < count; i += 1) {
    const entry = ifd + 2 + i * 12;
    assert.ok(entry + 12 <= bytes.length, "TIFF IFD entry in bounds");
    const tag = u16(entry);
    const type = u16(entry + 2);
    const n = u32(entry + 4);
    let value;
    if (type === 3 && n === 1) value = u16(entry + 8);
    else if (type === 4 && n === 1) value = u32(entry + 8);
    else continue;
    if (tag === 256) seenW = value;
    if (tag === 257) seenH = value;
  }
  assert.equal(seenW, width, "TIFF width");
  assert.equal(seenH, height, "TIFF height");
}

// ---------------------------------------------------------------------------
// Shared save flow: submit -> destination request -> optional encoder radio
// -> choose-output grant -> exactly one terminal section.
// ---------------------------------------------------------------------------

async function saveFlow(driver, { input, formatRadio = null }) {
  await submitUrl(driver, input);
  const discovery = await waitFor(driver, (s) => s.jobSection, 60000, "job section");
  assert.ok((discovery.step ?? "").length > 0, "a step is shown while discovering");
  await waitFor(
    driver,
    (s) => (s.recoveryButtons ?? []).some((b) => b.includes("Choose output")),
    60000,
    "destination request",
  );
  assert.equal((await snapshot(driver)).recoveryTitle, "Choose where to save");
  if (formatRadio !== null) {
    const selected = await selectOutputFormat(driver, formatRadio);
    assert.equal(selected, "checked", `encoder radio "${formatRadio}" exists and checks`);
  }
  const samples = [];
  assert.equal(await clickChooseOutput(driver), true, "choose-output action clicked");
  const start = Date.now();
  for (;;) {
    const snap = await snapshot(driver);
    sampleCounts(samples, snap);
    if (snap.completed || snap.error) {
      assertCountsMonotonic(samples);
      // Exactly one terminal at UI level: never both sections at once.
      assert.ok(!(snap.completed && snap.error), "exactly one terminal section");
      return snap;
    }
    if (Date.now() - start > 120000) {
      assert.fail(`save never reached a terminal: ${JSON.stringify(snap)}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

// ---------------------------------------------------------------------------
// Lifecycle (import-safe: reuse a preflight set by a future importer).
// ---------------------------------------------------------------------------

let shared = null;
let sharedOwner = false;

before(async () => {
  if (globalThis.__dezoomifyWindowE2eShared) {
    shared = globalThis.__dezoomifyWindowE2eShared;
  } else {
    shared = await preflight();
    sharedOwner = true;
    globalThis.__dezoomifyWindowE2eShared = shared;
  }
});

after(async () => {
  if (sharedOwner && shared) shared.frontend.close();
  if (sharedOwner) globalThis.__dezoomifyWindowE2eShared = null;
  shared = null;
  sharedOwner = false;
});

// ---------------------------------------------------------------------------
// PASS: deepzoom (PNG): the reference byte-exact window save.
// ---------------------------------------------------------------------------

test("formats: deepzoom saves a byte-exact PNG", { timeout: 180000 }, async () => {
  const raw = readFileSync(
    path.join(SCENARIOS_DIR, "native/cli-dzi/expected/result.json"),
    "utf8",
  );
  const hash = JSON.parse(raw).outputHash;
  assert.match(hash, /^sha256:[0-9a-f]{64}$/, "golden pins a real digest");
  assert.equal(hash, goldenOutputHash(SCENARIOS_DIR), "window golden matches the pinned scenario golden");
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "format-deepzoom.png",
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      const terminal = await saveFlow(driver, { input });
      assert.equal(terminal.error, false, "no error section on the deepzoom save");
      assert.match(terminal.completedSummary ?? "", /512 by 512/, "completed summary names the geometry");
      assert.ok(existsSync(fixedDest), "output written to the fixed destination");
      assertSavedPyramid(readFileSync(fixedDest), hash);
      const text = redactedReport("format", {
        format: "deepzoom",
        scenario: "native/cli-dzi",
        origin: redactedOriginOnly(input),
        save: { width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT, outputHash: hash },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`formats deepzoom/png: 512x512 ${hash} (seed ${SEED})`);
    },
  });
});

// ---------------------------------------------------------------------------
// PASS: deepzoom (JPEG encoder path).
// ---------------------------------------------------------------------------

test("formats: deepzoom saves a byte-exact JPEG", { timeout: 180000 }, async () => {
  assert.match(EXPECTED_JPEG_HASH, /^sha256:[0-9a-f]{64}$/, "JPEG golden pins a real digest");
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "format-deepzoom.jpg",
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      const terminal = await saveFlow(driver, { input, formatRadio: "jpeg" });
      assert.equal(terminal.error, false, "no error section on the JPEG save");
      assert.ok(existsSync(fixedDest), "output written to the fixed destination");
      const bytes = readFileSync(fixedDest);
      assertJpegSize(bytes, EXPECTED_WIDTH, EXPECTED_HEIGHT);
      assert.equal(sha256Hex(bytes), EXPECTED_JPEG_HASH, "saved JPEG bytes pin the golden");
      const text = redactedReport("format", {
        format: "deepzoom",
        encoder: "jpeg",
        scenario: "native/cli-dzi",
        origin: redactedOriginOnly(input),
        save: { width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT, outputHash: EXPECTED_JPEG_HASH },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`formats deepzoom/jpeg: 512x512 ${EXPECTED_JPEG_HASH} (seed ${SEED})`);
    },
  });
});

// ---------------------------------------------------------------------------
// PASS: deepzoom (TIFF encoder path).
// ---------------------------------------------------------------------------

test("formats: deepzoom saves a byte-exact TIFF", { timeout: 180000 }, async () => {
  assert.match(EXPECTED_TIFF_HASH, /^sha256:[0-9a-f]{64}$/, "TIFF golden pins a real digest");
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "format-deepzoom.tif",
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      const terminal = await saveFlow(driver, { input, formatRadio: "tiff" });
      assert.equal(terminal.error, false, "no error section on the TIFF save");
      assert.ok(existsSync(fixedDest), "output written to the fixed destination");
      const bytes = readFileSync(fixedDest);
      assertTiffSize(bytes, EXPECTED_WIDTH, EXPECTED_HEIGHT);
      assert.equal(sha256Hex(bytes), EXPECTED_TIFF_HASH, "saved TIFF bytes pin the golden");
      const text = redactedReport("format", {
        format: "deepzoom",
        encoder: "tiff",
        scenario: "native/cli-dzi",
        origin: redactedOriginOnly(input),
        save: { width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT, outputHash: EXPECTED_TIFF_HASH },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`formats deepzoom/tiff: 512x512 ${EXPECTED_TIFF_HASH} (seed ${SEED})`);
    },
  });
});

// ---------------------------------------------------------------------------
// PASS: generic (probed X/Y template): byte-exact PNG, same quadrant tiles.
// ---------------------------------------------------------------------------

test("formats: generic template saves a byte-exact PNG", { timeout: 180000 }, async () => {
  const hash = probeGridGoldenHash();
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "format-generic.png",
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_PROBE_TEMPLATE);
      const terminal = await saveFlow(driver, { input });
      assert.equal(terminal.error, false, "no error section on the generic save");
      assert.match(terminal.completedSummary ?? "", /512 by 512/, "completed summary names the geometry");
      assert.ok(existsSync(fixedDest), "output written to the fixed destination");
      assertSavedPyramid(readFileSync(fixedDest), hash);
      const text = redactedReport("format", {
        format: "generic",
        scenario: "native/cli-probe-grid",
        origin: redactedOriginOnly(input),
        save: { width: EXPECTED_WIDTH, height: EXPECTED_HEIGHT, outputHash: hash },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`formats generic/png: 512x512 ${hash} (seed ${SEED})`);
    },
  });
});

// ---------------------------------------------------------------------------
// SKIP: every other format has no deterministic local tile chain servable
// on loopback (genuine search per skip; CLI evidence against the same
// fixture server and the same native pipeline the window shell drives).
// ---------------------------------------------------------------------------

// URL-shape discovery gates cannot see the inner URL through the gateway
// submit (`{origin}/fetch?url=<inner>` presents path `/fetch` plus a query
// to every UrlSuffix/UrlPredicate): the CLI reports "no discovery candidate
// accepted the input" for each of these.
test("formats: custom has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: custom discovery needs a served tiles.yaml input and no routes.json serves one (the rs-core tiles.yaml payload library is unrouted); CLI: no discovery candidate accepted the input" }, async () => {});
test("formats: google_arts_and_culture has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: the asset page is servable via the gateway but tile-info and tile URLs are absolute (fixtures.test / artsandculture.google.com) and fail direct loopback fetch; CLI: google_arts_and_culture: host fetch failed (discovery.failed)" }, async () => {});
test("formats: zoomify has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: the UrlSuffix(ImageProperties.xml) gate cannot match the gateway outer path /fetch, and no TileGroup tile routes are served; CLI: zoomify: resource did not match any discovery route" }, async () => {});
test("formats: xlimage has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: the .imgi URL-shape gate cannot match through the gateway outer path, and no xlimage tile routes are served; CLI: no discovery candidate accepted the input" }, async () => {});
test("formats: fsi has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: the server.txt URL gate cannot match through the gateway outer path, and no FSI tile routes are served; CLI: no discovery candidate accepted the input" }, async () => {});
test("formats: vls has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: the VLS viewer-URL gate cannot match through the gateway outer path, and no VLS tile routes are served; CLI: no discovery candidate accepted the input" }, async () => {});
test("formats: arcgis has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: the ArcGIS MapServer URL gate cannot match through the gateway outer path, and no ArcGIS tile routes are served (site-adapters is metadata-only); CLI: arcgis: not an ArcGIS MapServer URL" }, async () => {});

// Discovery succeeds through the gateway but every tile URL is
// absolute/unserved on loopback, so the pipeline keeps a blank 0-tile
// partial: no format-meaningful golden exists to assert against.
test("formats: iiif has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: info.json discovers, but tile URLs derive from the absolute info.json id ({{origin}}/iiif/v3 hits the fixture static 404) and no IIIF tile routes are served; CLI keeps a blank 0-tile partial" }, async () => {});
test("formats: krpano has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: pano.xml discovers, but krpano tile URLs are unserved on loopback; CLI keeps a blank 0-tile partial" }, async () => {});
test("formats: iipimage has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: ?FIF= discovers through the gateway query, but IIP tile query derivations are unserved on loopback; CLI keeps a blank 0-tile partial" }, async () => {});
test("formats: topviewer has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: data.json discovers, but TopViewer detail/media tile URLs are unserved on loopback; CLI keeps a blank 0-tile partial" }, async () => {});
test("formats: lizardtech has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: calcrgn discovers, but LizardTech tile URLs are unserved on loopback; CLI keeps a blank 0-tile partial (1024x1024)" }, async () => {});
test("formats: hungaricana has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: the imagesize document discovers, but Hungaricana file URLs are unserved on loopback; CLI keeps a blank 0-tile partial" }, async () => {});
test("formats: wmts has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: WMTSCapabilities discovers, but WMTS tile URLs are unserved on loopback; CLI keeps a blank 0-tile partial (2816x2816)" }, async () => {});
test("formats: pnav has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: image.json discovers, but the pnav tile URL is unserved on loopback; CLI keeps a blank 0-tile partial" }, async () => {});
test("formats: bulk_text has no servable local fixture", { timeout: 60000, skip: "no deterministic local fixture: no routes.json serves a URL-list text input, and the deferred-follow path needs loopback:// responders the gateway cannot express; CLI: not a bulk URL-list file" }, async () => {});

// Encoder matrix gap: the backend accepts format=iiif-dir (see
// testdata/scenarios/desktop/basic-iiif-dir), but the window UI in this
// tree exposes only png/jpeg/tiff radios
// (#dz-output-format-group input[name="dz-output-format"]), so no DOM path
// can request an extensionless iiif-dir destination through the real
// window. Owned by whoever wires the remaining encoder radios.
test("formats: iiif-dir destination has no UI selector in this tree", { timeout: 60000, skip: "no DOM path: the window format selector offers only png/jpeg/tiff radios, so format=iiif-dir cannot be requested through the real window (backend + pipeline coverage lives in desktop/basic-iiif-dir)" }, async () => {});

// Redaction precedent guard for the reports above: origins only, never
// credentials, full URLs, or absolute profile paths.
test("formats: reports stay redacted", { timeout: 60000 }, async () => {
  const text = redactedReport("format-probe", {
    format: "deepzoom",
    origin: "http://127.0.0.1:1",
  });
  assert.ok(text.includes(`"seed": ${SEED}`), "seed marker present");
  assertReportRedacted(text);
});

export { SEL as FORMAT_SEL };
