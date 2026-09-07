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
// Coverage (evidenced by driving the same native pipeline via the CLI
// against the same fixture server; the window runs below re-prove it):
// - PASS (full download, byte-exact): `deepzoom` (PNG/JPEG/TIFF encoder
//   paths), `generic` (PNG, probed X/Y template), plus every other site
//   format via direct loopback fixtures (host 127.0.0.1, no gateway):
//   `custom` (shares the deepzoom PNG golden: same 4 quadrant tiles),
//   `zoomify`, `xlimage`, `iiif`, `krpano`, `iipimage`, `topviewer`
//   (512x512, 4 stub tiles, shared golden), `fsi`, `vls`, `hungaricana`
//   (512x512, 1 stub tile, shared golden), `arcgis` (768x768, 9 tiles),
//   `lizardtech` (1024x1024, 4 tiles), `wmts` (2816x2816, 121 tiles),
//   `pnav` (256x256, 1 tile), `bulk_text` (single-entry deferred follow,
//   shares the iiif stub golden). Direct inputs (`${base}/<path>`) let
//   URL-shape discovery gates see the true path; the fixture server serves
//   scenario routes directly on 127.0.0.1 (host matching ignores the
//   ephemeral port) as well as via `/fetch?url=` and `/fetch/<suffix>?url=`
//   (query-preserving discovery path). Goldens live in
//   `testdata/scenarios/desktop/e2e-formats/expected/<format>.json`.
// - SKIP with proof: `google_arts_and_culture` has no deterministic hermetic
//   input: the core page parser requires protocol-relative `//host/path`
//   with no `:` (no scheme, no `:PORT`), so loopback ephemeral ports can
//   never satisfy it, and the gateway outer breaks `UrlSuffix("=g")`.
//   CLI evidence: direct with port fails "Unable to find the token",
//   gateway fails "host fetch failed".
// - Encoder matrix: PNG (all formats above), JPEG (deepzoom), TIFF
//   (deepzoom) pass. `iiif-dir` (extensionless destination) passes via the
//   E2E destination hook (direct backend `request_destination` with
//   format=iiif-dir, bypassing the UI which offers only png/jpeg/tiff
//   radios): product decision is UI parity deferred (docs already promise
//   extensionless IIIF trees; backend + CLI + lean pipeline cover it in
//   `desktop/basic-iiif-dir`), window shell proven here.
// Adding tile chains needed new `desktop/e2e-formats` scenario payloads
// plus manifest.json entries (all consumers benefit; `cargo xtask fixtures
// verify` stays green).
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
import { goldenOutputHash, sha256Hex, assertSavedPyramid, decodePngSize } from "./png-assert.mjs";

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
// PASS: every other site format via direct loopback fixtures (host
// 127.0.0.1, no gateway). Each case submits a direct `${base}/<path>`
// input, saves PNG through the real window shell, and asserts byte-exact
// sha256 plus dimensions against
// `testdata/scenarios/desktop/e2e-formats/expected/<format>.json` (pinned
// via the CLI against the same fixture server; shared stub goldens are
// documented per case).
// ---------------------------------------------------------------------------

function e2eGolden(name) {
  const raw = readFileSync(
    path.join(SCENARIOS_DIR, `desktop/e2e-formats/expected/${name}.json`),
    "utf8",
  );
  const expected = JSON.parse(raw);
  assert.match(expected.outputHash, /^sha256:[0-9a-f]{64}$/, `${name} golden pins a real digest`);
  return expected;
}

async function directFormatCase({ format, inputPath, fixedName, geometry, scenario = "desktop/e2e-formats" }) {
  const expected = e2eGolden(format);
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName,
    body: async ({ driver, base, fixedDest, work }) => {
      const input = `${base}${inputPath}`;
      const terminal = await saveFlow(driver, { input });
      assert.equal(terminal.error, false, `no error section on the ${format} save`);
      assert.match(terminal.completedSummary ?? "", geometry, "completed summary names the geometry");
      assert.ok(existsSync(fixedDest), "output written to the fixed destination");
      const bytes = readFileSync(fixedDest);
      const { width, height } = decodePngSize(bytes);
      assert.equal(width, expected.imageSize.x, `${format} width`);
      assert.equal(height, expected.imageSize.y, `${format} height`);
      assert.equal(sha256Hex(bytes), expected.outputHash, `saved ${format} bytes pin the golden`);
      const text = redactedReport("format", {
        format,
        scenario,
        origin: redactedOriginOnly(input),
        save: { width, height, outputHash: expected.outputHash },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`formats ${format}/png: ${width}x${height} ${expected.outputHash} (seed ${SEED})`);
    },
  });
}

