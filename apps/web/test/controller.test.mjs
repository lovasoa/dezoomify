import test from "node:test";
import assert from "node:assert/strict";
import { createController, renderAppChoice } from "../../../packages/shared-ui/src/controller.ts";
import {
  renderTransportLabel,
  renderSaveGuidance,
  renderErrorSummary,
  renderProgress,
} from "../../../packages/shared-ui/src/components.ts";
import fs from "node:fs";
import path from "node:path";

test("controller walks full happy path", () => {
  const c = createController("s1");
  assert.equal(c.getState().status, "idle");
  let seq = 0;
  const next = (kind, extra = {}) => ({ seq: ++seq, sessionId: "s1", kind, ...extra });
  assert.ok(c.dispatch(next("start-discovery")));
  assert.ok(c.dispatch(next("images-found", { imageCount: 3 })));
  assert.equal(c.getState().status, "choosing-image");
  assert.ok(c.dispatch(next("image-chosen")));
  assert.ok(c.dispatch(next("level-chosen")));
  assert.ok(c.dispatch(next("preflight-ok", { transport: "direct" })));
  assert.equal(c.getState().status, "downloading");
  assert.ok(c.dispatch(next("save-start")));
  assert.ok(c.dispatch(next("save-done")));
  assert.equal(c.getState().status, "completed");
});

test("controller display-only branch + failed stores structured error", () => {
  const c = createController("s9");
  let seq = 0;
  const next = (kind, extra = {}) => ({ seq: ++seq, sessionId: "s9", kind, ...extra });
  c.dispatch(next("start-discovery"));
  c.dispatch(next("images-found"));
  c.dispatch(next("image-chosen"));
  c.dispatch(next("level-chosen"));
  c.dispatch(next("preflight-display-only"));
  assert.equal(c.getState().status, "display-only");
  c.reset("s10");
  seq = 0;
  c.dispatch({ seq: ++seq, sessionId: "s10", kind: "start-discovery" });
  c.dispatch({ seq: ++seq, sessionId: "s10", kind: "images-found" });
  const err = { code: "TRANSPORT_NETWORK_ERROR", category: "transport", retryable: true, message: "Could not open the picture." };
  // Need to go through a state that allows fail: discovering allows fail.
  const c2 = createController("sx");
  c2.dispatch({ seq: 1, sessionId: "sx", kind: "start-discovery" });
  assert.ok(c2.dispatch({ seq: 2, sessionId: "sx", kind: "fail", error: err }));
  assert.equal(c2.getState().status, "failed");
  assert.deepEqual(c2.getState().error, err);
});

test("stale seq and foreign session ignored; illegal transition rejected", () => {
  const c = createController("s1");
  assert.ok(c.dispatch({ seq: 1, sessionId: "s1", kind: "start-discovery" }));
  assert.equal(c.dispatch({ seq: 1, sessionId: "s1", kind: "images-found" }), false);
  assert.equal(c.dispatch({ seq: 0, sessionId: "s1", kind: "images-found" }), false);
  assert.equal(c.dispatch({ seq: 2, sessionId: "other", kind: "images-found" }), false);
  // Illegal: save-done from discovering.
  assert.equal(c.dispatch({ seq: 2, sessionId: "s1", kind: "save-done" }), false);
  // Cancel then reset.
  assert.ok(c.dispatch({ seq: 2, sessionId: "s1", kind: "cancel" }));
  assert.equal(c.getState().status, "cancelled");
  c.reset();
  assert.equal(c.getState().status, "idle");
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
  assert.ok(renderSaveGuidance(false).includes("display only"));
  assert.ok(renderSaveGuidance(true).includes("save"));
  const summary = renderErrorSummary({ code: "X", category: "c", retryable: true, message: "The picture could not be opened." });
  assert.ok(summary.includes("try again"));
  assert.ok(renderProgress(1, 4).includes("1 of 4"));
});

test("website scenario transcripts have fixed shape", () => {
  const root = new URL("../../../", import.meta.url);
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
  void path;
});
