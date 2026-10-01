import assert from "node:assert/strict";
import test from "node:test";
import { renderSaveGuidance } from "../packages/shared-ui/src/components.ts";
import { canRetry, detailOf, plainMessageFor } from "../packages/shared-ui/src/failure.ts";
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
    kind: "http-error",
    status: 403,
    request: "https://example.test/tile?signature=exact",
    transport: "native",
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

test("failure wording keeps diagnostic facts out of the headline", () => {
  const facts = {
    kind: "discovery-failed",
    detail: " - iiif: Invalid IIIF info.json file\n - zoomify: HTTP 404 fetching this address",
    cause: {
      kind: "http-error",
      status: 403,
      request: "https://example.test/info.json?signed=exact",
      transport: "browser-session",
      retry_after_ms: 7000,
      preview: "server refusal",
      detail: "the site refused this file",
    },
  };
  // The typed cause drives the wording; the per-format evidence stays in
  // the collapsible detail and never enters the headline.
  assert.match(plainMessageFor(facts, "example.test"), /refused to share this file \(HTTP 403\)/i);
  assert.ok(!plainMessageFor(facts, "example.test").includes("iiif"));
  assert.match(
    plainMessageFor({ kind: "discovery-failed", detail: facts.detail }, "example.test"),
    /No zoomable image/,
  );
  assert.match(detailOf(facts), /iiif/);
  assert.match(detailOf(facts), /the site refused this file/);
  // The typed facts survive unchanged: no message is stored or parsed.
  assert.deepEqual(facts.cause.status, 403);
  assert.deepEqual(facts.cause.retry_after_ms, 7000);
});

test("rate-limit failures render the transport-specific explainer", () => {
  assert.match(
    plainMessageFor({ kind: "rate-limited", transport: "metadata-proxy" }, "example.test"),
    /our server/i,
  );
  assert.match(
    plainMessageFor({ kind: "rate-limited", transport: "direct" }, "example.test"),
    /your own connection/i,
  );
  assert.match(
    plainMessageFor({ kind: "http-error", status: 429, transport: "direct" }, "example.test"),
    /your own connection/i,
  );
});

test("the retry verdict is read from the boundary's hint and never recomputed", () => {
  assert.equal(canRetry({ kind: "timeout", transport: "native", retryable: true }), true);
  assert.equal(
    canRetry({ kind: "http-error", status: 503, transport: "native", retryable: false }),
    false,
  );
  // Without the hint (a boundary that could not classify the error), retry
  // fails closed.
  assert.equal(canRetry({ kind: "http-error", status: 503, transport: "native" }), false);
  assert.equal(canRetry({ kind: "processing-failed" }), false);
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
  for (const kind of ["plan-invalid", "output-unavailable"]) {
    assert.match(plainMessageFor({ kind }, "example.test"), /desktop app/i, kind);
  }
});
