import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const mod = await loadTs("../../src/runtime/candidates.ts");
const { createCandidateStore, redactUrlForLabel, validateCandidateUrl, MAX_URL_LENGTH, MAX_CANDIDATES } = mod;

test("caps exported", () => {
  assert.equal(MAX_URL_LENGTH, 2048);
  assert.equal(MAX_CANDIDATES, 100);
});

test("sensitive query keys are present for candidate labels", () => {
  const src = readFileSync(new URL("../../src/runtime/candidates.ts", import.meta.url), "utf8");
  assert.ok(src.includes('"sessiontoken"'));
  assert.ok(src.includes('"passwd"'));
});

test("http/https accepted, other schemes rejected", () => {
  assert.equal(validateCandidateUrl("https://a.example/x").ok, true);
  assert.equal(validateCandidateUrl("http://a.example/x").ok, true);
  for (const u of ["ftp://a.example/x", "file:///etc/passwd", "data:text/plain,hi", "javascript:alert(1)", "chrome://settings", "about:blank", ""]) {
    assert.equal(validateCandidateUrl(u).ok, false, u);
  }
});

test("length cap enforced", () => {
  const long = "https://a.example/" + "x".repeat(3000);
  assert.equal(validateCandidateUrl(long).ok, false);
  assert.equal(validateCandidateUrl(long).code, "too-long");
});

test("first-seen deterministic dedup; records url only (ranking is the core's job)", () => {
  const store = createCandidateStore();
  const r1 = store.add("https://a.example/ImageProperties.xml");
  assert.equal(r1.added, true);
  assert.deepEqual(Object.keys(r1.candidate).sort(), ["url"]);
  const r2 = store.add("https://a.example/ImageProperties.xml");
  assert.equal(r2.added, false);
  assert.equal(r2.code, "duplicate");
  const r3 = store.add("https://b.example/image.dzi");
  assert.equal(r3.added, true);
  const list = store.list();
  assert.equal(list[0].url, "https://a.example/ImageProperties.xml");
  assert.equal(list[1].url, "https://b.example/image.dzi");
});

test("count cap enforced", () => {
  const store = createCandidateStore();
  for (let i = 0; i < MAX_CANDIDATES; i++) {
    const r = store.add(`https://a.example/img${i}.dzi`);
    assert.equal(r.added, true);
  }
  const over = store.add("https://a.example/overflow.dzi");
  assert.equal(over.added, false);
  assert.equal(over.code, "cap-reached");
  assert.equal(store.size, MAX_CANDIDATES);
});

test("store keeps raw urls; core rankCandidates decides formats", () => {
  const store = createCandidateStore();
  store.add("https://x/photo.jpg");
  assert.equal(store.list()[0].url, "https://x/photo.jpg");
});

test("labels redact userinfo and sensitive query, drop fragments", () => {
  const label = redactUrlForLabel("https://user:pass@a.example/img.dzi?token=SECRET&view=1#frag");
  assert.ok(!label.includes("user"), "userinfo leaked");
  assert.ok(!label.includes("pass"), "password leaked");
  assert.ok(!label.includes("SECRET"), "token leaked");
  assert.ok(label.includes("***"), "redaction marker missing");
  assert.ok(label.includes("view=1"), "safe param lost");
  assert.ok(!label.includes("#"), "fragment leaked");
});

test("hostile inputs: invalid url, duplicates with different query are distinct", () => {
  const store = createCandidateStore();
  assert.equal(store.add("not a url").added, false);
  store.add("https://a.example/x?view=1");
  store.add("https://a.example/x?view=2");
  assert.equal(store.size, 2);
});

test("dispose clears all candidates", () => {
  const store = createCandidateStore();
  store.add("https://a.example/a.dzi");
  store.add("https://a.example/b.dzi");
  assert.equal(store.size, 2);
  store.dispose();
  assert.equal(store.size, 0);
  assert.deepEqual(store.list(), []);
});

// --- Click-to-monitor windowing (additive; deterministic first-seen order) ---

test("windowing: first-seen order preserved for core ranking", () => {
  const store = createCandidateStore();
  const urls = [
    "https://a.example/viewer/page",
    "https://a.example/ImageProperties.xml",
    "https://tiles.example/iiif/image/info.json",
  ];
  for (const u of urls) assert.equal(store.add(u).added, true);
  assert.deepEqual(store.list().map((c) => c.url), urls);
});

test("windowing: cap keeps the first window; overflow never evicts", () => {
  const store = createCandidateStore();
  for (let i = 0; i < MAX_CANDIDATES; i += 1) {
    assert.equal(store.add(`https://a.example/img${i}.dzi`).added, true);
  }
  const first = store.list()[0].url;
  const last = store.list()[MAX_CANDIDATES - 1].url;
  assert.equal(first, "https://a.example/img0.dzi");
  // Overflow rejected deterministically; the stored window is unchanged.
  for (let i = 0; i < 10; i += 1) {
    const over = store.add(`https://a.example/overflow${i}.dzi`);
    assert.equal(over.added, false);
    assert.equal(over.code, "cap-reached");
  }
  assert.equal(store.size, MAX_CANDIDATES);
  assert.equal(store.list()[0].url, first);
  assert.equal(store.list()[MAX_CANDIDATES - 1].url, last);
});

test("windowing: duplicates never consume cap slots", () => {
  const store = createCandidateStore();
  assert.equal(store.add("https://a.example/a.dzi").added, true);
  for (let i = 0; i < 5; i += 1) {
    assert.equal(store.add("https://a.example/a.dzi").code, "duplicate");
  }
  assert.equal(store.size, 1);
  for (let i = 0; i < MAX_CANDIDATES - 1; i += 1) {
    assert.equal(store.add(`https://a.example/fill${i}.dzi`).added, true);
  }
  assert.equal(store.size, MAX_CANDIDATES);
});
