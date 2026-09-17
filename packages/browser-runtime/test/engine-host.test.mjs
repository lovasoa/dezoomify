import test from "node:test";
import assert from "node:assert/strict";
import { createEngineHost } from "../src/engine-host.ts";

function fakeAssembly() {
  const calls = [];
  return {
    calls,
    async acquireTile(tile, placement, bytes) { calls.push(["acquireTile", tile, placement, bytes]); },
    acquireDisplayTile(tile, placement, image) { calls.push(["acquireDisplayTile", tile, placement, image]); },
    async finalizeOutput(partial, format, canvas) { calls.push(["finalizeOutput", partial, format, canvas]); },
    release() { calls.push(["release"]); },
  };
}

function harness({ fetchResource, loadDisplayImage, assembly = fakeAssembly(), probeSize } = {}) {
  const sent = [];
  const seen = [];
  const logs = [];
  const controller = createEngineHost({
    worker: { postMessage: (message) => sent.push(message) },
    jobId: () => "sess:web-test",
    fetchResource: fetchResource ?? (async (effect) => {
      seen.push(["fetch", effect.request.uri]);
      if (effect.request.purpose === "metadata") return { bytes: new Uint8Array([9]), finalUri: "https://final.test/info.json" };
      return { bytes: new Uint8Array([1, 2, 3]) };
    }),
    cancelFetch: () => seen.push(["cancel"]),
    assembly,
    probeSize: probeSize ?? (async () => ({ ok: true, width: 256, height: 256 })),
    ...(loadDisplayImage ? { loadDisplayImage } : {}),
    classifyFailure: (error) => ({
      blocked_reason: error?.category ?? "network",
      code: error?.code ?? "network",
      retryable: error?.retryable ?? true,
      message: String(error?.message ?? error),
      transport: error?.transport,
      http: error?.http,
      preview: error?.preview,
      detail: error?.detail,
    }),
    onPermissionRequired: () => {},
    onRecoveryRequested: () => seen.push(["recovery"]),
    onHostFailure: (error) => seen.push(["host-failure", error]),
    onEvent: (event) => seen.push(["event", event.type]),
    onUnsupportedEffect: (effect) => seen.push(["unsupported", effect.type]),
    log: (level, code, detail) => logs.push({ level, code, detail }),
  });
  return { controller, sent, seen, assembly, logs };
}

const TILE = {
  kind: "effect",
  type: "acquire-tile",
  effect: "fx:2",
  tile: 0,
  placement: { position: { x: 0, y: 0 }, expected_size: { width: 16, height: 16 }, canvas: { width: 32, height: 32 }, processing: "none" },
  request: { id: 0, uri: "https://cdn.test/tile_0.jpg", headers: [], purpose: "tile" },
};

function flush() { return new Promise((resolve) => setTimeout(resolve, 0)); }

test("metadata carries the observed post-redirect URL", async () => {
  const { controller, sent } = harness();
  controller.handleEngineMessages([{
    kind: "effect",
    type: "acquire-resource",
    effect: "fx:0",
    request: { id: 4, uri: "https://cdn.test/info.json", headers: [], purpose: "metadata" },
  }]);
  await flush();
  const bytes = sent.find((message) => message.type === "engine.bytes");
  assert.equal(bytes?.finalUri, "https://final.test/info.json");
});

test("probe effects report measurements without retaining tiles", async () => {
  const { controller, sent, assembly } = harness({ probeSize: async () => ({ ok: true, width: 256, height: 128 }) });
  controller.handleEngineMessages([{ ...TILE, request: { id: 7, uri: "https://cdn.test/p.jpg", headers: {}, purpose: "probe" } }]);
  await flush();
  const probe = sent.find((message) => message.type === "engine.probe");
  assert.deepEqual([probe?.requestId, probe?.ok, probe?.width, probe?.height], [7, true, 256, 128]);
  assert.equal(assembly.calls.some(([kind]) => kind === "acquireTile"), false);
});

