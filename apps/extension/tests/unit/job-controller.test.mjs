import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { importTypeScript } from "./ts-source-loader.mjs";

async function loadController() {
  return importTypeScript(new URL("../../src/job/controller.ts", import.meta.url));
}

const { createJobController } = await loadController();

const BINDING = { jobId: "job:test-1", tabId: 7, frameId: 0, documentGeneration: 1 };

function fakeAssembly() {
  const calls = [];
  return {
    calls,
    async acquireTile(tile, placement, bytes) { calls.push(["acquireTile", tile, placement, bytes]); },
    decodePixels(tile) { calls.push(["decodePixels", tile]); },
    openEncoder(format, canvas) { calls.push(["openEncoder", format, canvas]); },
    async finalizeEncoder() { calls.push(["finalizeEncoder"]); },
    publishOutput() { calls.push(["publishOutput"]); },
    release() { calls.push(["release"]); },
  };
}

function harness({ assembly = fakeAssembly(), acquireTile } = {}) {
  if (acquireTile) assembly.acquireTile = acquireTile;
  const sent = [];
  const seen = [];
  const controller = createJobController({
    worker: { postMessage: (message) => sent.push(message) },
    binding: () => BINDING,
    sourceTransport: {
      async fetchResource(request) { seen.push(["source", request]); return { bytes: new Uint8Array([9]) }; },
    },
    extensionTransport: {
      async fetchResource(url, opts) { seen.push(["extension", url, opts]); return { bytes: new Uint8Array([1, 2, 3]) }; },
      cancel() { seen.push(["cancel"]); },
    },
    assembly,
    classifyFailure: (error) => ({ blocked_reason: error?.category ?? "network", code: "extension.network", retryable: true, message: String(error?.message ?? error) }),
    onPermissionRequired: (detail) => seen.push(["permission", detail]),
    onPartialDecision: (recovery) => seen.push(["partial-decision", recovery]),
    onHostFailure: (error) => seen.push(["host-failure", error]),
    onEvent: (event) => seen.push(["event", event.type]),
    onUnsupportedEffect: (envelope) => seen.push(["unsupported", envelope.type]),
  });
  return { controller, sent, seen, assembly };
}

const TILE_EFFECT = {
  kind: "effect",
  type: "acquire-tile",
  effect: "fx:2",
  job: "job:test-1",
  tile: "tile:0",
  placement: { position: { x: 0, y: 0 }, expected_size: { width: 16, height: 16 }, canvas: { width: 32, height: 32 }, processing: "none" },
  request: { id: "req:tile-0", uri: "https://cdn.test/tile_0.jpg", headers: [], purpose: "tile" },
};

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

test("tile acquisition decodes with the placement before the outcome settles", async () => {
  const { controller, sent, seen } = harness();
  controller.handleEngineMessages([TILE_EFFECT]);
  await flush();
  const acquire = seen.find(([kind]) => kind === "extension");
  assert.equal(acquire[1], "https://cdn.test/tile_0.jpg");
  const decoded = sent.find((message) => message.type === "engine.bytes");
  assert.ok(decoded, "bytes outcome was sent");
  void acquire;
});

test("a tile that cannot decode reports a failed acquisition, not a broken output", async () => {
  const assembly = fakeAssembly();
  assembly.acquireTile = async () => { throw new Error("corrupt tile"); };
  const { controller, sent } = harness({ assembly });
  controller.handleEngineMessages([TILE_EFFECT]);
  await flush();
  const failure = sent.find((message) => message.type === "engine.failure");
  assert.ok(failure, "failure outcome was sent");
  assert.equal(failure.requestId, "req:tile-0");
  assert.equal(sent.some((message) => message.type === "engine.bytes"), false);
});

test("metadata requests route through the source transport", async () => {
  const { controller, seen } = harness();
  controller.handleEngineMessages([{
    kind: "effect",
    type: "acquire-resource",
    effect: "fx:0",
    job: "job:test-1",
    request: { id: "req:0", uri: "https://source.test/image.dzi", headers: [], purpose: "metadata" },
  }]);
  await flush();
  assert.equal(seen[0][0], "source");
});

