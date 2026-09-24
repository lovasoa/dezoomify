import assert from "node:assert/strict";
import test from "node:test";
import { renderTransportLabel } from "@dezoomify/app-model";
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
import { presentSnapshot } from "../packages/shared-ui/src/snapshot-view.ts";

// Authoritative Snapshot builder: the latest snapshot renders
// directly, even when intermediate notifications were skipped.
function dto(overrides = {}) {
  return {
    revision: 0,
    lifecycle: "Discovering",
    paused: false,
    progress: { completed: 0, total: undefined },
    selection: {
      image: undefined,
      level: undefined,
      level_count: 0,
      catalog: undefined,
      deferred: [],
    },
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

test("components render transport/save/error/progress plainly", () => {
  assert.equal(renderTransportLabel("direct"), "Direct from your browser");
  assert.equal(renderTransportLabel("metadata-proxy"), "Metadata proxy");
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

test("a completed job with engine display-only disposition presents preview", () => {
  const snap = dto({
    revision: 7,
    lifecycle: "Completed",
    progress: { completed: 4, total: 4 },
    terminal: { type: "completed" },
    output: {
      canvas: { width: 512, height: 512 },
      format: "png",
      complete: true,
      missing: [],
      disposition: "display-only",
    },
  });
  const view = presentSnapshot(snap, "browser-session");
  assert.equal(view.phase, "display-only");
  assert.equal(view.displayOnly, true);
  assert.equal(view.headlineKey, "view.display.title");
});

const RESOLUTION_CATALOG = {
  entries: [
    {
      kind: "image",
      title: "Mural",
      format: "zoomify",
      sourceKind: "tile",
      levels: [
        { label: "0", size: { width: 10000, height: 5000 } },
        { label: "1", size: { width: 20000, height: 10000 } },
        { label: "2", size: { width: 40000, height: 20000 } },
      ],
    },
  ],
};

test("a smaller known level than the maximum presents the resolution choice", () => {
  const selection = {
    image: 0,
    level: 1,
    level_count: 3,
    catalog: RESOLUTION_CATALOG,
    deferred: [],
  };
  const live = presentSnapshot(
    dto({
      revision: 2,
      lifecycle: "AcquiringTiles",
      progress: { completed: 1, total: 4 },
      selection,
    }),
    "direct",
  );
  assert.deepEqual(live.resolution, {
    selected: { width: 20000, height: 10000 },
    maximum: { width: 40000, height: 20000 },
  });
  // The choice survives completion so the offer can stay on screen.
  const done = presentSnapshot(
    dto({
      revision: 3,
      lifecycle: "Completed",
      progress: { completed: 4, total: 4 },
      selection,
      terminal: { type: "completed" },
    }),
    "direct",
  );
  assert.deepEqual(done.resolution, live.resolution);
});

test("no resolution choice at the maximum level or without declared sizes", () => {
  const atMax = presentSnapshot(
    dto({
      revision: 4,
      lifecycle: "AcquiringTiles",
      progress: { completed: 0, total: 4 },
      selection: { image: 0, level: 2, level_count: 3, catalog: RESOLUTION_CATALOG, deferred: [] },
    }),
    "direct",
  );
  assert.equal(atMax.resolution, undefined);
  const undeclared = presentSnapshot(
    dto({
      revision: 5,
      lifecycle: "AcquiringTiles",
      selection: {
        image: 0,
        level: 1,
        level_count: 2,
        catalog: { entries: [{ kind: "image", levels: [{ label: "0" }, { label: "1" }] }] },
        deferred: [],
      },
    }),
    "direct",
  );
  assert.equal(undeclared.resolution, undefined);
  const noSelection = presentSnapshot(dto({ revision: 6, lifecycle: "Discovering" }), "direct");
  assert.equal(noSelection.resolution, undefined);
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