test("probe-and-output effects retain readable bytes for final assembly", async () => {
  const bytes = new ArrayBuffer(8);
  const { controller, sent, assembly } = harness({
    probeSize: async () => ({ ok: true, width: 256, height: 128, bytes }),
  });
  controller.handleEngineMessages([{
    ...TILE,
    placement: { ...TILE.placement, probe_output: true },
    request: { id: 8, uri: "https://cdn.test/p.jpg", headers: {}, purpose: "probe" },
  }]);
  await flush();
  assert.deepEqual(assembly.calls[0], ["acquireTile", 0, { ...TILE.placement, probe_output: true }, bytes]);
  assert.equal(sent.find((message) => message.type === "engine.probe")?.ok, true);
});

test("unreadable ordinary tiles fall back to display-only and memoize the origin", async () => {
  let fetches = 0;
  let loads = 0;
  const { controller, sent, assembly } = harness({
    fetchResource: async () => { fetches += 1; throw Object.assign(new Error("no CORS grant"), { category: "network" }); },
    loadDisplayImage: async () => { loads += 1; return { naturalWidth: 256, naturalHeight: 128 }; },
  });
  controller.handleEngineMessages([TILE, { ...TILE, tile: 1, request: { id: 1, uri: "https://cdn.test/tile_1.jpg", headers: [], purpose: "tile" } }]);
  await flush();
  await flush();
  assert.equal(assembly.calls.filter(([kind]) => kind === "acquireDisplayTile").length, 2);
  assert.deepEqual(sent.filter((message) => message.type === "engine.display").map((message) => message.requestId), [0, 1]);
  assert.equal(loads, 2);
  assert.equal(fetches, 1, "the second tile of a display-only origin skips the fetch");
});

test("processed tiles never use the display fallback", async () => {
  const { controller, sent, assembly } = harness({
    fetchResource: async () => { throw Object.assign(new Error("no CORS grant"), { category: "network" }); },
    loadDisplayImage: async () => { throw new Error("must not load"); },
  });
  controller.handleEngineMessages([{ ...TILE, placement: { ...TILE.placement, processing: "google-arts-decrypt" } }]);
  await flush();
  assert.equal(assembly.calls.some(([kind]) => kind === "acquireDisplayTile"), false);
  const failure = sent.find((message) => message.type === "engine.failure");
  assert.ok(failure, "processed acquisition fails instead of dropping the recipe");
});

test("lifecycle effects and events run in engine order on one chain", async () => {
  const { controller, assembly, sent } = harness();
  controller.handleEngineMessages([
    { kind: "effect", type: "finalize-output", effect: "fx:10", partial: false, format: "png", canvas: { width: 32, height: 32 } },
    { kind: "event", type: "completed" },
  ]);
  await flush();
  await flush();
  assert.deepEqual(assembly.calls.map(([kind]) => kind), ["finalizeOutput"]);
  assert.deepEqual(assembly.calls[0], ["finalizeOutput", false, "png", { width: 32, height: 32 }]);
  const finalized = sent.find((message) => message.type === "engine.command");
  assert.deepEqual(finalized.command, { type: "finalization-succeeded" });
});

test("cancel-work releases retained resources and cancels fetching", async () => {
  const { controller, assembly, seen } = harness();
  controller.handleEngineMessages([{ kind: "effect", type: "cancel-work", effect: "fx:20" }]);
  assert.deepEqual(assembly.calls.map(([kind]) => kind), ["release"]);
  assert.ok(seen.some(([kind]) => kind === "cancel"));
});

test("a failed awaited output replies typed instead of faking success", async () => {
  const assembly = fakeAssembly();
  assembly.finalizeOutput = async () => { throw Object.assign(new Error("too large"), { code: "PLAN_INVALID", retryable: false }); };
  const { controller, sent, seen } = harness({ assembly });
  controller.handleEngineMessages([
    { kind: "effect", type: "finalize-output", effect: "fx:10", partial: false, format: "png", canvas: { width: 99999, height: 99999 } },
    { kind: "event", type: "failed", error: { code: "PLAN_INVALID" } },
  ]);
  await flush();
  await flush();
  const finalized = sent.find((message) => message.command?.type === "finalization-failed");
  assert.ok(finalized, "typed finalization failure was sent");
  assert.equal(finalized.command.error.code, "PLAN_INVALID");
  assert.equal(finalized.command.error.phase, "output");
  assert.equal(seen.some(([kind]) => kind === "host-failure"), false, "an awaited failure is not a host crash");
});
