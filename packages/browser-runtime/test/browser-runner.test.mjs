import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserRunner } from "../src/browser-runner.ts";

function fakeWorker() {
  const listeners = [];
  return {
    posted: [],
    terminated: false,
    transfers: [],
    postMessage(message, transfer) {
      this.posted.push(message);
      if (transfer) this.transfers.push(transfer);
    },
    addEventListener(type, listener) {
      assert.equal(type, "message");
      listeners.push(listener);
    },
    terminate() { this.terminated = true; },
    receive(data) {
      for (const listener of listeners) listener({ data });
    },
  };
}

const TILE = {
  type: "acquire-tile",
  tile: 0,
  request: { id: 1, uri: "https://tiles.test/0.png", headers: [], purpose: "tile" },
  placement: { position: { x: 0, y: 0 }, processing: "none", canvas: { width: 256, height: 256 } },
};

function product(overrides = {}) {
  const worker = fakeWorker();
  const seen = { fetches: 0, assemblies: 0 };
  let tainted = false;
  let permissionPending = false;
  return {
    worker,
    seen,
    setTainted(value) { tainted = value; },
    setPermissionPending(value) { permissionPending = value; },
    deps: {
      createWorker: () => worker,
      fetchResource: async () => {
        seen.fetches += 1;
        return { bytes: new Uint8Array([9, 9]) };
      },
      probeSize: async () => ({ status: "missing" }),
      classifyFailure: (error) => ({
        code: "browser.network",
        retryable: true,
        message: String(error?.message ?? error),
        transport: "direct",
      }),
      createAssembly: () => {
        seen.assemblies += 1;
        return {
          prepare() {},
          async acquireTile() {},
          acquireDisplayTile() {},
          async finalizeOutput() {},
          release() {},
          isTainted: () => tainted,
        };
      },
      quotas: { max_concurrent_fetches: 6 },
      sessionId: () => "sess:test",
      getTransport: () => "direct",
      isPermissionPending: () => permissionPending,
      getOutputState: () => "pending",
      ...overrides,
    },
  };
}

function startRequest(overrides = {}) {
  return {
    inputs: [{ url: "https://meta.test/info.json" }],
    engine: {},
    exec: { kind: "browser" },
    ...overrides,
  };
}

// Authoritative EngineSnapshotDto builder: snapshots are absolute and ride
// alongside engine messages; the runner forwards the latest one.
function snap(revision, overrides = {}) {
  return {
    revision,
    lifecycle: "AcquiringTiles",
    paused: false,
    progress: { completed: 0, total: undefined },
    selection: { image: undefined, level: undefined, level_count: 0, catalog: undefined, deferred: [] },
    decision: undefined,
    terminal: undefined,
    output: undefined,
    ...overrides,
  };
}

function received(snapshot, messages = []) {
  return { type: "engine.messages", messages, snapshot };
}

function sink(emitted) {
  return { snapshot: (snapshot, host) => emitted.push([snapshot, host]) };
}

test("non-browser exec and empty inputs reject typed before any worker exists", async () => {
  const p = product();
  const runner = createBrowserRunner(p.deps);
  await assert.rejects(() => runner.start(startRequest({ exec: { kind: "native", destination: {} } }), { snapshot: () => {} }), (error) => {
    assert.equal(error.code, "browser.invalid-exec");
    return true;
  });
  await assert.rejects(() => runner.start(startRequest({ inputs: [] }), { snapshot: () => {} }), (error) => {
    assert.equal(error.code, "browser.invalid-source");
    return true;
  });
});

test("start roots the session at the first input with merged quotas", async () => {
  const p = product();
  const runner = createBrowserRunner(p.deps);
  await runner.start(startRequest({ engine: { max_concurrent_fetches: 3 } }), { snapshot: () => {} });
  const start = p.worker.posted.find((message) => message.type === "engine.start");
  assert.ok(start, "expected engine.start on the worker");
  assert.deepEqual(start.inputs, [{ url: "https://meta.test/info.json" }]);
  assert.equal(start.quotas.max_concurrent_fetches, 3);
  assert.equal(p.seen.assemblies, 1);
});

