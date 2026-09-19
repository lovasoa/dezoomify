import test from "node:test";
import assert from "node:assert/strict";
import { presentIdle, presentSnapshot } from "../packages/shared-ui/src/snapshot-view.ts";

// Authoritative EngineSnapshotDto builder: tests render the latest snapshot
// directly, never a folded event walk.
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

const catalog = {
  entries: [
    {
      kind: "image",
      title: "Altarpiece",
      format: "IIIF",
      width: 8000,
      height: 6000,
      sourceKind: "iiif",
      levels: [
        { label: "thumb", width: 800, height: 600, tileWidth: 256, tileHeight: 256 },
        { label: "full", width: 8000, height: 6000, tileWidth: 512, tileHeight: 512 },
      ],
    },
    {
      kind: "image",
      format: "IIIF",
      width: 4000,
      height: 3000,
      sourceKind: "iiif",
      levels: [{ label: "full", width: 4000, height: 3000, tileWidth: 512, tileHeight: 512 }],
    },
  ],
};

test("idle presentation has no job state", () => {
  const view = presentIdle();
  assert.equal(view.phase, "idle");
  assert.equal(view.selection, null);
  assert.equal(view.terminal, null);
  assert.equal(view.canCancel, false);
  assert.equal(view.canReset, false);
});

test("discovery renders a cancellable job step", () => {
  const snap = dto({ revision: 1, lifecycle: "Discovering" });
  const view = presentSnapshot(snap, "direct");
  assert.equal(view.phase, "job");
  assert.equal(view.headlineKey, "view.step.discovering");
  assert.equal(view.transportLabel, "Direct from your browser");
  assert.equal(view.canCancel, true);
  assert.equal(view.canReset, false);
  assert.equal(view.paused, false);
});

test("image selection offers every ready catalog entry", () => {
  const snap = dto({
    revision: 2,
    lifecycle: "AwaitingImageSelection",
    selection: { image: undefined, level: undefined, level_count: 2, catalog, deferred: [] },
  });
  const view = presentSnapshot(snap, "metadata-proxy");
  assert.equal(view.phase, "job");
  assert.equal(view.headlineKey, "view.step.choosingImage");
  assert.equal(view.transportLabel, "Metadata proxy");
  assert.equal(view.selection.kind, "image");
  assert.equal(view.selection.options.length, 2);
  assert.equal(view.selection.options[0].title, "Altarpiece");
});

test("level selection follows the chosen image", () => {
  const snap = dto({
    revision: 3,
    lifecycle: "AwaitingLevelSelection",
    selection: { image: 0, level: undefined, level_count: 2, catalog, deferred: [] },
  });
  const view = presentSnapshot(snap, null);
  assert.equal(view.selection.kind, "level");
  assert.equal(view.selection.options.length, 2);
  assert.equal(view.selection.options[1].width, 8000);
  assert.equal(view.transportLabel, null);
});

test("pause keeps progress while the partial decision names its gaps", () => {
  const snap = dto({
    revision: 4,
    lifecycle: "AwaitingPartialDecision",
    paused: true,
    progress: { completed: 5, total: 20 },
    decision: {
      generation: 2,
      missing: [{ tile: 7, failures: [{ code: "TILE_FAILED", category: "transient" }] }],
    },
  });
  const view = presentSnapshot(snap, "native");
  assert.equal(view.paused, true);
  assert.deepEqual(view.progress, { current: 5, total: 20 });
  assert.equal(view.phase, "job");
  assert.equal(view.selection.kind, "recovery");
  assert.equal(view.selection.generation, 2);
  assert.deepEqual(view.selection.missing, [7]);
});

test("tainted canvas keeps the progress bar while dezooming", () => {
  const snap = dto({
    revision: 5,
    lifecycle: "AcquiringTiles",
    progress: { completed: 2, total: 8 },
  });
  const view = presentSnapshot(snap, "display-only", { displayOnly: true });
  assert.equal(view.phase, "job");
  assert.equal(view.displayOnly, true);
  assert.equal(view.headlineKey, "view.step.downloading");
  assert.deepEqual(view.progress, { current: 2, total: 8 });
  assert.equal(view.transportLabel, "Display only");
});

test("display-only round-trips through output disposition only when finished", () => {
  const snap = dto({
    revision: 6,
    lifecycle: "AcquiringTiles",
    progress: { completed: 2, total: 8 },
    output: { canvas: undefined, format: "png", complete: false, missing: [], disposition: "display-only" },
  });
  const view = presentSnapshot(snap, "display-only");
  assert.equal(view.phase, "job");
  assert.equal(view.displayOnly, true);
});

test("completed terminal renders honestly even without catalog or progress", () => {
  const snap = dto({ revision: 7, lifecycle: "Completed", terminal: { type: "completed" } });
  const view = presentSnapshot(snap, "native");
  assert.equal(view.phase, "completed");
  assert.equal(view.partial, false);
  assert.equal(view.canReset, true);
  assert.equal(view.canCancel, false);
  assert.equal(view.terminal.kind, "completed");
  assert.equal(view.selection, null);
});

test("kept partials name their gaps", () => {
  const snap = dto({
    revision: 8,
    lifecycle: "PartiallyCompleted",
    progress: { completed: 9, total: 12 },
    terminal: { type: "partial-completed", missing: [10, 11, 12] },
    output: { canvas: undefined, format: "png", complete: false, missing: [10, 11, 12], disposition: undefined },
  });
  const view = presentSnapshot(snap, "native");
  assert.equal(view.phase, "completed");
  assert.equal(view.partial, true);
  assert.equal(view.terminal.output.failedTiles, 3);
  assert.equal(view.terminal.gapCount, 3);
  assert.match(view.terminal.gapShown, /10/);
});

test("failed terminal carries the typed error without catalog", () => {
  const error = {
    code: "tile.failed",
    phase: "acquisition",
    retryable: true,
    message: "Three tiles failed.",
    recovery: [],
    transport: "native",
  };
  const snap = dto({ revision: 9, lifecycle: "Failed", terminal: { type: "failed", error } });
  const view = presentSnapshot(snap, "native");
  assert.equal(view.phase, "failed");
  assert.equal(view.headlineKey, "view.fail.title");
  assert.equal(view.terminal.error.code, "tile.failed");
  assert.equal(view.terminal.output, undefined);
});

test("cancelled renders the cancel copy", () => {
  const snap = dto({ revision: 10, lifecycle: "Cancelled", terminal: { type: "cancelled" } });
  const view = presentSnapshot(snap, null);
  assert.equal(view.phase, "cancelled");
  assert.equal(view.headlineKey, "view.cancel.title");
});
