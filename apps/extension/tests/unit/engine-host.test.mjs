import test from "node:test";
import assert from "node:assert/strict";
import { createEngineHost } from "@dezoomify/browser-runtime";
import { createCoordinatorSourceTransport, createEngineResourceFetcher, engineFailure } from "../../src/job/transport.ts";

const BINDING = { jobId: "job:test-1", tabId: 7, frameId: 0, documentGeneration: 1 };

function fakeAssembly() {
  const calls = [];
  return {
    calls,
    prepare(canvas) { calls.push(["prepare", canvas]); },
    async acquireTile(tile, placement, bytes) { calls.push(["acquireTile", tile, placement, bytes]); },
    acquireDisplayTile(tile, placement, image) { calls.push(["acquireDisplayTile", tile, placement, image]); },
    async finalizeOutput(partial, format, canvas) {
      calls.push(["finalizeOutput", partial, format, canvas]);
      return "browser-save-initiated";
    },
    release() { calls.push(["release"]); },
  };
}

function harness({ assembly = fakeAssembly(), acquireTile, sourceTransport, probeSize, displayOnly = false, siteOrigin = () => "" } = {}) {
  if (acquireTile) assembly.acquireTile = acquireTile;
  const sent = [];
  const seen = [];
  const logs = [];
  let cancelled = false;
  const fetchResource = createEngineResourceFetcher({
    binding: () => BINDING,
    siteOrigin,
    sourceTransport: sourceTransport ?? {
      async fetchResource(request) { seen.push(["source", request]); return { bytes: new Uint8Array([9]) }; },
    },
    extensionTransport: {
      async fetchResource(url, opts) { seen.push(["extension", url, opts]); return { bytes: new Uint8Array([1, 2, 3]) }; },
    },
    cancelled: () => cancelled,
    onSourceFailure: (cause) => logs.push({ level: "warn", code: "source-fetch-failed", detail: cause }),
  });
  const controller = createEngineHost({
    worker: { postMessage: (message) => sent.push(message) },
    jobId: () => BINDING.jobId,
    fetchResource,
    cancelFetch: () => { cancelled = true; seen.push(["cancel"]); },
    assembly,
    probeSize: probeSize ?? (async () => ({ status: "available", width: 256, height: 256 })),
    ...(displayOnly ? { loadDisplayImage: async () => ({ naturalWidth: 64, naturalHeight: 64 }) } : {}),
    classifyFailure: (error) => ({ blocked_reason: "network", code: error?.code ?? "extension.network", retryable: true, message: String(error?.message ?? error), transport: "browser-session" }),
    onPermissionRequired: (detail) => seen.push(["permission", detail]),
    onRecoveryRequested: (generation) => seen.push(["recovery-decision", generation]),
    onHostFailure: (error) => seen.push(["host-failure", error]),
    log: (level, code, detail) => logs.push({ level, code, detail }),
  });
  return { controller, sent, seen, assembly, logs };
}

// Canonical HostEffect: bare typed effects, no kind/event envelope.
const TILE_EFFECT = {
  type: "acquire-tile",
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
  const acquired = sent.find((message) => message.type === "engine.acquired");
  assert.ok(acquired, "body-free acquired outcome was sent");
  assert.equal(acquired.requestId, 0);
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
  const retried = [];
  const assembly = fakeAssembly();
  const controller = createEngineHost({
    worker: { postMessage: (message) => sent.push(message) },
    jobId: () => BINDING.jobId,
    fetchResource: async () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("grant required"), { category: "access-required", code: "permission-denied", hosts: ["https://cdn.test"] });
      return { bytes: new Uint8Array([1]) };
    },
    cancelFetch: () => {},
    assembly,
    probeSize: async () => ({ status: "available", width: 256, height: 256 }),
    classifyFailure: (error) => ({ blocked_reason: error?.category ?? "network", code: "extension.network", retryable: true, message: String(error?.message ?? error), transport: "browser-session" }),
    onPermissionRequired: (detail) => retried.push(detail),
    onRecoveryRequested() {}, onHostFailure() {},
  });
  controller.handleEngineMessages([TILE_EFFECT]);
  await flush();
  assert.equal(sent.some((message) => message.type === "engine.failure"), false, "grantable access waits for the decision");
  assert.equal(retried.length, 1);
  controller.resolvePermission(true);
  await flush();
  assert.equal(attempts, 2);
  assert.ok(sent.some((message) => message.type === "engine.acquired"));
});

