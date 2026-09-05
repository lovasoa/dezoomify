import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const scanMod = await loadTs("../../src/background/scan.ts");
const { createScanner, isPrivilegedUrl, SCANNER_STATES } = scanMod;
const reloadMod = await loadTs("../../src/content/reload-marker.ts");

function makeFakeScheduler() {
  let nextId = 1;
  const timers = new Map();
  return {
    timers,
    setTimeout(cb, ms) {
      const id = nextId++;
      timers.set(id, { cb, ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    fireAll() {
      const ids = [...timers.keys()];
      for (const id of ids) {
        const t = timers.get(id);
        if (t) {
          timers.delete(id);
          t.cb();
        }
      }
    },
    count() {
      return timers.size;
    },
  };
}

function makeDeps({ tab = { id: 11, url: "https://a.example/page" }, scheduler } = {}) {
  const order = [];
  let reloadCount = 0;
  let lastTabFilter = null;
  let removed = 0;
  const sched = scheduler ?? makeFakeScheduler();
  return {
    order,
    sched,
    get reloadCount() {
      return reloadCount;
    },
    get lastTabFilter() {
      return lastTabFilter;
    },
    get removed() {
      return removed;
    },
    deps: {
      queryActiveTab: async () => ({ ...tab }),
      addWebRequestListener: (_h, tabId) => {
        order.push("observer");
        lastTabFilter = tabId;
      },
      removeWebRequestListener: () => {
        removed += 1;
      },
      reloadTab: async (tabId) => {
        order.push(`reload:${tabId}`);
        reloadCount += 1;
      },
      scheduler: sched,
    },
  };
}

test("states expose finite machine in order", () => {
  assert.deepEqual([...SCANNER_STATES], ["idle", "arming", "reloading", "observing", "settling", "stopped"]);
});

test("idle attaches nothing; only explicit startScan leaves idle", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  assert.equal(s.getState(), "idle");
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
  assert.equal(f.order.length, 0);
  // extension-page events never leave idle
  for (const kind of ["open", "focus", "reconnect", "navigate"]) {
    const r = s.handleExtensionPageEvent(kind);
    assert.equal(r.reloaded, false);
    assert.equal(r.rearmed, false);
  }
  assert.equal(s.getState(), "idle");
  assert.equal(f.reloadCount, 0);
});

test("privileged URLs rejected with zero observer/reload", async () => {
  for (const url of ["chrome://settings", "about:blank", "file:///etc/passwd", "chrome-extension://abc/page"]) {
    const f = makeDeps({ tab: { id: 7, url } });
    const s = createScanner(f.deps);
    await assert.rejects(() => s.startScan(), /privileged/);
    assert.equal(s.getState(), "stopped");
    assert.equal(f.reloadCount, 0);
    assert.deepEqual(f.order, []);
    assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
  }
  assert.equal(isPrivilegedUrl("https://a.example/x"), false);
  assert.equal(isPrivilegedUrl("http://a.example/x"), false); // http allowed for scans
});

test("observer installed before exactly one reload with exact tab filter", async () => {
  const f = makeDeps({ tab: { id: 11, url: "https://a.example/page" } });
  const s = createScanner(f.deps);
  const out = await s.startScan({ quietMs: 1000, deadlineMs: 5000, finalizeMs: 10 });
  assert.equal(out.tabId, 11);
  assert.deepEqual(f.order, ["observer", "reload:11"]);
  assert.equal(f.reloadCount, 1);
  assert.equal(f.lastTabFilter, 11);
  const snap = s.getSnapshot();
  assert.equal(snap.reloadCount, 1);
  assert.equal(snap.observerInstalledBeforeReload, true);
  assert.equal(snap.tabId, 11);
});

test("only exact active tabId counts; background tab ignored", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan({ quietMs: 1000, deadlineMs: 5000, finalizeMs: 10 });
  s.notifyReloadComplete();
  assert.equal(s.getState(), "observing");
  assert.equal(s.handleRequest(22, "https://b.example/noise.xml"), false);
  assert.equal(s.handleRequest(11, "https://a.example/ImageProperties.xml"), true);
  const snap = s.getSnapshot();
  assert.equal(snap.observedForActiveTab, 1);
  assert.equal(snap.observedForOtherTab, 1);
});

test("quiet settle reaches settling then stopped with zero listeners/timers", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan({ quietMs: 100, deadlineMs: 5000, finalizeMs: 10 });
  s.notifyReloadComplete();
  assert.equal(s.getState(), "observing");
  s._onQuietTimeout();
  assert.equal(s.getState(), "settling");
  // fire finalize timer
  f.sched.fireAll();
  assert.equal(s.getState(), "stopped");
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
});