test("formats: custom saves a byte-exact PNG", { timeout: 180000 }, async () => {
  // Shares the deepzoom PNG golden byte-for-byte: same 4 quadrant tiles in
  // the same 2x2 layout (see native/cli-dzi).
  const expected = e2eGolden("custom");
  assert.equal(expected.outputHash, goldenOutputHash(SCENARIOS_DIR), "custom shares the DZI pyramid golden");
  await directFormatCase({ format: "custom", inputPath: "/custom/tiles.yaml", fixedName: "format-custom.png", geometry: /512 by 512/ });
});

test("formats: zoomify saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "zoomify", inputPath: "/zoomify/ImageProperties.xml", fixedName: "format-zoomify.png", geometry: /512 by 512/ });
});

test("formats: xlimage saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "xlimage", inputPath: "/xl/sample.imgi?cmd=info", fixedName: "format-xlimage.png", geometry: /512 by 512/ });
});

test("formats: fsi saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "fsi", inputPath: "/fsi/server?type=info&source=image&image=image", fixedName: "format-fsi.png", geometry: /512 by 512/ });
});

test("formats: vls saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "vls", inputPath: "/vls/zoom/1", fixedName: "format-vls.png", geometry: /512 by 512/ });
});

test("formats: arcgis saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "arcgis", inputPath: "/arcgis/MapServer", fixedName: "format-arcgis.png", geometry: /768 by 768/ });
});

test("formats: iiif saves a byte-exact PNG", { timeout: 180000 }, async () => {
  // Served by the existing web/core-discovery 127.0.0.1 fixtures
  // (`/fixtures/iiif-v2/info.json` plus the `/iiif/` jpeg-stub tile
  // prefix); golden pinned in desktop/e2e-formats for the window matrix.
  await directFormatCase({ format: "iiif", inputPath: "/fixtures/iiif-v2/info.json", fixedName: "format-iiif.png", geometry: /512 by 512/ });
});

test("formats: krpano saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "krpano", inputPath: "/krpano/pano.xml", fixedName: "format-krpano.png", geometry: /512 by 512/ });
});

test("formats: iipimage saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "iipimage", inputPath: "/iip?FIF=/image.tif", fixedName: "format-iipimage.png", geometry: /512 by 512/ });
});

test("formats: topviewer saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "topviewer", inputPath: "/topviewer/data.json", fixedName: "format-topviewer.png", geometry: /512 by 512/ });
});

test("formats: lizardtech saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "lizardtech", inputPath: "/lizardtech/iserv/calcrgn?cat=test&item=test&wid=500&hei=400", fixedName: "format-lizardtech.png", geometry: /1024 by 1024/ });
});

test("formats: hungaricana saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "hungaricana", inputPath: "/hungaricana/imagesize/sample.ecw", fixedName: "format-hungaricana.png", geometry: /512 by 512/ });
});

test("formats: wmts saves a byte-exact PNG", { timeout: 240000 }, async () => {
  await directFormatCase({ format: "wmts", inputPath: "/wmts/WMTSCapabilities.xml", fixedName: "format-wmts.png", geometry: /2816 by 2816/ });
});

test("formats: pnav saves a byte-exact PNG", { timeout: 180000 }, async () => {
  await directFormatCase({ format: "pnav", inputPath: "/entity/OBJECT/1", fixedName: "format-pnav.png", geometry: /256 by 256/ });
});

test("formats: bulk_text saves a byte-exact PNG", { timeout: 180000 }, async () => {
  // Single-entry deferred follow to the direct IIIF fixture; shares the
  // iiif stub golden (same 4 tiles).
  const expected = e2eGolden("bulk_text");
  assert.equal(expected.outputHash, e2eGolden("iiif").outputHash, "bulk shares the iiif stub golden");
  await directFormatCase({ format: "bulk_text", inputPath: "/bulk/list.txt", fixedName: "format-bulk.png", geometry: /512 by 512/ });
});

