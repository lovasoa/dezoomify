import test from "node:test";
import assert from "node:assert/strict";
import {
  applyJobEvent,
  createJobQueue,
  createJobService,
  createSnapshotStore,
  initialHostStatus,
  initialSnapshot,
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
// Snapshot fold
// ---------------------------------------------------------------------------

test("snapshot fold walks a full job deterministically", () => {
  let now = 1000;
  const tick = () => (now += 10);
  let snap = initialSnapshot("job:1", tick());
  assert.equal(snap.state, "Created");
  assert.equal(snap.revision, 0);
  assert.ok(isActiveSnapshot(snap));

  snap = applyJobEvent(snap, { type: "job-state", state: "Discovering" }, tick());
  assert.equal(snap.state, "Discovering");
  assert.equal(snap.revision, 1);

  const catalog = {
    entries: [
      {
        kind: "image",
        title: "Altarpiece",
        format: "IIIF",
        width: 8000,
        height: 6000,
        sourceKind: "iiif",
        levels: [{ label: "full", width: 8000, height: 6000, tileWidth: 512, tileHeight: 512 }],
      },
    ],
  };
  snap = applyJobEvent(snap, { type: "catalog", catalog }, tick());
  assert.equal(snap.catalog.entries.length, 1);

  snap = applyJobEvent(snap, { type: "progress", acquired: 3, total: 12 }, tick());
  assert.equal(snap.acquired, 3);
  assert.equal(snap.total, 12);

  snap = applyJobEvent(snap, { type: "paused" }, tick());
  assert.equal(snap.paused, true);
  assert.equal(snap.acquired, 3);
  snap = applyJobEvent(snap, { type: "resumed" }, tick());
  assert.equal(snap.paused, false);

  snap = applyJobEvent(snap, { type: "progress", acquired: 12, total: 12 }, tick());
  snap = applyJobEvent(snap, { type: "completed" }, tick());
  assert.equal(snap.state, "Completed");
  assert.ok(isTerminalSnapshot(snap));
  assert.deepEqual(snap.terminal, { kind: "completed" });
  assert.equal(snap.output.doneTiles, 12);
  assert.equal(snap.output.partial, false);
});

test("snapshot fold keeps warnings bounded and records recovery", () => {
  let snap = initialSnapshot("job:w", 0);
  const warn = (n) => ({
    type: "warning",
    error: { code: `w${n}`, phase: "acquisition", retryable: true, message: `w${n}`, recovery: [] },
  });
  for (let n = 0; n < 25; n++) snap = applyJobEvent(snap, warn(n), n);
  assert.equal(snap.warnings.length, 20);
  assert.equal(snap.warnings[0].code, "w5");

  snap = applyJobEvent(
    snap,
    { type: "recovery-request", generation: 7, actions: [{ id: "a", kind: "retry", scope: "tile", rationale: "r" }] },
    99,
  );
  assert.equal(snap.state, "AwaitingPartialDecision");
  assert.equal(snap.recovery.generation, 7);

  snap = applyJobEvent(
    snap,
    { type: "failed", error: { code: "boom", phase: "decode", retryable: false, message: "boom", recovery: [] } },
    100,
  );
  assert.equal(snap.state, "Failed");
  assert.equal(snap.terminal.error.code, "boom");
  assert.equal(snap.output, null);
});

// ---------------------------------------------------------------------------
// Store: identity + revision guards
// ---------------------------------------------------------------------------

test("snapshot store keeps the newest revision per job", () => {
  const store = createSnapshotStore();
  assert.equal(store.get("job:1"), undefined);
  const first = { ...initialSnapshot("job:1", 1), revision: 3 };
  store.publish(first);
  assert.equal(store.get("job:1").revision, 3);
  // Stale revisions never move the UI.
  store.publish({ ...first, revision: 1 });
  assert.equal(store.get("job:1").revision, 3);
  store.publish({ ...first, revision: 4 });
  assert.equal(store.get("job:1").revision, 4);
  store.remove("job:1");
  assert.equal(store.get("job:1"), undefined);
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

test("service routes interleaved emissions to the owning observer only", async () => {
  const log = [];
  const { runner, runners } = fakeRunner(log);
  let now = 0;
  const service = createJobService(runner, { now: () => ++now });
  const seenA = [];
  const seenB = [];
  const handleA = await service.start(browserRequest("https://a.example.org/1"), {
    snapshot: (s) => seenA.push(s),
    hostStatus: () => {},
  });
  const handleB = await service.start(browserRequest("https://b.example.org/2"), {
    snapshot: (s) => seenB.push(s),
    hostStatus: () => {},
  });
  assert.notEqual(handleA.id, handleB.id);
  assert.equal(log.join(","), "start:0,start:1");

  runners[0].sink.event({ type: "progress", acquired: 1, total: 4 }, initialHostStatus());
  runners[1].sink.event({ type: "progress", acquired: 2, total: 8 }, initialHostStatus());
  assert.equal(seenA[seenA.length - 1].acquired, 1);
  assert.equal(seenB[seenB.length - 1].acquired, 2);
  assert.equal(seenA[seenA.length - 1].jobId, handleA.id);

  await handleA.command({ type: "cancel" });
  assert.deepEqual(runners[0].commands, [{ type: "cancel" }]);

  await handleA.dispose();
  runners[0].sink.event({ type: "progress", acquired: 4, total: 4 }, initialHostStatus());
  assert.equal(seenA[seenA.length - 1].acquired, 1);
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
  terminals.get(0)({
    jobId: "queue:1",
    revision: 1,
    state: "Failed",
    catalog: null,
    acquired: 0,
    total: 4,
    paused: false,
    selection: { image: null, level: null },
    warnings: [],
    recovery: null,
    terminal: { kind: "failed", error: { code: "boom", phase: "acquisition", retryable: true, message: "b", recovery: [] } },
    output: null,
    displayOnly: false,
    updatedAt: 1,
  });
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
  terminals.get(1)({
    jobId: "queue:2",
    revision: 1,
    state: "Completed",
    catalog: null,
    acquired: 4,
    total: 4,
    paused: false,
    selection: { image: null, level: null },
    warnings: [],
    recovery: null,
    terminal: { kind: "completed" },
    output: { doneTiles: 4, totalTiles: 4, failedTiles: 0, partial: false, format: null, width: null, height: null, missingTiles: [] },
    displayOnly: false,
    updatedAt: 2,
  });
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
