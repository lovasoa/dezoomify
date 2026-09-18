import test from "node:test";
import assert from "node:assert/strict";
import { applyJobEvent, initialSnapshot } from "../packages/app-model/src/index.ts";
import { presentIdle, presentSnapshot } from "../packages/shared-ui/src/snapshot-view.ts";

function run(jobId, events) {
  let now = 0;
  let snap = initialSnapshot(jobId, ++now);
  for (const event of events) snap = applyJobEvent(snap, event, ++now);
  return snap;
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
  const snap = run("job:1", [{ type: "job-state", state: "Discovering" }]);
  const view = presentSnapshot(snap, "direct");
  assert.equal(view.phase, "job");
  assert.equal(view.headlineKey, "view.step.discovering");
  assert.equal(view.transportLabel, "Direct from your browser");
  assert.equal(view.canCancel, true);
  assert.equal(view.canReset, false);
  assert.equal(view.paused, false);
});

test("image selection offers every ready catalog entry", () => {
  const snap = run("job:2", [
    { type: "job-state", state: "AwaitingImageSelection" },
    { type: "catalog", catalog },
  ]);
  const view = presentSnapshot(snap, "metadata-proxy");
  assert.equal(view.phase, "job");
  assert.equal(view.headlineKey, "view.step.choosingImage");
  assert.equal(view.transportLabel, "Metadata proxy");
  assert.equal(view.selection.kind, "image");
  assert.equal(view.selection.options.length, 2);
  assert.equal(view.selection.options[0].title, "Altarpiece");
});

test("level selection follows the chosen image", () => {
  let snap = run("job:3", [
    { type: "job-state", state: "AwaitingImageSelection" },
    { type: "catalog", catalog },
  ]);
  snap = { ...snap, selection: { image: 0, level: null } };
  snap = applyJobEvent(snap, { type: "job-state", state: "AwaitingLevelSelection" }, 99);
  const view = presentSnapshot(snap, null);
  assert.equal(view.selection.kind, "level");
  assert.equal(view.selection.options.length, 2);
  assert.equal(view.selection.options[1].width, 8000);
  assert.equal(view.transportLabel, null);
});

test("pause keeps progress while recovery surfaces actions", () => {
  const snap = run("job:4", [
    { type: "job-state", state: "AcquiringTiles" },
    { type: "progress", acquired: 5, total: 20 },
    { type: "paused" },
    {
      type: "recovery-request",
      generation: 2,
      actions: [{ id: "retry", kind: "retry", scope: "tile", rationale: "transient" }],
    },
  ]);
  const view = presentSnapshot(snap, "native");
  assert.equal(view.paused, true);
  assert.deepEqual(view.progress, { current: 5, total: 20 });
  assert.equal(view.phase, "job");
  assert.equal(view.selection.kind, "recovery");
  assert.equal(view.selection.generation, 2);
});

test("display-only renders without byte access", () => {
  let snap = run("job:5", [
    { type: "job-state", state: "AcquiringTiles" },
    { type: "progress", acquired: 2, total: 8 },
  ]);
  snap = { ...snap, displayOnly: true };
  const view = presentSnapshot(snap, "display-only");
  assert.equal(view.phase, "display-only");
  assert.equal(view.displayOnly, true);
  assert.equal(view.headlineKey, "view.display.title");
  assert.equal(view.transportLabel, "Display only");
});

test("completed terminal renders honestly even without catalog or progress", () => {
  const snap = run("job:6", [{ type: "completed" }]);
  const view = presentSnapshot(snap, "native");
  assert.equal(view.phase, "completed");
  assert.equal(view.partial, false);
  assert.equal(view.canReset, true);
  assert.equal(view.canCancel, false);
  assert.equal(view.terminal.kind, "completed");
  assert.equal(view.selection, null);
});

test("kept partials name their gaps", () => {
  let snap = run("job:7", [
    { type: "job-state", state: "AcquiringTiles" },
    { type: "progress", acquired: 9, total: 12 },
    { type: "partial-completed" },
  ]);
  snap = {
    ...snap,
    output: {
      doneTiles: 9,
      totalTiles: 12,
      failedTiles: 3,
      partial: true,
      format: "png",
      width: 8000,
      height: 6000,
      missingTiles: ["t-10", "t-11", "t-12"],
    },
  };
  const view = presentSnapshot(snap, "native");
  assert.equal(view.phase, "completed");
  assert.equal(view.partial, true);
  assert.equal(view.terminal.output.failedTiles, 3);
  assert.equal(view.terminal.gapCount, 3);
  assert.match(view.terminal.gapShown, /t-10/);
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
  const snap = run("job:8", [{ type: "failed", error }]);
  const view = presentSnapshot(snap, "native");
  assert.equal(view.phase, "failed");
  assert.equal(view.headlineKey, "view.fail.title");
  assert.equal(view.terminal.error.code, "tile.failed");
  assert.equal(view.terminal.output, undefined);
});

test("cancelled renders the cancel copy", () => {
  const snap = run("job:9", [
    { type: "job-state", state: "AcquiringTiles" },
    { type: "cancelled" },
  ]);
  const view = presentSnapshot(snap, null);
  assert.equal(view.phase, "cancelled");
  assert.equal(view.headlineKey, "view.cancel.title");
});