test("a granted-origin refusal fails typed without re-prompting for a grant", async () => {
  // #1081: an upstream 401/403 is not a missing browser permission. The
  // host must not pause for a grant it already holds; the failure flows to
  // the engine and the acquisition fails.
  const sent = [];
  const retried = [];
  const assembly = fakeAssembly();
  const controller = createEngineHost({
    worker: { postMessage: (message) => sent.push(message) },
    jobId: () => BINDING.jobId,
    fetchResource: async () => { throw Object.assign(new Error("forbidden"), { category: "forbidden", code: "extension.network", hosts: ["https://cdn.test"] }); },
    cancelFetch: () => {},
    assembly,
    probeSize: async () => ({ status: "available", width: 256, height: 256 }),
    classifyFailure: (error) => ({ blocked_reason: error?.category ?? "network", code: "extension.network", retryable: false, message: String(error?.message ?? error), transport: "browser-session" }),
    onPermissionRequired: (detail) => retried.push(detail),
    onRecoveryRequested() {}, onHostFailure() {},
  });
  controller.handleEngineMessages([TILE_EFFECT]);
  await flush();
  assert.equal(retried.length, 0, "a granted-origin refusal never pauses for another grant");
  const failure = sent.find((message) => message.type === "engine.failure");
  assert.ok(failure, "the refusal reaches the engine");
  assert.equal(failure.requestId, 0);
});

test("metadata requests route through the source transport", async () => {
  const { controller, seen } = harness();
  controller.handleEngineMessages([{
    type: "acquire-resource",
    request: { id: 0, uri: "https://source.test/image.dzi", headers: [], purpose: "metadata" },
  }]);
  await flush();
  assert.equal(seen[0][0], "source");
});

