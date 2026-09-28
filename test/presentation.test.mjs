import assert from "node:assert/strict";
import test from "node:test";
import {
  renderAppChoice,
  renderErrorSummary,
  renderProgress,
  renderSaveGuidance,
} from "../packages/shared-ui/src/components.ts";
import {
  categoryFor,
  describeFailure,
  phaseFor,
  plainMessageFor,
} from "../packages/shared-ui/src/failure.ts";
import {
  presentFailure,
  presentIdle,
  presentOutput,
  presentProgress,
  presentStatus,
} from "../packages/shared-ui/src/presentation.ts";

const progress = (extra = {}) => ({ phase: "acquisition", completed: 2, total: 4, ...extra });
const output = (extra = {}) => ({
  canvas: { width: 512, height: 512 },
  format: "png",
  complete: true,
  missing: [],
  disposition: "browser-save-ready",
  ...extra,
});

test("idle, discovery, pause, and cancellation retain their controls", () => {
  const idle = presentIdle();
  assert.equal(idle.phase, "idle");
  assert.equal(idle.canCancel, false);
  const live = presentProgress(progress({ phase: "discovery" }), "direct", { paused: true });
  assert.equal(live.headlineKey, "view.step.discovering");
  assert.equal(live.canCancel, true);
  assert.equal(live.canReset, false);
  assert.equal(live.paused, true);
  assert.equal(live.transportLabel, "Direct from your browser");
  assert.equal(presentStatus("cancelled").headlineKey, "view.cancel.title");
});

test("completed output preserves acquired progress", () => {
  const view = presentOutput(output(), progress({ completed: 1 }), "direct");
  assert.equal(view.phase, "completed");
  assert.equal(view.terminal.kind, "completed");
  assert.deepEqual(view.progress, { current: 1, total: 4 });
});

test("ordinary image display keeps progress during work and presents its final preview", () => {
  const live = presentProgress(progress(), "browser-session", { displayOnly: true });
  assert.equal(live.phase, "job");
  assert.equal(live.headlineKey, "view.step.downloading");
  assert.equal(live.progress.current, 2);
  const done = presentOutput(
    output({ disposition: "display-only" }),
    progress(),
    "browser-session",
  );
  assert.equal(done.phase, "display-only");
  assert.equal(done.displayOnly, true);
  assert.equal(done.headlineKey, "view.display.title");
});

test("results render without catalog or progress and partials identify gaps", () => {
  const done = presentOutput(output(), undefined, "native");
  assert.equal(done.canReset, true);
  assert.equal(done.canCancel, false);
  const partial = presentOutput(
    output({ complete: false, missing: [10, 11, 12] }),
    undefined,
    "native",
  );
  assert.equal(partial.partial, true);
  assert.equal(partial.terminal.output.failedTiles, 3);
  assert.equal(partial.terminal.gapCount, 3);
  assert.match(partial.terminal.gapShown, /10/);
  const failed = presentFailure(
    { code: "tile.failed", message: "Three tiles failed.", category: "transport", retryable: true },
    "native",
  );
  assert.equal(failed.phase, "failed");
  assert.equal(failed.terminal.error.code, "tile.failed");
  assert.equal(failed.terminal.output, undefined);
});

test("app-choice guidance is plain language with no jargon", () => {
  const banned = [
    "cors",
    "origin-clean",
    "originclean",
    "wasm",
    "ssrf",
    "taint",
    "metadata proxy",
    "deep link",
    "dezoomer",
  ];
  for (const cap of [
    {},
    { extensionAvailable: true },
    { nativeAvailable: true },
    { browserCanSave: false },
  ]) {
    const text = renderAppChoice(cap).toLowerCase();
    for (const b of banned) {
      assert.ok(!text.includes(b), `guidance contains jargon ${b}: ${text.slice(0, 120)}`);
    }
    assert.ok(text.includes("best next step"));
  }
  const ext = renderAppChoice({ extensionAvailable: true });
  assert.ok(ext.includes("add-on"));
  const nat = renderAppChoice({ nativeAvailable: true });
  assert.ok(nat.includes("desktop app"));
});

