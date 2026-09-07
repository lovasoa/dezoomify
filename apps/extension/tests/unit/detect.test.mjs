import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const detect = await loadTs("../../src/background/detect.ts");
const candidates = await loadTs("../../src/page/candidates.ts");
const fetchMod = await loadTs("../../src/page/fetch.ts");
const reloadMod = await loadTs("../../src/content/reload-marker.ts");

const {
  createDetectionMonitor,
  rankDetectionUrls,
  validateDetectionUrl,
  redactUrlForLabel,
  isProxyUrl,
  generationMarkFor,
  MAX_URL_LENGTH,
  MAX_CANDIDATES,
  PROXY_PATH,
} = detect;

// --- Caps and mirrors (parity with the page scan, never drift) ---

test("caps mirror the page candidate store (2048 / 100)", () => {
  assert.equal(MAX_URL_LENGTH, 2048);
  assert.equal(MAX_CANDIDATES, 100);
  assert.equal(MAX_URL_LENGTH, candidates.MAX_URL_LENGTH);
  assert.equal(MAX_CANDIDATES, candidates.MAX_CANDIDATES);
});

test("sensitive query keys match candidates.ts and redaction.ts (no drift)", () => {
  const extract = (src) => {
    const m = src.match(/SENSITIVE_QUERY_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    assert.ok(m, "SENSITIVE_QUERY_KEYS list found");
    return JSON.stringify([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  };
  const files = [
    "../../src/background/detect.ts",
    "../../src/page/candidates.ts",
    "../../src/page/redaction.ts",
  ];
  const lists = files.map((rel) => extract(readFileSync(new URL(rel, import.meta.url), "utf8")));
  for (const list of lists) assert.equal(list, lists[0], "sensitive key lists must stay identical");
});

test("proxy path mirrors fetch.ts; proxy URLs rejected as proxy-forbidden", () => {
  assert.equal(PROXY_PATH, fetchMod.PROXY_PATH);
  assert.equal(isProxyUrl("https://site.example/api/proxy?u=1"), fetchMod.isProxyUrl("https://site.example/api/proxy?u=1"));
  assert.equal(isProxyUrl("https://a.example/img.jpg"), false);
  assert.equal(validateDetectionUrl("https://site.example/api/proxy?u=1").code, "proxy-forbidden");
});

test("redactUrlForLabel behaves identically to the page mirror", () => {
  const battery = [
    "https://user:pass@a.example/img.dzi?token=SECRET&view=1#frag",
    "https://a.example/x?ApiKey=abc&lang=en",
    "https://a.example/plain.jpg",
    "not a url",
    "https://a.example/has%20space?q=1",
  ];
  for (const url of battery) {
    assert.equal(redactUrlForLabel(url), candidates.redactUrlForLabel(url), `redact drift for ${url}`);
  }
  const label = redactUrlForLabel("https://user:pass@a.example/img.dzi?token=SECRET&view=1#frag");
  assert.ok(!label.includes("SECRET") && label.includes("***") && label.includes("view=1"));
});

// --- Collection: explicit action, exact tab, first window, no format guesses ---

test("idle collects nothing; only explicit startMonitoring arms one tab", async () => {
  const m = createDetectionMonitor();
  assert.equal(m.getState(), "idle");
  assert.equal(m.handleRequest(11, "https://a.example/info.json"), false);
  assert.equal(await m.rankNow(), null);
  const armed = m.startMonitoring(11);
  assert.deepEqual(armed, { tabId: 11, generation: 1, generationMark: "gen-1" });
  assert.equal(m.getState(), "monitoring");
});

test("startMonitoring rejects bad tab ids; re-click bumps generation and clears", () => {
  const m = createDetectionMonitor();
  assert.throws(() => m.startMonitoring("11"), /bad tab id/);
  m.startMonitoring(11);
  m.handleRequest(11, "https://a.example/a.dzi");
  const second = m.startMonitoring(11);
  assert.equal(second.generation, 2);
  assert.equal(second.generationMark, "gen-2");
  assert.deepEqual(m.urls(), []);
});

test("only the exact armed tab counts; others ignored", () => {
  const m = createDetectionMonitor();
  m.startMonitoring(11);
  assert.equal(m.handleRequest(22, "https://b.example/noise.xml"), false);
  assert.equal(m.handleRequest(11, "https://a.example/info.json"), true);
  assert.deepEqual(m.urls(), ["https://a.example/info.json"]);
});

test("invalid, overlong, non-http, and proxy URLs never collect", () => {
  const m = createDetectionMonitor();
  m.startMonitoring(11);
  assert.equal(validateDetectionUrl("ftp://a.example/x").code, "unsupported-scheme");
  assert.equal(validateDetectionUrl("https://a.example/" + "x".repeat(3000)).code, "too-long");
  for (const u of ["not a url", "ftp://a.example/x", "data:text/plain,hi", "chrome://settings", "", "https://s.example/api/proxy?u=1"]) {
    assert.equal(m.handleRequest(11, u), false, u);
  }
  assert.deepEqual(m.urls(), []);
});

test("first-seen dedup; first window kept, overflow rejected without eviction", () => {
  const m = createDetectionMonitor();
  m.startMonitoring(11);
  assert.equal(m.handleRequest(11, "https://a.example/a.dzi"), true);
  assert.equal(m.handleRequest(11, "https://a.example/a.dzi"), false);
  for (let i = 0; i < MAX_CANDIDATES - 1; i += 1) {
    assert.equal(m.handleRequest(11, `https://a.example/fill${i}.dzi`), true);
  }
  assert.equal(m.urls().length, MAX_CANDIDATES);
  const first = m.urls()[0];
  assert.equal(first, "https://a.example/a.dzi");
  for (let i = 0; i < 5; i += 1) {
    assert.equal(m.handleRequest(11, `https://a.example/overflow${i}.dzi`), false);
  }
  assert.equal(m.urls()[0], first);
  assert.equal(m.urls().length, MAX_CANDIDATES);
});

test("collection never guesses formats: fallback rank yields format null even for obvious names", async () => {
  const seen = [];
  const m = createDetectionMonitor({ onDetected: (e) => void seen.push(e) });
  m.startMonitoring(11);
  m.handleRequest(11, "https://a.example/ImageProperties.xml");
  m.handleRequest(11, "https://tiles.example/iiif/image/info.json");
  const event = await m.rankNow();
  assert.equal(event.format, null);
  assert.equal(seen.length, 1);
});

// --- Rank: wasm batch with first-seen fallback (page.ts rankUrls pattern) ---

test("rankDetectionUrls falls back to first-seen order when the export is missing", () => {
  const urls = ["https://a.example/b", "https://a.example/a"];
  assert.deepEqual(rankDetectionUrls(urls, {}), [
    { url: "https://a.example/b", format: null },
    { url: "https://a.example/a", format: null },
  ]);
  assert.deepEqual(rankDetectionUrls(urls), [
    { url: "https://a.example/b", format: null },
    { url: "https://a.example/a", format: null },
  ]);
});

test("rankDetectionUrls falls back when wasm throws or returns malformed shapes", () => {
  const urls = ["https://a.example/b", "https://a.example/a"];
  const throwing = { rankCandidates: () => { throw new Error("boom"); } };
  assert.deepEqual(rankDetectionUrls(urls, throwing).map((e) => e.url), urls);
  for (const bad of ['{"not":"array"}', '"str"', '[{"no-url": true}]', '[[1]]']) {
    const mod = { rankCandidates: () => bad };
    assert.deepEqual(rankDetectionUrls(urls, mod).map((e) => e.url), urls, bad);
  }
});

test("rankDetectionUrls respects core order and passes entries through", () => {
  const ranked = [
    { url: "https://a.example/TileGroup0/0-0-0.jpg", format: "zoomify" },
    { url: "https://a.example/info.json", format: "iiif" },
    { url: "https://a.example/unknown", format: null },
  ];
  const wasm = { rankCandidates: (json) => JSON.stringify([...JSON.parse(json)].sort().map((u) => ranked.find((r) => r.url === u) ?? { url: u, format: null })) };
  const out = rankDetectionUrls(ranked.map((r) => r.url).reverse(), wasm);
  assert.deepEqual(out.map((e) => e.url), ranked.map((r) => r.url).sort());
  assert.equal(out.find((e) => e.format === "zoomify").url, "https://a.example/TileGroup0/0-0-0.jpg");
});

// --- Detected event: shape, confirm, stale-tab suppression ---

test("detected event carries candidateUrl, format, tabId, generation", async () => {
  const seen = [];
  const wasm = {
    rankCandidates: (json) => JSON.stringify(
      JSON.parse(json).map((url) => ({ url, format: url.endsWith("info.json") ? "iiif" : null })),
    ),
  };
  const m = createDetectionMonitor({ wasmExports: wasm, onDetected: (e) => void seen.push(e) });
  m.startMonitoring(7);
  m.handleRequest(7, "https://a.example/plain.jpg");
  m.handleRequest(7, "https://a.example/info.json");
  const event = await m.rankNow();
  assert.deepEqual(Object.keys(event).sort(), ["candidateUrl", "format", "generation", "tabId"]);
  assert.equal(event.tabId, 7);
  assert.equal(event.generation, 1);
  assert.equal(typeof event.candidateUrl, "string");
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], event);
});

test("rankBatch rejection still emits first-seen fallback (never loses the window)", async () => {
  const seen = [];
  const m = createDetectionMonitor({
    rankBatch: () => Promise.reject(new Error("wasm suspended")),
    onDetected: (e) => void seen.push(e),
  });
  m.startMonitoring(11);
  m.handleRequest(11, "https://a.example/first.dzi");
  const event = await m.rankNow();
  assert.equal(event.candidateUrl, "https://a.example/first.dzi");
  assert.equal(event.format, null);
  assert.equal(seen.length, 1);
});

test("in-flight batch dropped as stale after a generation bump (no stale-tab results)", async () => {
  const seen = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const m = createDetectionMonitor({
    rankBatch: async (urls) => {
      await gate;
      return urls.map((url) => ({ url, format: "iiif" }));
    },
    onDetected: (e) => void seen.push(e),
  });
  m.startMonitoring(11);
  m.handleRequest(11, "https://a.example/gen1.json");
  const pending = m.rankNow();
  m.startMonitoring(11); // generation 2 clears the window mid-flight
  release();
  assert.equal(await pending, null);
  assert.equal(seen.length, 0);
});

test("stop during ranking drops the batch; tab close/navigate stop with no results", async () => {
  const seen = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const m = createDetectionMonitor({
    rankBatch: async (urls) => {
      await gate;
      return urls.map((url) => ({ url, format: "iiif" }));
    },
    onDetected: (e) => void seen.push(e),
  });
  m.startMonitoring(11);
  m.handleRequest(11, "https://a.example/a.json");
  const pending = m.rankNow();
  m.stop("second-click");
  release();
  assert.equal(await pending, null);
  assert.equal(m.getState(), "stopped");

  const m2 = createDetectionMonitor({ onDetected: (e) => void seen.push(e) });
  m2.startMonitoring(11);
  m2.handleRequest(11, "https://a.example/a.json");
  assert.equal(m2.handleTabRemoved(99), false);
  assert.equal(m2.handleTabRemoved(11), true);
  assert.equal(m2.getState(), "stopped");
  assert.equal(await m2.rankNow(), null);

  const m3 = createDetectionMonitor({ onDetected: (e) => void seen.push(e) });
  m3.startMonitoring(11);
  m3.handleRequest(11, "https://a.example/a.json");
  assert.equal(m3.handleTabUpdated(99), false);
  assert.equal(m3.handleTabUpdated(11), true);
  assert.equal(await m3.rankNow(), null);
  assert.equal(seen.length, 0);
});

test("confirm skips ranked entries outside the window or failing validation", async () => {
  const seen = [];
  const m = createDetectionMonitor({
    rankBatch: () => [
      { url: "https://evil.example/not-collected.json", format: "iiif" },
      { url: 42, format: "iiif" },
      { url: "https://a.example/real.json", format: "iiif" },
    ],
    onDetected: (e) => void seen.push(e),
  });
  m.startMonitoring(11);
  m.handleRequest(11, "https://a.example/real.json");
  const event = await m.rankNow();
  assert.equal(event.candidateUrl, "https://a.example/real.json");
  assert.equal(seen.length, 1);
});

test("empty window ranks to null with no event", async () => {
  let calls = 0;
  const m = createDetectionMonitor({ onDetected: () => { calls += 1; } });
  m.startMonitoring(11);
  assert.equal(await m.rankNow(), null);
  assert.equal(calls, 0);
});

// --- Generation correlation with the reload marker; redacted logs ---

test("generation marks correlate with the reload-marker store", () => {
  assert.equal(generationMarkFor(1), "gen-1");
  const mem = new Map();
  const marker = reloadMod.createReloadMarker({
    getItem: (k) => mem.get(k) ?? null,
    setItem: (k, v) => void mem.set(k, v),
    removeItem: (k) => void mem.delete(k),
  });
  const m = createDetectionMonitor();
  const armed = m.startMonitoring(11);
  marker.markReload(armed.generationMark);
  assert.equal(m.correlateReloadMark(marker.readReloadMark()), true);
  assert.equal(m.correlateReloadMark("gen-999"), false);
  m.startMonitoring(11); // generation 2: the old mark is stale
  assert.equal(m.correlateReloadMark("gen-1"), false);
  m.stop("done");
  marker.markReload("gen-2");
  assert.equal(m.correlateReloadMark(marker.readReloadMark()), false);
});

test("logs and labels never carry credentials or fragments", async () => {
  const lines = [];
  const secret = "tok-SECRET-99";
  const m = createDetectionMonitor({ log: (line) => void lines.push(line) });
  m.startMonitoring(11);
  m.handleRequest(11, `https://user:pass@a.example/img.dzi?token=${secret}&view=1#frag`);
  const labels = m.labels();
  assert.equal(labels.length, 1);
  await m.rankNow();
  const joined = lines.join("\n") + "\n" + labels.join("\n");
  for (const leak of ["user", "pass", secret, "#frag"]) {
    assert.ok(!joined.includes(leak), `credential/fragment leak: ${leak}`);
  }
  assert.ok(joined.includes("***"), "redaction marker missing");
  assert.ok(joined.includes("view=1"), "safe param lost");
});

test("snapshot and dispose report bounded terminal state", async () => {
  const m = createDetectionMonitor();
  assert.deepEqual(m.getSnapshot(), {
    state: "idle",
    tabId: null,
    generation: 0,
    generationMark: "gen-0",
    size: 0,
    stopReason: null,
  });
  m.startMonitoring(11);
  m.handleRequest(11, "https://a.example/a.dzi");
  const snap = m.dispose("detected");
  assert.equal(snap.state, "stopped");
  assert.equal(snap.stopReason, "detected");
  assert.equal(snap.size, 0);
  assert.equal(snap.tabId, null);
});
