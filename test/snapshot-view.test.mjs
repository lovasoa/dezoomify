import assert from "node:assert/strict";
import test from "node:test";
import { presentIdle, presentSnapshot } from "../packages/shared-ui/src/snapshot-view.ts";

// Authoritative Snapshot builder: tests render the latest snapshot
// directly, never a folded event walk.
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

test("idle presentation has no job state", () => {
  const view = presentIdle();
  assert.equal(view.phase, "idle");
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

test("partial-decision snapshots keep progress and pause state", () => {
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
    output: {
      canvas: undefined,
      format: "png",
      complete: false,
      missing: [],
      disposition: "display-only",
    },
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
});

test("kept partials name their gaps", () => {
  const snap = dto({
    revision: 8,
    lifecycle: "PartiallyCompleted",
    progress: { completed: 9, total: 12 },
    terminal: { type: "partial-completed", missing: [10, 11, 12] },
    output: {
      canvas: undefined,
      format: "png",
      complete: false,
      missing: [10, 11, 12],
      disposition: undefined,
    },
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