// SKIP with proof (not an excuse): google_arts_and_culture has no
// deterministic hermetic input. The core page parser
// (`crates/dezoomify-core/src/google_arts_and_culture/tile_info.rs`
// `PageInfo::from_str`) requires protocol-relative `//host/path` with
// `[^a-zA-Z0-9./_-]` (no scheme, no `:PORT`), so loopback ephemeral ports
// can never satisfy it; the gateway outer breaks `UrlSuffix("=g")` for the
// tile-info follow (outer `/fetch` split drops `=g`) and follow/tile URLs
// are absolute (fixtures.test unresolvable). CLI evidence against the same
// fixture server and native pipeline: direct with port fails "Unable to
// find the token in the page", gateway fails "host fetch failed".
test("formats: google_arts_and_culture has no servable hermetic fixture", { timeout: 60000, skip: "no deterministic hermetic input: core PageInfo regex forbids ':' (no scheme, no :PORT) so direct loopback can never parse, and the gateway outer breaks UrlSuffix(=g); CLI: direct 'Unable to find the token', gateway 'host fetch failed'" }, async () => {});

// Encoder matrix gap closed via the E2E destination hook (no app change):
// the window UI offers only png/jpeg/tiff radios
// (#dz-output-format-group input[name="dz-output-format"]), so no DOM path
// can request format=iiif-dir. The backend accepts it (SUPPORTED_FORMATS
// includes iiif-dir; lean coverage in desktop/basic-iiif-dir). This case
// proves the real window shell backend via direct Tauri invokes (start_job
// plus request_destination with format iiif-dir, granted to the E2E fixed
// destination), bypassing the frontend NATIVE_ENCODERS gate. Product
// decision: UI encoder parity deferred (docs/user/desktop-app.md already
// promises extensionless IIIF trees); no production UI change here.
test("formats: iiif-dir destination saves a byte-exact tile tree", { timeout: 180000 }, async () => {
  const expected = e2eGolden("iiif-dir");
  await runWindowFlow({
    nativeDriverBin: shared.nativeDriverBin,
    fixedName: "format-iiif-dir",
    body: async ({ driver, base, fixedDest, work }) => {
      const input = gatewayInput(base, GATEWAY_DZI);
      const jobId = await driver.executeScript(async (url) => {
        const invoke = globalThis.__TAURI_INTERNALS__.invoke;
        const started = await invoke("start_job", { inputUrl: url, settings: null });
        return started.job;
      }, input);
      assert.match(String(jobId), /^job:/, "window shell started a job");
      const granted = await driver.executeScript(async (job) => {
        const invoke = globalThis.__TAURI_INTERNALS__.invoke;
        return await invoke("request_destination", { job, format: "iiif-dir", suggestedName: "out.iiif" });
      }, jobId);
      assert.equal(granted.outcome, "granted", "iiif-dir destination granted via the E2E hook");
      const { readdirSync, statSync } = await import("node:fs");
      const start = Date.now();
      for (;;) {
        try {
          const entries = readdirSync(fixedDest);
          if (entries.includes("info.json")) break;
        } catch {}
        if (Date.now() - start > 120000) {
          assert.fail(`iiif-dir tree never appeared at ${fixedDest}`);
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      const infoRaw = readFileSync(path.join(fixedDest, "info.json"), "utf8");
      const info = JSON.parse(infoRaw);
      assert.equal(info.width, 512, "iiif-dir width");
      assert.equal(info.height, 512, "iiif-dir height");
      // Tree digest is the concat of sorted file bytes (info.json plus
      // tiles); it pins the golden without trusting it. The digest is
      // sensitive to the fixed destination name (info.json `@id` carries
      // the directory basename), so fixedName stays exactly
      // "format-iiif-dir" to match the pinned golden.
      const { createHash } = await import("node:crypto");
      const files = [];
      const walk = (dir, rel = "") => {
        for (const entry of readdirSync(dir)) {
          const full = path.join(dir, entry);
          const key = rel ? `${rel}/${entry}` : entry;
          if (statSync(full).isDirectory()) walk(full, key);
          else files.push(key);
        }
      };
      walk(fixedDest);
      files.sort();
      const hash = createHash("sha256");
      for (const key of files) {
        hash.update(readFileSync(path.join(fixedDest, key)));
      }
      const digest = `sha256:${hash.digest("hex")}`;
      // Note: the CLI tree digest covers info.json plus tiles; the window
      // tree must match it byte-for-byte.
      assert.equal(digest, expected.outputHash, "iiif-dir tree pins the golden");
      const text = redactedReport("format", {
        format: "iiif-dir",
        scenario: "desktop/e2e-formats",
        origin: redactedOriginOnly(input),
        save: { width: 512, height: 512, outputHash: expected.outputHash },
      });
      assert.ok(!text.includes(work), "no absolute profile paths in the report");
      console.log(`formats iiif-dir/tree: 512x512 ${expected.outputHash} (seed ${SEED})`);
    },
  });
});

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
