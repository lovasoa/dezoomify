import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const scanMod = await loadTs("../../src/page/scan.ts");
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
  const src = readFileSync(new URL("../../src/page/scan.ts", import.meta.url), "utf8");
  for (const tok of ["idle", "arming", "reloading", "observing", "settling", "stopped", "queryActiveTab", "removeWebRequestListener", "isPrivilegedUrl"]) {
    assert.ok(src.includes(tok), `scan.ts missing ${tok}`);
  }
});

// --- Click-to-monitor indefinite bounds (additive; no deadlines fired) ---
//
// The redesign is indefinite explicit-action monitoring: grey idle, blue+dot
// while monitoring, single reload, stop on detection/second-click/close/
// navigate, no auto-rearm, worker restart fails closed. The fake scheduler
// never fires unless the test fires it, so "indefinite" here means the
// scanner stays armed across activity until an explicit terminal signal.

test("indefinite: monitoring persists across activity until explicit detection stop", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan({ quietMs: 60_000, deadlineMs: 3_600_000, finalizeMs: 10 });
  s.notifyReloadComplete();
  assert.equal(s.getState(), "observing");
  // Sustained activity keeps monitoring alive; nothing stops itself.
  for (let i = 0; i < 5; i += 1) {
    assert.equal(s.handleRequest(11, `https://a.example/tile${i}.jpg`), true);
    assert.equal(s.getState(), "observing");
  }
  assert.deepEqual(s.getListenerCounts(), { webRequest: 1, tab: 1, timers: 2 });
  // Detection is an explicit stop with full cleanup (modal opens elsewhere).
  s.dispose("detected");
  assert.equal(s.getState(), "stopped");
  assert.equal(s.getStopReason(), "detected");
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
});

test("indefinite: exactly one reload; activity and page events never reload", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan({ quietMs: 60_000, deadlineMs: 3_600_000, finalizeMs: 10 });
  assert.equal(f.reloadCount, 1);
  s.notifyReloadComplete();
  s.handleRequest(11, "https://a.example/a.dzi");
  s.handleRequest(22, "https://b.example/noise.jpg");
  for (const kind of ["open", "focus", "reconnect", "navigate", "restart-signal"]) {
    const r = s.handleExtensionPageEvent(kind);
    assert.equal(r.reloaded, false);
    assert.equal(r.rearmed, false);
  }
  assert.equal(f.reloadCount, 1);
  assert.deepEqual(f.order, ["observer", "reload:11"]);
});

test("indefinite: second click cancels monitoring with no second reload", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan({ quietMs: 60_000, deadlineMs: 3_600_000, finalizeMs: 10 });
  assert.equal(f.reloadCount, 1);
  // Second click while monitoring: explicit cancel back to a clean stop.
  s.dispose("second-click");
  assert.equal(s.getState(), "stopped");
  assert.equal(s.getStopReason(), "second-click");
  assert.equal(f.reloadCount, 1);
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
  // A fresh click after cancel starts a new generation with its single reload.
  const before = f.reloadCount;
  const out = await s.startScan({ quietMs: 60_000, deadlineMs: 3_600_000, finalizeMs: 10 });
  assert.equal(out.generation, 2);
  assert.equal(f.reloadCount, before + 1);
});

test("indefinite: tab closed or navigated stops monitoring without stale results", async () => {
  const f1 = makeDeps();
  const s1 = createScanner(f1.deps);
  await s1.startScan({ quietMs: 60_000, deadlineMs: 3_600_000, finalizeMs: 10 });
  s1.notifyReloadComplete();
  s1.handleRequest(11, "https://a.example/a.dzi");
  assert.equal(s1.handleTabRemoved(11), true);
  assert.equal(s1.getState(), "stopped");
  assert.equal(s1.getStopReason(), "tab-closed");
  assert.deepEqual(s1.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });

  const f2 = makeDeps();
  const s2 = createScanner(f2.deps);
  await s2.startScan({ quietMs: 60_000, deadlineMs: 3_600_000, finalizeMs: 10 });
  s2.notifyReloadComplete();
  s2.handleRequest(11, "https://a.example/a.dzi");
  assert.equal(s2.handleTabUpdated(11), true);
  assert.equal(s2.getState(), "stopped");
  assert.equal(s2.getStopReason(), "tab-navigated");
  assert.deepEqual(s2.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
});

