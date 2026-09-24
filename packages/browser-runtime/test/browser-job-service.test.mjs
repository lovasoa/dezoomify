import assert from "node:assert/strict";
import test from "node:test";
import { createBrowserJobService } from "../src/browser-job-service.ts";
import { createWebFetcher } from "../src/web-fetch.ts";

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
    terminate() {
      this.terminated = true;
    },
    receive(data) {
      for (const listener of listeners) listener({ data });
    },
  };
}

const TILE = {
  type: "acquire-tile",
  effect: 99,
  tile: 0,
  request: { id: 1, uri: "https://tiles.test/0.png", headers: [], purpose: "tile" },
  placement: { position: { x: 0, y: 0 }, processing: "none", canvas: { width: 256, height: 256 } },
};

function product(overrides = {}) {
  const worker = fakeWorker();
  const seen = { fetches: 0, assemblies: 0 };
  let tainted = false;
  return {
    worker,
    seen,
    setTainted(value) {
      tainted = value;
    },
    deps: {
      createWorker: () => worker,
      fetchResource: async () => {
        seen.fetches += 1;
        return { bytes: new Uint8Array([9, 9]) };
      },
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
          async finalizeOutput() {
            return "browser-save-ready";
          },
          release() {},
          isTainted: () => tainted,
        };
      },
      quotas: { max_concurrent_fetches: 6 },
      ...overrides,
    },
  };
}

function startRequest(overrides = {}) {
  return {
    inputs: [{ url: "https://meta.test/info.json" }],
    engine: {},

    ...overrides,
  };
}

