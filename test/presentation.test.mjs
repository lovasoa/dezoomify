import test from "node:test";
import assert from "node:assert/strict";
import { applyJobEvent, initialSnapshot } from "../packages/app-model/src/index.ts";
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
import fs from "node:fs";

function run(jobId, events) {
  let now = 0;
  let snap = initialSnapshot(jobId, ++now);
  for (const event of events) snap = applyJobEvent(snap, event, ++now);
  return snap;
}

test("snapshot fold walks the full happy path", () => {
  const snap = run("job:1", [
    { type: "job-state", state: "Discovering" },
    { type: "catalog", catalog: { entries: [{ kind: "image", format: "IIIF", width: 8, height: 6, sourceKind: "iiif", levels: [{ label: "full", width: 8, height: 6, tileWidth: 4, tileHeight: 4 }] }] } },
    { type: "job-state", state: "AwaitingImageSelection" },
    { type: "job-state", state: "AwaitingLevelSelection" },
    { type: "job-state", state: "Planning" },
    { type: "job-state", state: "AcquiringTiles" },
    { type: "progress", acquired: 1, total: 4 },
    { type: "job-state", state: "Finalizing" },
    { type: "completed" },
  ]);
  // The completed-phase presentation shape is covered in snapshot-view;
  // here the fold itself must terminate exactly once with its progress.
  assert.equal(snap.state, "Completed");
  assert.equal(snap.terminal.kind, "completed");
  assert.equal(snap.acquired, 1);
  assert.equal(snap.total, 4);
});

test("a finished job can still present display-only from the host override", () => {
  const snap = run("job:11", [
    { type: "job-state", state: "AcquiringTiles" },
    { type: "progress", acquired: 2, total: 4 },
  ]);
  const view = presentSnapshot({ ...snap, displayOnly: true }, "browser-session");
  assert.equal(view.phase, "display-only");
  assert.equal(view.progress.current, 2);
  const taintedTerminal = presentSnapshot({ ...snap, displayOnly: true, terminal: { kind: "completed" } }, "browser-session");
  assert.equal(taintedTerminal.phase, "completed");
  assert.equal(taintedTerminal.displayOnly, false, "terminals render their own phase");
});

test("fold is exactly-once terminal and ignores late events by reference", () => {
  let snap = run("job:12", [
    { type: "job-state", state: "AcquiringTiles" },
    { type: "progress", acquired: 2, total: 4 },
    { type: "cancelled" },
  ]);
  assert.equal(snap.terminal.kind, "cancelled");
  assert.equal(snap.state, "Cancelled");
  // Late events after a terminal outcome return the identical snapshot.
  const late = applyJobEvent(snap, { type: "progress", acquired: 4, total: 4 }, 99);
  assert.equal(late, snap, "late event must not move a terminal snapshot");
  const secondTerminal = applyJobEvent(snap, { type: "completed" }, 100);
  assert.equal(secondTerminal, snap, "a second terminal must not overwrite the first");
  // Cancel then reset is a fresh snapshot.
  const fresh = initialSnapshot("job:12", 1);
  assert.equal(fresh.state, "Created");
  assert.equal(fresh.terminal, null);
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
  // Prominent message: plain headline naming the source, never the block.
  assert.equal(error.category, "discovery");
  assert.equal(error.phase, "discovery");
  assert.ok(!error.message.includes("iiif"));
  assert.ok(error.message.includes("example.test"));
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

test("website scenario transcripts have fixed shape", () => {
  const root = new URL("../", import.meta.url);
  const directPath = new URL("testdata/scenarios/website/direct-success/expected/result.json", root);
  const fallbackPath = new URL("testdata/scenarios/website/proxy-fallback/expected/result.json", root);
  const direct = JSON.parse(fs.readFileSync(directPath, "utf8"));
  const fallback = JSON.parse(fs.readFileSync(fallbackPath, "utf8"));
  assert.deepEqual(direct.attempts, ["direct"]);
  assert.equal(direct.transport, "Direct from your browser");
  assert.ok(typeof direct.tilePolicy === "string");
  assert.deepEqual(fallback.attempts, ["direct", "proxy"]);
  assert.equal(fallback.transport, "Metadata proxy");
  assert.ok(fallback.proxyScope === "metadata-only");
});