test("snapshots pass through with live host status", async () => {
  const p = product();
  const runner = createBrowserRunner(p.deps);
  const emitted = [];
  await runner.start(startRequest(), sink(emitted));
  p.worker.receive(received(snap(1, { progress: { completed: 1, total: 4 } })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0].progress.completed, 1);
  assert.deepEqual(emitted[0][1], { transport: "direct", permission: "granted", output: "pending" });
  p.setTainted(true);
  p.worker.receive(received(snap(2, { progress: { completed: 2, total: 4 } })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(emitted[1][1].output, "display-only");
});

test("a missing grant suspends as pending host status, not a phase machine", async () => {
  const p = product({
    fetchResource: async () => {
      throw Object.assign(new Error("grant missing"), { code: "permission-denied" });
    },
    classifyFailure: () => ({
      code: "permission-denied",
      retryable: false,
      message: "Access requires an explicit action.",
      blocked_reason: "access-required",
      transport: "browser-session",
    }),
  });
  let permissionDetail = null;
  p.deps.onPermissionRequired = (detail) => { permissionDetail = detail; };
  const runner = createBrowserRunner(p.deps);
  const emitted = [];
  const handle = await runner.start(startRequest(), sink(emitted));
  p.worker.receive(received(snap(1), [TILE]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(permissionDetail, "expected the product permission action");
  assert.deepEqual(permissionDetail.hosts, []);
  // No engine outcome while suspended: the effect stays pending.
  assert.ok(!p.worker.posted.some((message) => message.type === "engine.failure"));
  p.setPermissionPending(true);
  p.worker.receive(received(snap(2, { progress: { completed: 0, total: 1 } })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(emitted.at(-1)[1].permission, "prompt");
  // Denial fails the acquisition typed without re-prompting.
  handle.resolvePermission(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failure = p.worker.posted.find((message) => message.type === "engine.failure");
  assert.ok(failure, "expected the denied grant to fail the effect");
});

test("user commands map onto the session; engine-internal commands reject typed", async () => {
  const p = product();
  const runner = createBrowserRunner(p.deps);
  const handle = await runner.start(startRequest(), { snapshot: () => {} });
  await handle.command({ type: "select-image", image: 2 });
  await handle.command({ type: "follow-deferred", image: 1 });
  await handle.command({ type: "select-level", level: 1 });
  await handle.command({ type: "answer-partial", generation: 0, decision: "keep" });
  await handle.command({ type: "pause" });
  await handle.command({ type: "resume" });
  await handle.command({ type: "cancel" });
  const kinds = p.worker.posted.map((message) => message.type);
  assert.ok(kinds.includes("engine.command"));
  const follow = p.worker.posted.find((message) => message.command?.type === "follow-deferred");
  assert.deepEqual(follow?.command, { type: "follow-deferred", image: 1 });
  await assert.rejects(() => handle.command({ type: "start", inputs: [] }), (error) => {
    assert.equal(error.code, "browser.unsupported-command");
    return true;
  });
});

test("a terminal snapshot settles the UI; stale live snapshots never emit", async () => {
  const p = product();
  const runner = createBrowserRunner(p.deps);
  const emitted = [];
  const handle = await runner.start(startRequest(), sink(emitted));
  p.worker.receive(received(snap(1, { lifecycle: "Completed", terminal: { type: "completed" } })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(emitted.length, 1);
  // A stale live snapshot never moves the UI; terminals always settle it.
  p.worker.receive(received(snap(0, { progress: { completed: 9, total: 9 } })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(emitted.length, 1, "stale live snapshot emitted after terminal");
  // Post-terminal commands still forward: the engine owns post-terminal
  // semantics. Only a disposed attempt rejects, since its worker is gone.
  await handle.command({ type: "pause" });
  assert.ok(p.worker.posted.some((message) => message.type === "engine.command"));
  await handle.dispose();
  await assert.rejects(() => handle.command({ type: "pause" }), (error) => {
    assert.equal(error.code, "browser.job-settled");
    return true;
  });
});

test("an adapter error projects to a terminal failed snapshot, not a hang", async () => {
  const p = product();
  const runner = createBrowserRunner(p.deps);
  const emitted = [];
  await runner.start(startRequest(), sink(emitted));
  const adapterError = {
    code: "adapter.abi",
    phase: "validation",
    retryable: false,
    message: "The browser and image engine could not exchange a typed message.",
    recovery: [],
  };
  p.worker.receive({ type: "engine.error", error: adapterError });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0].terminal.type, "failed");
  assert.equal(emitted[0][0].terminal.error.code, "adapter.abi");
});

test("dispose aborts in-flight fetches, terminates the worker, and settles pending work", async () => {
  let sawAbortedSignal = false;
  const p = product({
    fetchResource: async (effect, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      sawAbortedSignal = signal.aborted;
      return { bytes: new Uint8Array([1]) };
    },
  });
  const runner = createBrowserRunner(p.deps);
  const emitted = [];
  const handle = await runner.start(startRequest(), sink(emitted));
  p.worker.receive(received(snap(1), [TILE]));
  const emittedBeforeDispose = emitted.length;
  await handle.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(p.worker.terminated, true);
  assert.equal(sawAbortedSignal, true, "in-flight fetch never observed the abort");
  assert.equal(emitted.length, emittedBeforeDispose, "disposed attempt emitted after teardown");
});

test("processing calls transfer their buffer and settle on disposal", async () => {
  const p = product();
  let assemblyProcess = null;
  p.deps.createAssembly = (args) => {
    assemblyProcess = args.processTile;
    return {
      prepare() {},
      async acquireTile() {},
      acquireDisplayTile() {},
      async finalizeOutput() {},
      release() {},
    };
  };
  const runner = createBrowserRunner(p.deps);
  const handle = await runner.start(startRequest(), { snapshot: () => {} });
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const pending = assemblyProcess({ recipe: "none" }, bytes);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const processCall = p.worker.posted.find((message) => message.type === "engine.process");
  assert.ok(processCall, "expected the processing call on the worker");
  assert.equal(p.worker.transfers.flat().length, 1, "processing bytes must transfer, not copy");
  await handle.dispose();
  await assert.rejects(() => pending, (error) => {
    assert.equal(error.code, "browser.job-settled");
    return true;
  });
});