// Authoritative Snapshot builder: snapshots are absolute and ride
// alongside engine messages; the service forwards the latest one.
function snap(revision, overrides = {}) {
  return {
    revision,
    lifecycle: "AcquiringTiles",
    paused: false,
    progress: { completed: 0, total: undefined },
    selection: {
      image: undefined,
      level: undefined,
      level_count: 0,
      catalog: undefined,
      deferred: [],
    },
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
  return {
    snapshot: (snapshot) => emitted.push(snapshot),
    failure: (error) => {
      throw error;
    },
  };
}

test("invalid service requests reject typed before any worker exists", async () => {
  const p = product();
  const service = createBrowserJobService(p.deps);
  await assert.rejects(
    () =>
      service.start(startRequest({ inputs: [] }), {
        snapshot: () => {},
        failure: (error) => {
          throw error;
        },
      }),
    (error) => {
      assert.equal(error.code, "validation.empty-inputs");
      return true;
    },
  );
});

test("service sends one-attempt structured tile failures to the engine", async (t) => {
  for (const fixture of [
    {
      name: "HTTP 403",
      status: 403,
      expectedCode: "TRANSPORT_HTTP_ERROR",
      retryable: false,
      fetchImpl: async () => ({
        status: 403,
        headers: {},
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    },
    {
      name: "transient network error",
      expectedCode: "TRANSPORT_NETWORK_ERROR",
      retryable: true,
      fetchImpl: async () => {
        throw new Error("connection reset");
      },
    },
    {
      name: "HTTP 429 Retry-After",
      status: 429,
      expectedCode: "TRANSPORT_HTTP_ERROR",
      retryable: true,
      retryAfterMs: 3000,
      fetchImpl: async () => ({
        status: 429,
        headers: { get: (name) => (name === "retry-after" ? "3" : null) },
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    },
  ]) {
    await t.test(fixture.name, async () => {
      let calls = 0;
      const fetcher = createWebFetcher({
        fetchImpl: async (...args) => {
          calls += 1;
          return fixture.fetchImpl(...args);
        },
        isProxyEligible: () => ({ eligible: false, reason: "tile" }),
        hooks: { onRequestStart: () => 1, onRequestEnd() {}, onLog() {}, onUpdate() {} },
        messages: {
          rateLimitedBySite: "limited",
          siteBusy: "busy",
          discoveryFailed: () => "missing",
        },
        throttle: async () => {},
      });
      const p = product({
        fetchResource: (request, signal) =>
          fetcher
            .fetchTileFor(request.uri, {}, signal)
            .then((result) => ({ bytes: new Uint8Array(result.bytes) })),
        classifyFailure: (error) => ({
          code: error.cause?.code ?? error.code,
          retryable: error.retryable,
          message: error.message,
          transport: error.cause?.transport ?? "direct",
          ...(typeof error.http === "number" ? { http: error.http } : {}),
          ...(typeof error.retry_after_ms === "number"
            ? { retry_after_ms: error.retry_after_ms }
            : {}),
        }),
      });
      const service = createBrowserJobService(p.deps);
      const handle = await service.start(startRequest(), {
        snapshot: () => {},
        failure: (error) => {
          throw error;
        },
      });
      p.worker.receive(received(snap(1), [TILE]));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      const failureMessage = p.worker.posted.find(
        (message) => message.type === "engine.failure" && message.requestId === TILE.request.id,
      );
      assert.ok(failureMessage);
      assert.equal(failureMessage.error.code, fixture.expectedCode);
      assert.equal(failureMessage.error.retryable, fixture.retryable);
      assert.equal(failureMessage.error.transport, "direct");
      if (fixture.status) assert.equal(failureMessage.error.http, fixture.status);
      if (fixture.retryAfterMs)
        assert.equal(failureMessage.error.retry_after_ms, fixture.retryAfterMs);
      await handle.dispose();
    });
  }
});

test("start roots the session at the first input and preserves selection policy", async () => {
  const p = product();
  const service = createBrowserJobService(p.deps);
  const browserSelection = { maxWidth: 16384, maxHeight: 16384, maxArea: 268435456 };
  await service.start(
    startRequest({
      engine: {
        max_concurrent_fetches: 3,
        max_tiles: 100_000,
        browser_selection: browserSelection,
      },
    }),
    {
      snapshot: () => {},
      failure: (error) => {
        throw error;
      },
    },
  );
  const start = p.worker.posted.find((message) => message.type === "engine.start");
  assert.ok(start, "expected engine.start on the worker");
  assert.deepEqual(start.inputs, [{ url: "https://meta.test/info.json" }]);
  assert.equal(start.quotas.max_concurrent_fetches, 3);
  assert.equal(start.quotas.max_tiles, 100_000);
  assert.deepEqual(start.quotas.browser_selection, browserSelection);
  assert.equal(p.seen.assemblies, 1);

  const manual = product();
  await createBrowserJobService(manual.deps).start(startRequest(), {
    snapshot: () => {},
    failure: (error) => {
      throw error;
    },
  });
  const manualStart = manual.worker.posted.find((message) => message.type === "engine.start");
  assert.equal(
    manualStart.quotas.browser_selection,
    undefined,
    "generic service does not force auto-selection",
  );
});

test("snapshots pass through without presentation plumbing", async () => {
  const p = product();
  const emitted = [];
  const handle = await createBrowserJobService(p.deps).start(startRequest(), sink(emitted));
  const snapshot = snap(1);
  p.worker.receive(received(snapshot));
  assert.deepEqual(emitted, [snapshot]);
  await handle.dispose();
});

test("a missing grant suspends its acquisition until the explicit answer", async () => {
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
  p.deps.onPermissionRequired = (detail) => {
    permissionDetail = detail;
  };
  const service = createBrowserJobService(p.deps);
  const emitted = [];
  const handle = await service.start(startRequest(), {
    snapshot: (snapshot) => emitted.push(snapshot),
    failure: (error) => {
      throw error;
    },
  });
  p.worker.receive(received(snap(1), [TILE]));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(permissionDetail, "expected the product permission action");
  assert.deepEqual(permissionDetail.hosts, []);
  // No engine outcome while suspended: the effect stays pending.
  assert.ok(!p.worker.posted.some((message) => message.type === "engine.failure"));
  p.worker.receive(received(snap(2, { progress: { completed: 0, total: 1 } })));
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Denial fails the acquisition typed without re-prompting.
  handle.resolvePermission(false);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const failure = p.worker.posted.find((message) => message.type === "engine.failure");
  assert.ok(failure, "expected the denied grant to fail the effect");
});

test("user commands map onto the session; engine-internal commands reject typed", async () => {
  const p = product();
  const service = createBrowserJobService(p.deps);
  const handle = await service.start(startRequest(), {
    snapshot: () => {},
    failure: (error) => {
      throw error;
    },
  });
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
  await assert.rejects(
    () => handle.command({ type: "start", inputs: [] }),
    (error) => {
      assert.equal(error.code, "browser.unsupported-command");
      return true;
    },
  );
});

test("a terminal snapshot settles the UI; stale live snapshots never emit", async () => {
  const p = product();
  const service = createBrowserJobService(p.deps);
  const emitted = [];
  const handle = await service.start(startRequest(), sink(emitted));
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
  await assert.rejects(
    () => handle.command({ type: "pause" }),
    (error) => {
      assert.equal(error.code, "browser.job-settled");
      return true;
    },
  );
});

test("an adapter fault settles once without inventing an engine snapshot", async () => {
  const p = product();
  const service = createBrowserJobService(p.deps);
  const emitted = [];
  const failures = [];
  await service.start(startRequest(), {
    ...sink(emitted),
    failure: (error) => failures.push(error),
  });
  const adapterError = {
    code: "adapter.abi",
    phase: "validation",
    retryable: false,
    message: "The browser and image engine could not exchange a typed message.",
    recovery: [],
  };
  p.worker.receive({ type: "engine.error", error: adapterError });
  await new Promise((resolve) => setTimeout(resolve, 0));
  p.worker.receive({ type: "engine.error", error: adapterError });
  assert.deepEqual(emitted, []);
  assert.deepEqual(failures, [adapterError]);
  assert.equal(p.worker.terminated, true);
});

test("dispose aborts in-flight fetches, terminates the worker, and settles pending work", async () => {
  let sawAbortedSignal = false;
  const logs = [];
  const p = product({
    log: (level, code, detail) => logs.push({ level, code, detail }),
    fetchResource: async (effect, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      sawAbortedSignal = signal.aborted;
      throw new Error("aborted");
    },
  });
  const service = createBrowserJobService(p.deps);
  const emitted = [];
  const handle = await service.start(startRequest(), sink(emitted));
  p.worker.receive(received(snap(1), [TILE]));
  const emittedBeforeDispose = emitted.length;
  await handle.dispose();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(p.worker.terminated, true);
  assert.equal(sawAbortedSignal, true, "in-flight fetch never observed the abort");
  assert.equal(emitted.length, emittedBeforeDispose, "disposed attempt emitted after teardown");
  assert.ok(!logs.some(({ code }) => code === "effect-failed"));
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
      async finalizeOutput() {
        return "browser-save-ready";
      },
      release() {},
    };
  };
  const service = createBrowserJobService(p.deps);
  const handle = await service.start(startRequest(), {
    snapshot: () => {},
    failure: (error) => {
      throw error;
    },
  });
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  const pending = assemblyProcess({ recipe: "none" }, bytes);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const processCall = p.worker.posted.find((message) => message.type === "engine.process");
  assert.ok(processCall, "expected the processing call on the worker");
  assert.equal(p.worker.transfers.flat().length, 1, "processing bytes must transfer, not copy");
  await handle.dispose();
  await assert.rejects(
    () => pending,
    (error) => {
      assert.equal(error.code, "browser.job-settled");
      return true;
    },
  );
});