test("hard deadline terminates with cleanup", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan({ quietMs: 60_000, deadlineMs: 5000, finalizeMs: 10 });
  assert.equal(s.getState(), "reloading");
  s._onDeadline();
  assert.equal(s.getState(), "stopped");
  assert.equal(s.getStopReason(), "deadline");
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
});

test("tab close and navigation stop without stale results", async () => {
  const f1 = makeDeps();
  const s1 = createScanner(f1.deps);
  await s1.startScan();
  assert.equal(s1.handleTabRemoved(11), true);
  assert.equal(s1.getState(), "stopped");
  assert.deepEqual(s1.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });

  const f2 = makeDeps();
  const s2 = createScanner(f2.deps);
  await s2.startScan();
  assert.equal(s2.handleTabUpdated(11), true);
  assert.equal(s2.getState(), "stopped");
  // other-tab close does not stop
  const f3 = makeDeps();
  const s3 = createScanner(f3.deps);
  await s3.startScan();
  assert.equal(s3.handleTabRemoved(99), false);
  assert.notEqual(s3.getState(), "stopped");
});

test("extension-page open/focus/reconnect/restart never reloads or rearms", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan();
  const before = f.reloadCount;
  for (const kind of ["open", "focus", "reconnect", "navigate", "restart-signal"]) {
    const r = s.handleExtensionPageEvent(kind);
    assert.equal(r.reloaded, false);
    assert.equal(r.rearmed, false);
  }
  assert.equal(f.reloadCount, before);
  // worker restart fails closed to idle with no observers
  const r = s.handleWorkerRestart();
  assert.equal(r.state, "idle");
  assert.equal(r.reloaded, false);
  assert.equal(r.rearmed, false);
  assert.equal(s.getState(), "idle");
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
});

test("re-click replaces active generation with cleanup; stopped allows new scan", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  const first = await s.startScan();
  assert.equal(first.generation, 1);
  const second = await s.startScan();
  assert.equal(second.generation, 2);
  // per-scan reload evidence reset: exactly one reload for the new generation
  assert.equal(s.getSnapshot().reloadCount, 1);
  assert.equal(s.getSnapshot().generation, 2);
  // settle then re-click from stopped
  s._onQuietTimeout();
  // need observing first: replacement left us in reloading; move to observing
  // handleRequest moves reloading->observing; then quiet->settling->stopped
  // Force deadline-free settle path:
  s.dispose("test-settle");
  assert.equal(s.getState(), "stopped");
  const third = await s.startScan();
  assert.equal(third.generation, 3);
});

test("terminal dispose removes all listeners/timers", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan();
  s.dispose("test");
  assert.equal(s.getState(), "stopped");
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
  assert.equal(f.sched.count(), 0);
});

test("reload-marker: bounded non-secret generation mark", () => {
  const { createReloadMarker, RELOAD_MARKER_KEY } = reloadMod;
  assert.equal(RELOAD_MARKER_KEY, "dezoomify-reload-generation");
  const mem = new Map();
  const m = createReloadMarker({
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  });
  m.markReload("gen-1");
  assert.equal(m.readReloadMark(), "gen-1");
  m.clearReloadMark();
  assert.equal(m.readReloadMark(), null);
  assert.throws(() => m.markReload("bad gen!"), /bad generation/);
});

test("scan-two-tabs transcript is fixed and minimal", () => {
  const p = new URL("../../../../testdata/scenarios/extension/scan-two-tabs/expected/result.json", import.meta.url);
  assert.equal(existsSync(p), true);
  const doc = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(doc.scenario, "extension/scan-two-tabs");
  assert.equal(doc.expected.reloadCounts["11"], 1);
  assert.equal(doc.expected.reloadCounts["22"], 0);
  assert.equal(doc.expected.listeners.webRequest, 0);
  assert.equal(doc.expected.proxyRequests, 0);
  assert.ok(Array.isArray(doc.transcript) && doc.transcript.length > 0);
});

test("TS source contains finite-machine and security tokens", () => {
  const src = readFileSync(new URL("../../src/background/scan.ts", import.meta.url), "utf8");
  for (const tok of ["idle", "arming", "reloading", "observing", "settling", "stopped", "queryActiveTab", "removeWebRequestListener", "isPrivilegedUrl"]) {
    assert.ok(src.includes(tok), `scan.ts missing ${tok}`);
  }
});
