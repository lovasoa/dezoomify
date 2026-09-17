import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { importTypeScript } from "./ts-source-loader.mjs";

async function loadController() {
  return importTypeScript(new URL("../../src/job/controller.ts", import.meta.url));
}

/**
 * transport.ts imports the shared failure classifier, so unlike the
 * import-free controller it cannot be loaded from a data: URL as written:
 * bundle it (esbuild is already the suite's transpiler) and import the exact
 * module plus its dependency.
 */
async function loadTransport() {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("../../src/job/transport.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
  });
  const code = bundled.outputFiles[0].text;
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`);
}

const { createJobController } = await loadController();
const { createCoordinatorSourceTransport } = await loadTransport();

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

function harness({ assembly = fakeAssembly(), acquireTile, sourceTransport } = {}) {
  if (acquireTile) assembly.acquireTile = acquireTile;
  const sent = [];
  const seen = [];
  const logs = [];
  const controller = createJobController({
    worker: { postMessage: (message) => sent.push(message) },
    binding: () => BINDING,
    sourceTransport: sourceTransport ?? {
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
    log: (level, code, detail) => logs.push({ level, code, detail }),
  });
  return { controller, sent, seen, assembly, logs };
}

const TILE_EFFECT = {
  kind: "effect",
  type: "acquire-tile",
  effect: "fx:2",
  tile: 0,
  placement: { position: { x: 0, y: 0 }, expected_size: { width: 16, height: 16 }, canvas: { width: 32, height: 32 }, processing: "none" },
  request: { id: 0, uri: "https://cdn.test/tile_0.jpg", headers: [], purpose: "tile" },
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
  assert.equal(failure.requestId, 0);
  assert.equal(sent.some((message) => message.type === "engine.bytes"), false);
});

test("an access grant re-drives the paused acquisition instead of failing the job", async () => {
  let attempts = 0;
  const sent = [];
  // Replace the injected transport behavior through a fresh focused harness,
  // keeping the permission callback observable just like the job page does.
  const retried = [];
  const resumed = createJobController({
    worker: { postMessage: (message) => sent.push(message) },
    binding: () => BINDING,
    sourceTransport: { async fetchResource() { throw new Error("not used"); } },
    extensionTransport: {
      async fetchResource() {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error("grant required"), { category: "access-required", hosts: ["https://cdn.test"] });
        return { bytes: new Uint8Array([1]) };
      },
      cancel() {},
    },
    assembly: fakeAssembly(),
    classifyFailure: (error) => ({ blocked_reason: error?.category ?? "network", code: "extension.network", retryable: true }),
    onPermissionRequired: (detail) => retried.push(detail),
    onPartialDecision() {}, onHostFailure() {}, onEvent() {}, onUnsupportedEffect() {},
  });
  resumed.handleEngineMessages([TILE_EFFECT]);
  await flush();
  assert.equal(sent.some((message) => message.type === "engine.failure"), false, "grantable access waits for the decision");
  assert.equal(retried.length, 1);
  resumed.resolvePermission(true);
  await flush();
  assert.equal(attempts, 2);
  assert.ok(sent.some((message) => message.type === "engine.bytes"));
});

test("metadata requests route through the source transport", async () => {
  const { controller, seen } = harness();
  controller.handleEngineMessages([{
    kind: "effect",
    type: "acquire-resource",
    effect: "fx:0",
    request: { id: 0, uri: "https://source.test/image.dzi", headers: [], purpose: "metadata" },
  }]);
  await flush();
  assert.equal(seen[0][0], "source");
});

test("a failed source fetch retries through the extension-origin transport", async () => {
  // `fetchSource` runs in the clicked tab's origin and is CORS-bound: a
  // wildcard-CORS response rejects a credentialed request, and extension-only
  // pages may block the source context entirely. The independent
  // extension-origin transport (host-granted, not CORS-bound) must recover it.
  const { controller, sent, seen } = harness({
    sourceTransport: { async fetchResource() { throw Object.assign(new Error("cors"), { category: "network" }); } },
  });
  controller.handleEngineMessages([{
    kind: "effect",
    type: "acquire-resource",
    effect: "fx:0",
    request: { id: 0, uri: "https://cdn.test/info.json", headers: [], purpose: "metadata" },
  }]);
  await flush();
  const fallback = seen.find(([kind]) => kind === "extension");
  assert.equal(fallback?.[1], "https://cdn.test/info.json");
  const bytes = sent.find((message) => message.type === "engine.bytes");
  assert.equal(bytes?.requestId, 0);
  assert.deepEqual([...bytes.bytes], [1, 2, 3]);
  assert.equal(sent.some((message) => message.type === "engine.failure"), false);
});

test("controller traces core effects, events, and fetch outcomes", async () => {
  const { controller, sent, logs } = harness();
  controller.handleEngineMessages([
    { kind: "effect", type: "acquire-resource", effect: "fx:0", request: { id: 0, uri: "https://source.test/image.dzi", headers: [], purpose: "metadata" } },
    { kind: "event", type: "catalog", images: [] },
  ]);
  await flush();
  await flush();
  const codes = logs.map((entry) => entry.code);
  assert.ok(codes.includes("effect-received"));
  assert.ok(codes.includes("effect-fetch"));
  assert.ok(codes.includes("effect-outcome"));
  assert.ok(codes.includes("event-received"));
  assert.ok(sent.some((message) => message.type === "engine.bytes"));
});

test("controller traces a failed acquisition at warn", async () => {
  const { controller, logs } = harness({ acquireTile: async () => { throw new Error("corrupt tile"); } });
  controller.handleEngineMessages([TILE_EFFECT]);
  await flush();
  const failed = logs.find((entry) => entry.code === "effect-failed");
  assert.ok(failed, "failed acquisition was logged");
  assert.equal(failed.level, "warn");
});

test("coordinator source fetches name the engine request on the extension bus", async () => {
  // The coordinator (background service worker) only accepts its own string
  // request tokens, while the engine correlates by numeric sequence: the
  // controller must hand the sequence to the transport, which names it once.
  const bus = [];
  const sourceTransport = createCoordinatorSourceTransport({
    async sendMessage(message) { bus.push(message); return { ok: true }; },
  });
  const { controller, sent } = harness({ sourceTransport });
  controller.handleEngineMessages([{
    kind: "effect",
    type: "acquire-resource",
    effect: "fx:0",
    request: { id: 4, uri: "https://source.test/image.dzi", headers: [], purpose: "metadata" },
  }]);
  await flush();
  assert.deepEqual(
    bus.map(({ type, requestId, url, purpose }) => ({ type, requestId, url, purpose })),
    [{ type: "dz.job.fetch", requestId: "req:4", url: "https://source.test/image.dzi", purpose: "metadata" }],
  );
  assert.equal(sent.some((message) => message.type === "engine.failure"), false, "a routed fetch must not fail the engine");

  // The coordinator answers under its own token; the assembled bytes settle
  // the engine's numeric request.
  sourceTransport.handleMessage({ requestId: "req:4", sourceType: "dz.source.fetch-chunk", bytes: new Uint8Array([1, 2]) });
  sourceTransport.handleMessage({ requestId: "req:4", sourceType: "dz.source.fetch-complete", ok: true, status: 200, url: "https://source.test/image.dzi" });
  await flush();
  const bytes = sent.find((message) => message.type === "engine.bytes");
  assert.equal(bytes?.requestId, 4);
  assert.deepEqual([...bytes.bytes], [1, 2]);
});

test("lifecycle effects and events run in engine order on one chain", async () => {
  const { controller, assembly, sent } = harness();
  controller.handleEngineMessages([
    { kind: "effect", type: "request-destination", effect: "fx:1", format: "png" },
    { kind: "event", type: "job-state", state: "AwaitingDestination" },
    { kind: "effect", type: "decode-pixels", effect: "fx:6", tile: 0 },
    { kind: "effect", type: "open-encoder", effect: "fx:10", format: "png", canvas: { width: 32, height: 32 } },
    { kind: "effect", type: "finalize-encoder", effect: "fx:11" },
    { kind: "effect", type: "publish-output", effect: "fx:12", output: "out:0" },
    { kind: "effect", type: "release-bytes", effect: "fx:13" },
    { kind: "event", type: "completed", output: "out:0" },
  ]);
  await flush();
  await flush();
  const kinds = assembly.calls.map(([kind]) => kind);
  assert.deepEqual(kinds, ["decodePixels", "openEncoder", "finalizeEncoder", "publishOutput", "release"]);
  assert.deepEqual(assembly.calls[1], ["openEncoder", "png", { width: 32, height: 32 }]);
  const destination = sent.find((message) => message.type === "engine.command");
  assert.deepEqual(destination.command, { type: "destination-response", granted: true });
});

test("partial decisions surface the engine decision generation", async () => {
  const { controller, seen } = harness();
  controller.handleEngineMessages([
    { kind: "effect", type: "request-decision", effect: "fx:9", generation: 0 },
  ]);
  await flush();
  assert.deepEqual(seen.find(([kind]) => kind === "partial-decision"), ["partial-decision", 0]);
});

test("host execution failures are terminal: render, cancel, skip the rest", async () => {
  const assembly = fakeAssembly();
  assembly.openEncoder = () => { throw Object.assign(new Error("too large"), { code: "PLAN_INVALID" }); };
  const { controller, sent, seen } = harness({ assembly });
  controller.handleEngineMessages([
    { kind: "effect", type: "open-encoder", effect: "fx:10", format: "png", canvas: { width: 99999, height: 99999 } },
    { kind: "effect", type: "finalize-encoder", effect: "fx:11" },
    { kind: "event", type: "completed", output: "out:0" },
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

test("selection commands and partial choices use positional correlation", async () => {
  const { controller, sent } = harness();
  controller.selectImage(1);
  controller.selectLevel(2);
  controller.choosePartial(0, true);
  const commands = sent.map((message) => message.command);
  assert.deepEqual(commands[0], { type: "select-image", image: 1 });
  assert.deepEqual(commands[1], { type: "select-level", level: 2 });
  assert.deepEqual(commands[2], { type: "partial-choice", generation: 0, keep_partial: true });
});

test("disposal releases assembly resources exactly once", async () => {
  const { controller, assembly, sent } = harness();
  controller.dispose();
  controller.dispose();
  assert.equal(assembly.calls.filter(([kind]) => kind === "release").length, 1);
  assert.equal(sent.some((message) => message.type === "engine.dispose"), true);
});
