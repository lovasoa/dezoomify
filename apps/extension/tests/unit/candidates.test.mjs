import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadTs(rel) {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const mod = await loadTs("../../src/background/candidates.ts");
const { createCandidateStore, recognizeFormatHint, redactUrlForLabel, validateCandidateUrl, MAX_URL_LENGTH, MAX_CANDIDATES } = mod;

test("caps exported", () => {
  assert.equal(MAX_URL_LENGTH, 2048);
  assert.equal(MAX_CANDIDATES, 100);
});

test("sensitive query keys match redaction.ts (no drift)", () => {
  for (const rel of ["../../src/background/candidates.ts", "../../src/background/redaction.ts"]) {
    const src = readFileSync(new URL(rel, import.meta.url), "utf8");
    // The canonical list lives in redaction.ts; candidates.ts mirrors it.
    assert.ok(src.includes('"sessiontoken"'), `${rel} missing sessiontoken`);
    assert.ok(src.includes('"passwd"'), `${rel} missing passwd`);
  }
  // Byte-identical list contents, extracted from both files.
  const extract = (src) => {
    const m = src.match(/SENSITIVE_QUERY_KEYS = Object\.freeze\(\[([\s\S]*?)\]\)/);
    assert.ok(m, "SENSITIVE_QUERY_KEYS list found");
    return JSON.stringify([...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  };
  const candidates = extract(readFileSync(new URL("../../src/background/candidates.ts", import.meta.url), "utf8"));
  const redaction = extract(readFileSync(new URL("../../src/background/redaction.ts", import.meta.url), "utf8"));
  assert.equal(candidates, redaction, "sensitive key lists must stay identical");
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

test("first-seen deterministic dedup; records url+formatHint only", () => {
  const store = createCandidateStore();
  const r1 = store.add("https://a.example/ImageProperties.xml");
  assert.equal(r1.added, true);
  assert.deepEqual(Object.keys(r1.candidate).sort(), ["formatHint", "url"]);
  const r2 = store.add("https://a.example/ImageProperties.xml");
  assert.equal(r2.added, false);
  assert.equal(r2.code, "duplicate");
  const r3 = store.add("https://b.example/image.dzi");
  assert.equal(r3.added, true);
  const list = store.list();
  assert.equal(list[0].url, "https://a.example/ImageProperties.xml");
  assert.equal(list[1].url, "https://b.example/image.dzi");
  assert.equal(list[0].formatHint, "zoomify");
  assert.equal(list[1].formatHint, "dzi");
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

test("format hints cover legacy families", () => {
  assert.equal(recognizeFormatHint("https://x/ImageProperties.xml"), "zoomify");
  assert.equal(recognizeFormatHint("https://x/image.dzi"), "dzi");
  assert.equal(recognizeFormatHint("https://x/iiif/2/image/info.json"), "iiif");
  assert.equal(recognizeFormatHint("https://x/photo.jpg"), "unknown");
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
