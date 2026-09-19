import test from "node:test";
import assert from "node:assert/strict";
import {
  createJobQueue,
  createJobService,
  createSnapshotStore,
  initialHostStatus,
  isActiveSnapshot,
  isTerminalSnapshot,
  extensionForSaveFormat,
  safeTitleStem,
  suggestedNameFor,
  renderTransportLabel,
  DIRECT_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
  DISPLAY_TRANSPORT_LABEL,
  BROWSER_SESSION_TRANSPORT_LABEL,
  NATIVE_TRANSPORT_LABEL,
  historyOriginOf,
  toHistoryEntry,
  pushHistory,
  parseHistoryJson,
  loadHistory,
  saveHistory,
  clearHistory,
  HISTORY_MAX,
} from "../packages/app-model/src/index.ts";

function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => {
      map.set(key, String(value));
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

function browserRequest(url = "https://museum.example.org/iiif/1/manifest.json") {
  return { inputs: [{ url }], engine: {}, exec: { kind: "browser", sourceUrl: url } };
}

// ---------------------------------------------------------------------------
// Snapshots: absolute engine projections, predicates read the terminal only
// ---------------------------------------------------------------------------

// Authoritative EngineSnapshotDto builder: the engine owns all job state;
// nothing here folds events or assigns revisions.
function dto(overrides = {}) {
  return {
    revision: 0,
    lifecycle: "Discovering",
    paused: false,
    progress: { completed: 0, total: undefined },
    selection: { image: undefined, level: undefined, level_count: 0, catalog: undefined, deferred: [] },
    decision: undefined,
    terminal: undefined,
    output: undefined,
    ...overrides,
  };
}

test("snapshot predicates read the terminal only", () => {
  const live = dto({ revision: 3, lifecycle: "AcquiringTiles", progress: { completed: 3, total: 12 } });
  assert.ok(isActiveSnapshot(live));
  assert.ok(!isTerminalSnapshot(live));

  const done = dto({ revision: 9, lifecycle: "Completed", terminal: { type: "completed" } });
  assert.ok(isTerminalSnapshot(done));
  assert.ok(!isActiveSnapshot(done));

  const failed = dto({
    revision: 10,
    lifecycle: "Failed",
    terminal: {
      type: "failed",
      error: { code: "boom", phase: "decode", retryable: false, message: "boom", recovery: [] },
    },
  });
  assert.ok(isTerminalSnapshot(failed));
  assert.equal(failed.terminal.error.code, "boom");
});

// ---------------------------------------------------------------------------
// Store: single latest-snapshot cell, no guards
// ---------------------------------------------------------------------------

test("snapshot store holds the latest snapshot verbatim", () => {
  const store = createSnapshotStore();
  assert.equal(store.get(), undefined);
  const first = dto({ revision: 3 });
  store.set(first);
  assert.equal(store.get().revision, 3);
  // No revision guards here: stale revisions are dropped at the transport
  // edge (the runner) before they ever reach this cell.
  store.set(dto({ revision: 1 }));
  assert.equal(store.get().revision, 1);
  let notified = 0;
  const unsubscribe = store.subscribe(() => {
    notified += 1;
  });
  store.set(dto({ revision: 2 }));
  assert.equal(notified, 1);
  unsubscribe();
  store.clear();
  assert.equal(store.get(), undefined);
  assert.equal(typeof store.getSnapshot(), "function");
  assert.equal(store.getSnapshot()(), undefined);
});

// ---------------------------------------------------------------------------
// Service: async subscription boundary
// ---------------------------------------------------------------------------

function fakeRunner(log) {
  const runners = [];
  return {
    runners,
    runner: {
      start(request, sink) {
        const index = runners.length;
        const record = { request, sink, commands: [], disposed: false };
        runners.push(record);
        log.push(`start:${index}`);
        return Promise.resolve({
          command: (cmd) => {
            record.commands.push(cmd);
            return Promise.resolve();
          },
          dispose: () => {
            record.disposed = true;
            return Promise.resolve();
          },
        });
      },
    },
  };
}

test("service routes absolute snapshots to the owning observer only", async () => {
  const log = [];
  const { runner, runners } = fakeRunner(log);
  const service = createJobService(runner);
  const seenA = [];
  const seenB = [];
  const statusA = [];
  const handleA = await service.start(browserRequest("https://a.example.org/1"), {
    snapshot: (s) => seenA.push(s),
    hostStatus: (s) => statusA.push(s),
  });
  const handleB = await service.start(browserRequest("https://b.example.org/2"), {
    snapshot: (s) => seenB.push(s),
    hostStatus: () => {},
  });
  assert.notEqual(handleA.id, handleB.id);
  assert.equal(log.join(","), "start:0,start:1");

  runners[0].sink.snapshot(
    dto({ revision: 1, lifecycle: "AcquiringTiles", progress: { completed: 1, total: 4 } }),
    initialHostStatus(),
  );
  runners[1].sink.snapshot(
    dto({ revision: 1, lifecycle: "AcquiringTiles", progress: { completed: 2, total: 8 } }),
    initialHostStatus(),
  );
  assert.equal(seenA[seenA.length - 1].progress.completed, 1);
  assert.equal(seenB[seenB.length - 1].progress.completed, 2);
  // One neutral status on start plus the runner-forwarded one.
  assert.equal(statusA.length, 2);

  await handleA.command({ type: "cancel" });
  assert.deepEqual(runners[0].commands, [{ type: "cancel" }]);

  // Dispose delegates to the runner handle; late emissions after teardown
  // stay invisible because the runner drops them at its edge.
  await handleA.dispose();
  assert.ok(runners[0].disposed);
});

test("service rejects invalid requests with stable validation codes", async () => {
  const { runner } = fakeRunner([]);
  const service = createJobService(runner);
  const observer = { snapshot: () => {}, hostStatus: () => {} };
  await assert.rejects(service.start({ inputs: [], engine: {}, exec: { kind: "browser", sourceUrl: "https://x.example.org/y" } }, observer).then(
    () => {
      throw new Error("should reject");
    },
    (error) => {
      assert.equal(error.code, "validation.empty-inputs");
      throw error;
    },
  ));
  await assert.rejects(
    service.start({ inputs: [{ url: "ftp://x/y" }], engine: {}, exec: { kind: "mars" } }, observer),
    /./,
  );
  await assert.rejects(
    service.start(
      { inputs: [{ url: "https://x.example.org/y" }], engine: {}, exec: { kind: "browser" } },
      observer,
    ),
    (error) => error.code === "validation.bad-exec-source",
  );
});

// ---------------------------------------------------------------------------
// Queue: sequential, isolated failures, cancel/retry
// ---------------------------------------------------------------------------

test("queue runs sequentially and isolates failures", async () => {
  const started = [];
  const terminals = new Map();
  const service = {
    start(request, observer) {
      const index = started.length;
      started.push(request.inputs[0].url);
      const emit = (event) => observer.snapshot(event);
      terminals.set(index, emit);
      return Promise.resolve({ command: () => Promise.resolve(), dispose: () => Promise.resolve() });
    },
  };
  const queue = createJobQueue(service);
  const h1 = queue.enqueue(browserRequest("https://q.example.org/1"));
  const h2 = queue.enqueue(browserRequest("https://q.example.org/2"));
  const h3 = queue.enqueue(browserRequest("https://q.example.org/3"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["https://q.example.org/1"]);

  // Fail the first job: the queue retains it and moves on.
  terminals.get(0)(dto({
    revision: 1,
    lifecycle: "Failed",
    terminal: {
      type: "failed",
      error: { code: "boom", phase: "acquisition", retryable: true, message: "b", recovery: [] },
    },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, ["https://q.example.org/1", "https://q.example.org/2"]);
  const entries = queue.entries();
  assert.equal(entries[0].status, "failed");
  assert.equal(entries[1].status, "active");

  // Cancel the third while queued; retry the first.
  h3.cancel();
  assert.equal(queue.entries()[2].status, "cancelled");
  h1.retry();
  assert.equal(queue.entries()[0].status, "queued");

  // Finish the second; the retried first runs next (FIFO: retry goes to back).
  terminals.get(1)(dto({
    revision: 1,
    lifecycle: "Completed",
    progress: { completed: 4, total: 4 },
    terminal: { type: "completed" },
    output: { canvas: undefined, format: "png", complete: true, missing: [], disposition: undefined },
  }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started[started.length - 1], "https://q.example.org/1");

  queue.cancelAll();
  await queue.dispose();
  void h2;
});

// ---------------------------------------------------------------------------
// History ledger
// ---------------------------------------------------------------------------

test("history keeps full addresses with origins, capped and fail-closed", () => {
  assert.equal(historyOriginOf("https://museum.example.org/painting/1?view=2#frag"), "https://museum.example.org");
  assert.equal(historyOriginOf("http://host:8080/a"), "http://host:8080");
  assert.equal(historyOriginOf("file:///tmp/a"), "");
  const entry = toHistoryEntry("https://museum.example.org/a", { width: 100, height: 50, format: "PNG", at: 42 });
  assert.equal(entry.url, "https://museum.example.org/a");
  assert.equal(entry.at, 42);
  assert.equal(toHistoryEntry("not a url", {}), null);
  let list = [];
  for (let n = 0; n < HISTORY_MAX + 5; n++) {
    list = pushHistory(list, { origin: "https://x.example.org", url: `https://x.example.org/${n}`, at: n });
  }
  assert.equal(list.length, HISTORY_MAX);
  assert.equal(list[0].url, `https://x.example.org/${HISTORY_MAX + 4}`);
  assert.deepEqual(parseHistoryJson("garbage"), []);
  const store = memoryStore();
  saveHistory(store, "k", list);
  assert.equal(loadHistory(store, "k").length, HISTORY_MAX);
  clearHistory(store, "k");
  assert.deepEqual(loadHistory(store, "k"), []);
});

// ---------------------------------------------------------------------------
// Labels and save names
// ---------------------------------------------------------------------------

test("labels and save names match the canonical values", () => {
  assert.equal(DIRECT_TRANSPORT_LABEL, "Direct from your browser");
  assert.equal(PROXY_TRANSPORT_LABEL, "Metadata proxy");
  assert.equal(DISPLAY_TRANSPORT_LABEL, "Display only");
  assert.equal(BROWSER_SESSION_TRANSPORT_LABEL, "Browser session");
  assert.equal(NATIVE_TRANSPORT_LABEL, "Native");
  assert.equal(renderTransportLabel("direct"), "Direct from your browser");
  assert.equal(renderTransportLabel("metadata-proxy"), "Metadata proxy");
  assert.equal(renderTransportLabel("display-only"), "Display only");
  assert.equal(renderTransportLabel("browser-session"), "Browser session");
  assert.equal(renderTransportLabel("native"), "Native");
  assert.equal(renderTransportLabel("mystery"), "mystery");
  assert.equal(suggestedNameFor(800, 600, "png"), "dezoomify-800x600.png");
  assert.equal(suggestedNameFor(800, 600, "jpeg"), "dezoomify-800x600.jpg");
  assert.equal(suggestedNameFor(800, 600, "iiif-dir"), "dezoomify-800x600.iiif");
  assert.equal(suggestedNameFor(800, 600, "png", "Portrait: Étude"), "Portrait_ Étude.png");
  assert.equal(suggestedNameFor(800, 600, "png", "CON"), "dezoomify-800x600.png");
  assert.equal(safeTitleStem("A" + String.fromCharCode(0) + "B"), "A_B");
  assert.equal(extensionForSaveFormat("iiif"), "iiif");
});