test("lifecycle effects and events run in engine order on one chain", async () => {
  const { controller, assembly, sent } = harness();
  controller.handleEngineMessages([
    { kind: "effect", type: "request-destination", effect: "fx:1", job: "job:test-1", format: "png" },
    { kind: "event", type: "job-state", job: "job:test-1", state: "AwaitingDestination" },
    { kind: "effect", type: "decode-pixels", effect: "fx:6", job: "job:test-1", tile: "tile:0" },
    { kind: "effect", type: "open-encoder", effect: "fx:10", job: "job:test-1", format: "png", canvas: { width: 32, height: 32 } },
    { kind: "effect", type: "finalize-encoder", effect: "fx:11", job: "job:test-1" },
    { kind: "effect", type: "publish-output", effect: "fx:12", job: "job:test-1", output: "out:0" },
    { kind: "effect", type: "release-bytes", effect: "fx:13", job: "job:test-1" },
    { kind: "event", type: "completed", job: "job:test-1", output: "out:0" },
  ]);
  await flush();
  await flush();
  const kinds = assembly.calls.map(([kind]) => kind);
  assert.deepEqual(kinds, ["decodePixels", "openEncoder", "finalizeEncoder", "publishOutput", "release"]);
  assert.deepEqual(assembly.calls[1], ["openEncoder", "png", { width: 32, height: 32 }]);
  const destination = sent.find((message) => message.type === "engine.command");
  assert.deepEqual(destination.command, { type: "destination-response", job: "job:test-1", destination: "dst:0", granted: true });
});

test("partial decisions surface the engine recovery id", async () => {
  const { controller, seen } = harness();
  controller.handleEngineMessages([
    { kind: "effect", type: "request-decision", effect: "fx:9", job: "job:test-1", recovery: "rec:0" },
  ]);
  await flush();
  assert.deepEqual(seen.find(([kind]) => kind === "partial-decision"), ["partial-decision", "rec:0"]);
});

test("host execution failures are terminal: render, cancel, skip the rest", async () => {
  const assembly = fakeAssembly();
  assembly.openEncoder = () => { throw Object.assign(new Error("too large"), { code: "PLAN_INVALID" }); };
  const { controller, sent, seen } = harness({ assembly });
  controller.handleEngineMessages([
    { kind: "effect", type: "open-encoder", effect: "fx:10", job: "job:test-1", format: "png", canvas: { width: 99999, height: 99999 } },
    { kind: "effect", type: "finalize-encoder", effect: "fx:11", job: "job:test-1" },
    { kind: "event", type: "completed", job: "job:test-1", output: "out:0" },
  ]);
  await flush();
  await flush();
  const failure = seen.find(([kind]) => kind === "host-failure");
  assert.ok(failure, "host failure surfaced");
  const cancel = sent.map((message) => message.command?.type).filter(Boolean);
  assert.equal(cancel.includes("cancel"), true);
  // The failed chain never reaches finalize or the completed event.
  assert.equal(assembly.calls.some(([kind]) => kind === "finalizeEncoder"), false);
  assert.equal(seen.some(([kind]) => kind === "event"), false);
});

test("selection commands and partial choices are correlated to the job", async () => {
  const { controller, sent } = harness();
  controller.selectImage("img:1");
  controller.selectLevel("lvl:2");
  controller.choosePartial("rec:0", true);
  const commands = sent.map((message) => message.command);
  assert.deepEqual(commands[0], { type: "select-image", job: "job:test-1", image: "img:1" });
  assert.deepEqual(commands[1], { type: "select-level", job: "job:test-1", level: "lvl:2" });
  assert.deepEqual(commands[2], { type: "partial-choice", job: "job:test-1", recovery: "rec:0", keep_partial: true });
});

test("disposal releases assembly resources exactly once", async () => {
  const { controller, assembly, sent } = harness();
  controller.dispose();
  controller.dispose();
  assert.equal(assembly.calls.filter(([kind]) => kind === "release").length, 1);
  assert.equal(sent.some((message) => message.type === "engine.dispose"), true);
});
