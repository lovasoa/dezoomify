import test from "node:test";
import assert from "node:assert/strict";
import { presentSnapshot } from "../packages/shared-ui/src/snapshot-view.ts";
import { renderAppChoice } from "../packages/shared-ui/src/components.ts";
import {
  categoryFor,
  describeFailure,
  phaseFor,
} from "../packages/shared-ui/src/failure.ts";
import {
  renderTransportLabel,
  renderSaveGuidance,
  renderErrorSummary,
  renderProgress,
} from "../packages/shared-ui/src/components.ts";

// Authoritative EngineSnapshotDto builder: the latest snapshot renders
// directly, even when intermediate notifications were skipped.
function dto(overrides = {}) {
  return {
    revision: 0,
    lifecycle: "Discovering",
    paused: false,
    progress: { completed: 0, total: undefined },
    selection: { image: undefined, level: undefined, level_count: 0, catalog: undefined, deferred: [] },
    decision: undefined,
    terminal: undefined,
    output: undefined,
    ...overrides,
  };
}

test("the latest snapshot presents the terminal exactly once with its progress", () => {
  const snap = dto({
    revision: 9,
    lifecycle: "Completed",
    progress: { completed: 1, total: 4 },
    terminal: { type: "completed" },
  });
  // Intermediate notifications skipped: only the latest snapshot renders.
  const view = presentSnapshot(snap, "direct");
  assert.equal(view.phase, "completed");
  assert.equal(view.terminal.kind, "completed");
  assert.deepEqual(view.progress, { current: 1, total: 4 });
});

test("a tainted canvas keeps progress while dezooming, preview only when done", () => {
  const snap = dto({
    revision: 3,
    lifecycle: "AcquiringTiles",
    progress: { completed: 2, total: 4 },
  });
  const view = presentSnapshot(snap, "browser-session", { displayOnly: true });
  assert.equal(view.phase, "job");
  assert.equal(view.headlineKey, "view.step.downloading");
  assert.equal(view.progress.current, 2);
  const taintedTerminal = presentSnapshot(
    dto({ ...snap, terminal: { type: "completed" } }),
    "browser-session",
    { displayOnly: true },
  );
  assert.equal(taintedTerminal.phase, "completed");
  assert.equal(taintedTerminal.displayOnly, false, "terminals render their own phase");
});

test("app-choice guidance is plain language with no jargon", () => {
  const banned = ["cors", "origin-clean", "originclean", "wasm", "ssrf", "taint", "metadata proxy", "deep link", "dezoomer"];
  for (const cap of [{}, { extensionAvailable: true }, { nativeAvailable: true }, { browserCanSave: false }]) {
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

test("components render transport/save/error/progress plainly", () => {
  assert.equal(renderTransportLabel("direct"), "Direct from your browser");
  assert.equal(renderTransportLabel("proxy"), "Metadata proxy");
  assert.ok(renderSaveGuidance(false).includes("right-click"));
  assert.ok(renderSaveGuidance(false).includes("Save Image As"));
  assert.ok(renderSaveGuidance(true).includes("save this picture"));
  assert.ok(
    renderSaveGuidance(true).includes("Colors may shift"),
    "browser save must warn that the color profile is not preserved",
  );
  const summary = renderErrorSummary({ code: "X", category: "c", retryable: true, message: "The picture could not be opened." });
  assert.ok(summary.includes("try again"));
  assert.ok(renderProgress(1, 4).includes("1 of 4"));
});

test("failure presenter keeps the engine block out of the headline", () => {
  const engineBlock =
    " - iiif: Invalid IIIF info.json file: expected value at line 1 column 1\n" +
    " - zoomify: HTTP 404 fetching this address\n" +
    " - 12 other format(s) did not match this page address";
  const error = describeFailure({
    code: "job.discovery-failed",
    engineDetail: engineBlock,
    retryable: false,
    host: "example.test",
  });
  // Prominent message: plain headline, never the block. The source host
  // is host-provided provenance (extras), not table copy.
  assert.equal(error.category, "discovery");
  assert.equal(error.phase, "discovery");
  assert.ok(!error.message.includes("iiif"));
  assert.ok(error.message.includes("No zoomable image"));
  // The engine block is the only thing in the technical detail.
  assert.equal(error.detail, engineBlock);
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

test("a completed job with engine display-only disposition presents preview", () => {
  const snap = dto({
    revision: 7,
    lifecycle: "Completed",
    progress: { completed: 4, total: 4 },
    terminal: { type: "completed" },
    output: { canvas: { width: 512, height: 512 }, format: "png", complete: true, missing: [], disposition: "display-only" },
  });
  const view = presentSnapshot(snap, "browser-session");
  assert.equal(view.phase, "display-only");
  assert.equal(view.displayOnly, true);
  assert.equal(view.headlineKey, "view.display.title");
});