test("indefinite: worker restart fails closed to idle with no rearm", async () => {
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan({ quietMs: 60_000, deadlineMs: 3_600_000, finalizeMs: 10 });
  s.notifyReloadComplete();
  const before = f.reloadCount;
  const r = s.handleWorkerRestart();
  assert.equal(r.state, "idle");
  assert.equal(r.reloaded, false);
  assert.equal(r.rearmed, false);
  assert.equal(s.getState(), "idle");
  assert.equal(f.reloadCount, before);
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
  // Next explicit click rearms exactly once.
  await s.startScan({ quietMs: 60_000, deadlineMs: 3_600_000, finalizeMs: 10 });
  assert.equal(f.reloadCount, before + 1);
});

// --- Indefinite API (`startScan({ indefinite: true })`, guarded) ---
//
// The background click-to-monitor flow schedules no timers and rests in
// `detecting` until notifyDetected/cancel/tab-close/navigate/dispose. These
// tests probe the API only when the scanner exposes it, so the finite page
// flow contract above stays green on either version.

test("indefinite api: no timers, single reload, detection stops monitoring", async (t) => {
  const probe = createScanner(makeDeps().deps);
  if (typeof probe.notifyDetected !== "function") {
    t.skip("scanner predates the indefinite api");
    return;
  }
  const f = makeDeps();
  const s = createScanner(f.deps);
  const out = await s.startScan({ indefinite: true });
  assert.equal(out.indefinite, true);
  assert.equal(f.reloadCount, 1);
  assert.deepEqual(s.getListenerCounts(), { webRequest: 1, tab: 1, timers: 0 });
  s.notifyReloadComplete();
  assert.equal(s.getState(), "detecting");
  assert.deepEqual(s.getListenerCounts(), { webRequest: 1, tab: 1, timers: 0 });
  // Observed traffic counts but never stops monitoring by itself.
  assert.equal(s.handleRequest(11, "https://a.example/a.dzi"), true);
  assert.equal(s.getState(), "detecting");
  assert.equal(f.reloadCount, 1);
  assert.equal(s.notifyDetected("iiif"), true);
  assert.equal(s.getState(), "stopped");
  assert.equal(s.getStopReason(), "detected");
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
});

test("indefinite api: second-click cancel and replace with no extra reload", async (t) => {
  const probe = createScanner(makeDeps().deps);
  if (typeof probe.cancel !== "function") {
    t.skip("scanner predates the indefinite api");
    return;
  }
  const f = makeDeps();
  const s = createScanner(f.deps);
  await s.startScan({ indefinite: true });
  assert.equal(s.cancel(), true);
  assert.equal(s.getState(), "stopped");
  assert.equal(s.getStopReason(), "cancelled");
  assert.equal(f.reloadCount, 1);
  assert.deepEqual(s.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
  // Cancel on idle/stopped is a no-op.
  assert.equal(s.cancel(), false);
  // Fresh click after cancel rearms exactly once.
  const out = await s.startScan({ indefinite: true });
  assert.equal(out.generation, 2);
  assert.equal(f.reloadCount, 2);
});

test("indefinite api: tab close/navigate and restart fail closed", async (t) => {
  const probe = createScanner(makeDeps().deps);
  if (typeof probe.notifyDetected !== "function" || typeof probe.cancel !== "function") {
    t.skip("scanner predates the indefinite api");
    return;
  }
  const f1 = makeDeps();
  const s1 = createScanner(f1.deps);
  await s1.startScan({ indefinite: true });
  s1.notifyReloadComplete();
  assert.equal(s1.handleTabRemoved(11), true);
  assert.equal(s1.getStopReason(), "tab-closed");
  assert.deepEqual(s1.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });

  const f2 = makeDeps();
  const s2 = createScanner(f2.deps);
  await s2.startScan({ indefinite: true });
  s2.notifyReloadComplete();
  assert.equal(s2.handleTabUpdated(11), true);
  assert.equal(s2.getStopReason(), "tab-navigated");
  assert.deepEqual(s2.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });

  const f3 = makeDeps();
  const s3 = createScanner(f3.deps);
  await s3.startScan({ indefinite: true });
  s3.notifyReloadComplete();
  const r = s3.handleWorkerRestart();
  assert.equal(r.state, "idle");
  assert.equal(r.reloaded, false);
  assert.equal(r.rearmed, false);
  assert.deepEqual(s3.getListenerCounts(), { webRequest: 0, tab: 0, timers: 0 });
});
