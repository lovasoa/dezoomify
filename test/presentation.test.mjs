import assert from "node:assert/strict";
import test from "node:test";
import { renderSaveGuidance } from "../packages/shared-ui/src/components.ts";
import { describeFailure, plainMessageFor } from "../packages/shared-ui/src/failure.ts";
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

test("idle, discovery, pause, and cancellation describe the current work", () => {
  assert.equal(presentIdle().phase, "idle");
  const live = presentProgress(progress({ phase: "discovery" }), { paused: true });
  assert.equal(live.phase, "job");
  assert.equal(live.headlineKey, "view.step.discovering");
  assert.equal(live.paused, true);
  assert.equal(presentStatus("cancelled").headlineKey, "view.cancel.title");
});

test("completed output preserves canonical output facts and acquired progress", () => {
  for (const disposition of [
    "browser-save-ready",
    "browser-save-initiated",
    "native-publication",
  ]) {
    const result = output({ disposition });
    const view = presentOutput(result, progress({ completed: 1 }));
    assert.equal(view.phase, "completed");
    assert.equal(view.output, result);
    assert.deepEqual(view.progress, { current: 1, total: 4 });
  }
});

test("ordinary image display keeps progress during work and presents its final preview", () => {
  const live = presentProgress(progress());
  assert.equal(live.phase, "job");
  assert.equal(live.headlineKey, "view.step.downloading");
  assert.equal(live.progress.current, 2);
  const result = output({ disposition: "display-only" });
  const done = presentOutput(result, progress());
  assert.equal(done.phase, "display-only");
  assert.equal(done.output, result);
  assert.equal(done.headlineKey, "view.display.title");
});

test("results without progress retain partial output and exact missing tile identities", () => {
  const result = output({
    complete: false,
    missing: [10, 11, 12],
    disposition: "native-publication",
  });
  const partial = presentOutput(result, undefined);
  assert.equal(partial.phase, "completed");
  assert.equal(partial.progress, null);
  assert.deepEqual(partial.output, result);
});

test("failed presentation retains the canonical failure", () => {
  const error = {
    code: "TRANSPORT_HTTP_ERROR",
    phase: "acquisition",
    message: "Three tiles failed.",
    retryable: false,
    transport: "native",
    request: "https://example.test/tile?signature=exact",
    resource_kind: "tile",
    http: 403,
  };
  const failed = presentFailure(error);
  assert.equal(failed.phase, "failed");
  assert.equal(failed.error, error);
  assert.equal(failed.output, undefined);
});

test("save guidance explains saving and browser color limitations", () => {
  assert.ok(renderSaveGuidance(false).includes("right-click"));
  assert.ok(renderSaveGuidance(false).includes("Save Image As"));
  assert.ok(renderSaveGuidance(true).includes("save this picture"));
  assert.ok(renderSaveGuidance(true).includes("Colors may shift"));
});

test("failure wording keeps canonical diagnostic facts out of the headline", () => {
  const facts = {
    code: "job.discovery-failed",
    phase: "discovery",
    message: "candidate formats rejected the metadata",
    detail: " - iiif: Invalid IIIF info.json file\n - zoomify: HTTP 404 fetching this address",
    retryable: false,
    transport: "browser-session",
    request: "https://example.test/info.json?signed=exact",
    resource_kind: "metadata",
    blocked_reason: "forbidden",
    http: 403,
    retry_after_ms: 7000,
    preview: "server refusal",
  };
  const error = describeFailure(facts, "example.test");
  assert.ok(error.message.includes("No zoomable image"));
  assert.ok(!error.message.includes("iiif"));
  assert.deepEqual({ ...error, message: facts.message }, facts);
});

test("metadata proxy guidance retains its precise upstream explanation", () => {
  const facts = {
    code: "TRANSPORT_HTTP_ERROR",
    phase: "discovery",
    transport: "metadata-proxy",
    message:
      "The site refused to share this file (HTTP 403). It may block shared servers; the browser extension or the desktop app may still work.",
    retryable: false,
    http: 403,
  };
  assert.deepEqual(describeFailure(facts), { ...facts, detail: facts.message });
});

test("localizing an error preserves its phase and retryability", () => {
  const facts = {
    code: "tile.processing-failed",
    phase: "processing",
    message: "The encrypted tile has an invalid signature.",
    retryable: false,
  };
  const localized = describeFailure(facts, "example.test");
  assert.equal(localized.phase, "processing");
  assert.equal(localized.retryable, false);
  assert.equal(localized.detail, facts.message);
});

test("resolution downgrade remains visible after completion", () => {
  const current = progress({
    selected: { width: 20000, height: 10000 },
    maximum: { width: 40000, height: 20000 },
  });
  const live = presentProgress(current);
  assert.deepEqual(live.resolution, { selected: current.selected, maximum: current.maximum });
  assert.deepEqual(presentOutput(output(), current).resolution, live.resolution);
  assert.equal(
    presentProgress(progress({ selected: current.maximum, maximum: current.maximum })).resolution,
    undefined,
  );
  assert.equal(presentProgress(progress()).resolution, undefined);
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