test("a failed source fetch retries through the extension-origin transport", async () => {
  const { controller, sent, seen } = harness({
    sourceTransport: { async fetchResource() { throw Object.assign(new Error("cors"), { category: "network" }); } },
  });
  controller.handleEngineMessages([{
    type: "acquire-resource",
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

test("a definitive source HTTP response is not retried through the extension origin", async () => {
  const { controller, sent, seen } = harness({
    sourceTransport: { async fetchResource() { throw Object.assign(new Error("not found"), { category: "network", sourceDefinitive: true }); } },
  });
  controller.handleEngineMessages([{
    type: "acquire-resource",
    request: { id: 0, uri: "https://source.test/missing.dzi", headers: [], purpose: "metadata" },
  }]);
  await flush();
  assert.equal(seen.some(([kind]) => kind === "extension"), false);
  assert.equal(sent.find((message) => message.type === "engine.failure")?.requestId, 0);
});

test("probe effects report measurements without retaining tiles", async () => {
  const { controller, sent, assembly } = harness({
    probeSize: async () => ({ status: "available", width: 256, height: 128 }),
  });
  controller.handleEngineMessages([{
    ...TILE_EFFECT,
    request: { id: 7, uri: "https://cdn.test/probe_0.jpg", headers: [], purpose: "probe" },
  }]);
  await flush();
  const probe = sent.find((message) => message.type === "engine.probe");
  assert.ok(probe, "probe outcome was sent");
  assert.equal(probe.requestId, 7);
  assert.deepEqual(probe.outcome, { status: "available", width: 256, height: 128 });
  assert.equal(assembly.calls.some(([kind]) => kind === "acquireTile"), false);
  assert.equal(sent.some((message) => message.type === "engine.bytes"), false);
});

test("lifecycle effects run in engine order on one chain", async () => {
  const { controller, assembly, sent } = harness();
  controller.handleEngineMessages([
    { type: "finalize-output", effect: 10, partial: false, format: "png", canvas: { width: 32, height: 32 } },
  ]);
  await flush();
  await flush();
  const kinds = assembly.calls.map(([kind]) => kind);
  assert.deepEqual(kinds, ["finalizeOutput"]);
  assert.deepEqual(assembly.calls[0], ["finalizeOutput", false, "png", { width: 32, height: 32 }]);
  const finalized = sent.find((message) => message.type === "engine.finalize");
  assert.deepEqual(finalized.outcome, { type: "finalization-succeeded", effect: 10, disposition: "browser-save-initiated" });
});

test("cancel-work releases retained resources and cancels fetching", async () => {
  const { controller, assembly, seen } = harness();
  controller.handleEngineMessages([{ type: "cancel-work", effect: 20 }]);
  assert.deepEqual(assembly.calls.map(([kind]) => kind), ["release"]);
  assert.ok(seen.some(([kind]) => kind === "cancel"));
});

test("a failed awaited output replies typed instead of crashing the host", async () => {
  const assembly = fakeAssembly();
  assembly.finalizeOutput = async () => { throw Object.assign(new Error("too large"), { code: "PLAN_INVALID", retryable: false }); };
  const { controller, sent, seen } = harness({ assembly });
  controller.handleEngineMessages([
    { type: "finalize-output", effect: 10, partial: false, format: "png", canvas: { width: 99999, height: 99999 } },
  ]);
  await flush();
  await flush();
  const finalized = sent.find((message) => message.outcome?.type === "finalization-failed");
  assert.ok(finalized, "typed finalization failure was sent");
  assert.equal(finalized.outcome.effect, 10);
  assert.equal(finalized.outcome.error.code, "PLAN_INVALID");
  assert.equal(seen.some(([kind]) => kind === "host-failure"), false, "an awaited failure is not a host crash");
});

test("display fallback holds an ordinary image when bytes are unreadable", async () => {
  const { controller, sent, assembly } = harness({
    displayOnly: true,
    sourceTransport: { async fetchResource() { throw Object.assign(new Error("cors"), { category: "network" }); } },
    acquireTile: async () => { throw Object.assign(new Error("no bytes"), { category: "network" }); },
  });
  controller.handleEngineMessages([{
    ...TILE_EFFECT,
    request: { id: 3, uri: "https://cdn.test/tainted.jpg", headers: [], purpose: "tile" },
  }]);
  await flush();
  const display = sent.find((message) => message.type === "engine.display");
  assert.ok(display, "display outcome was sent");
  assert.equal(display.requestId, 3);
  assert.equal(assembly.calls.some(([kind]) => kind === "acquireDisplayTile"), true);
});

test("coordinator source fetches name the engine request on the extension bus", async () => {
  const bus = [];
  const sourceTransport = createCoordinatorSourceTransport({
    async sendMessage(message) { bus.push(message); return { ok: true }; },
  });
  const { controller, sent } = harness({ sourceTransport });
  controller.handleEngineMessages([{
    type: "acquire-resource",
    request: { id: 4, uri: "https://source.test/image.dzi", headers: [], purpose: "metadata" },
  }]);
  await flush();
  assert.deepEqual(
    bus.map(({ type, requestId, url, purpose }) => ({ type, requestId, url, purpose })),
    [{ type: "dz.job.fetch", requestId: "req:4", url: "https://source.test/image.dzi", purpose: "metadata" }],
  );
  assert.equal(sent.some((message) => message.type === "engine.failure"), false, "a routed fetch must not fail the engine");

  sourceTransport.handleMessage({ requestId: "req:4", sourceType: "dz.source.fetch-complete", ok: true, status: 200, url: "https://source.test/image.dzi", bytes: 2, data: "AQI=" });
  await flush();
  const bytes = sent.find((message) => message.type === "engine.bytes");
  assert.equal(bytes?.requestId, 4);
  assert.deepEqual([...bytes.bytes], [1, 2]);
});

test("a site-origin tile routes through the source transport first", async () => {
  const { controller, seen } = harness({ siteOrigin: () => "https://cdn.test" });
  controller.handleEngineMessages([TILE_EFFECT]);
  await flush();
  assert.equal(seen[0][0], "source");
  assert.equal(seen[0][1].uri, "https://cdn.test/tile_0.jpg");
});

test("a failed site-origin source fetch falls back to the extension origin", async () => {
  let sourceAttempts = 0;
  const { controller, sent, seen, logs } = harness({
    siteOrigin: () => "https://cdn.test",
    sourceTransport: { async fetchResource() { sourceAttempts += 1; throw Object.assign(new Error("cors"), { category: "network" }); } },
  });
  controller.handleEngineMessages([TILE_EFFECT]);
  await flush();
  assert.equal(sourceAttempts, 1, "the site-origin tile tries the source transport first");
  assert.deepEqual(seen.map(([kind]) => kind), ["extension"]);
  const acquired = sent.find((message) => message.type === "engine.acquired");
  assert.equal(acquired?.requestId, 0);
  assert.ok(logs.some((log) => log.code === "source-fetch-failed"), "the source failure is logged before the fallback");
});

test("a cross-origin tile never touches the source transport", async () => {
  const { controller, seen } = harness({ siteOrigin: () => "https://source.test" });
  controller.handleEngineMessages([TILE_EFFECT]);
  await flush();
  assert.deepEqual(seen.map(([kind]) => kind), ["extension"]);
});

test("a probe request routes through the same fetcher as effects", async () => {
  const seen = [];
  const fetchResource = createEngineResourceFetcher({
    binding: () => BINDING,
    siteOrigin: () => "https://cdn.test",
    sourceTransport: {
      async fetchResource(request) { seen.push(["source", request]); return { bytes: new Uint8Array([7, 8]) }; },
    },
    extensionTransport: {
      async fetchResource(url, opts) { seen.push(["extension", url, opts]); return { bytes: new Uint8Array([1, 2, 3]) }; },
    },
    cancelled: () => false,
  });
  const result = await fetchResource({
    request: { id: 9, uri: "https://cdn.test/probe_0.jpg", headers: [], purpose: "probe" },
  });
  assert.deepEqual([...result.bytes], [7, 8]);
  assert.deepEqual(seen.map(([kind]) => kind), ["source"]);
});