test("components render save/error/progress plainly", () => {
  assert.ok(renderSaveGuidance(false).includes("right-click"));
  assert.ok(renderSaveGuidance(false).includes("Save Image As"));
  assert.ok(renderSaveGuidance(true).includes("save this picture"));
  assert.ok(
    renderSaveGuidance(true).includes("Colors may shift"),
    "browser save must warn that the color profile is not preserved",
  );
  const summary = renderErrorSummary({
    code: "X",
    category: "c",
    retryable: true,
    message: "The picture could not be opened.",
  });
  assert.ok(summary.includes("try again"));
  assert.ok(renderProgress(1, 4).includes("1 of 4"));
});

test("failure presenter keeps the diagnostic detail out of the headline", () => {
  const diagnostics =
    " - iiif: Invalid IIIF info.json file: expected value at line 1 column 1\n" +
    " - zoomify: HTTP 404 fetching this address\n" +
    " - 12 other format(s) did not match this page address";
  const error = describeFailure({
    code: "job.discovery-failed",
    detail: diagnostics,
    retryable: false,
    host: "example.test",
  });
  // Prominent message: plain headline, never the block. The source host
  // is host-provided provenance (extras), not table copy.
  assert.equal(error.category, "discovery");
  assert.equal(error.phase, "discovery");
  assert.ok(!error.message.includes("iiif"));
  assert.ok(error.message.includes("No zoomable image"));
  // The diagnostic detail is the only thing in the technical detail.
  assert.equal(error.detail, diagnostics);
});

test("a fetch failure keeps its classified headline", () => {
  const error = describeFailure({
    code: "TRANSPORT_HTTP_ERROR",
    message:
      "The site refused to share this file (HTTP 403). It may block shared servers; the browser extension or the desktop app may still work.",
    retryable: false,
  });
  assert.equal(
    error.message,
    "The site refused to share this file (HTTP 403). It may block shared servers; the browser extension or the desktop app may still work.",
  );
});

test("failure classification derives from codes, never text", () => {
  assert.equal(categoryFor("NO_IMAGE_FOUND"), "discovery");
  assert.equal(categoryFor("INVALID_URL"), "validation");
  assert.equal(categoryFor("OUTPUT_ENCODE_FAILED"), "output");
  assert.equal(categoryFor("PLAN_INVALID"), "internal");
  assert.equal(categoryFor("TILE_FAILED"), "transport");
  assert.equal(categoryFor({ code: "OUTPUT_ENCODE_FAILED" }), "transport");
  assert.equal(categoryFor(null), "transport");
  assert.equal(phaseFor("NO_IMAGE_FOUND"), "discovery");
  assert.equal(phaseFor("OUTPUT_DENIED"), "output");
  assert.equal(phaseFor("TILE_FAILED"), "acquisition");
  assert.equal(phaseFor({ code: "OUTPUT_DENIED" }), "acquisition");
});

test("resolution downgrade remains visible after completion", () => {
  const current = progress({
    selected: { width: 20000, height: 10000 },
    maximum: { width: 40000, height: 20000 },
  });
  const live = presentProgress(current, "direct");
  assert.deepEqual(live.resolution, { selected: current.selected, maximum: current.maximum });
  assert.deepEqual(presentOutput(output(), current, "direct").resolution, live.resolution);
  assert.equal(
    presentProgress(progress({ selected: current.maximum, maximum: current.maximum }), "direct")
      .resolution,
    undefined,
  );
  assert.equal(presentProgress(progress(), "direct").resolution, undefined);
});

test("canvas failure copy names the desktop app for every report", () => {
  for (const code of [
    "PLAN_INVALID",
    "OUTPUT_ALLOCATION_FAILED",
    "OUTPUT_SURFACE_UNAVAILABLE",
    "OUTPUT_ENCODE_FAILED",
  ]) {
    assert.match(plainMessageFor(code, "", "example.test"), /desktop app/i, code);
  }
});
