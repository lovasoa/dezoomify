import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserCache, classifyCacheability, deriveCacheKey } from "../src/cache.ts";

test("classifier rejects credentials/auth/private/signed-url/handoff/unknown", () => {
  const base = "https://tiles.test/0/0.jpg";
  assert.equal(classifyCacheability({ url: base, sensitivity: "public-non-credential" }).cacheable, true);
  for (const s of ["credential-bearing", "auth-dependent", "private", "signed-url", "handoff", "unknown", undefined]) {
    const r = classifyCacheability({ url: base, sensitivity: s });
    assert.equal(r.cacheable, false, String(s));
  }
  assert.equal(classifyCacheability({ url: "https://u:p@tiles.test/x", sensitivity: "public-non-credential" }).cacheable, false);
  assert.equal(classifyCacheability({ url: "https://tiles.test/x?token=abc", sensitivity: "public-non-credential" }).cacheable, false);
  assert.equal(classifyCacheability({ url: base, sensitivity: "public-non-credential", headers: { Cookie: "a=b" } }).cacheable, false);
  assert.equal(classifyCacheability({ url: base, sensitivity: "public-non-credential", headers: { Authorization: "Bearer x" } }).cacheable, false);
});

test("keys exclude secrets", () => {
  const key = deriveCacheKey("https://tiles.test/a/b?b=2&a=1#frag");
  assert.ok(!key.includes("#"));
  assert.ok(key.includes("a=1"));
  assert.throws(() => deriveCacheKey("https://user:secret@tiles.test/x"), /credential/);
  // Sensitive query dropped from key.
  const k2 = deriveCacheKey("https://tiles.test/x?token=secret&ok=1");
  assert.ok(!k2.includes("secret") && !k2.includes("token"));
  assert.ok(k2.includes("ok=1"));
});

test("bounded LRU: byte + entry quotas, eviction, clear", () => {
  const c = createBrowserCache({ maxBytes: 10, maxEntries: 2 });
  c.set("a", new Uint8Array([1, 2, 3, 4]).buffer);
  c.set("b", new Uint8Array([5, 6, 3, 4]).buffer);
  assert.equal(c.entryCount, 2);
  // Touch a so b is oldest.
  c.get("a");
  c.set("c", new Uint8Array([7, 8, 9, 10]).buffer);
  // Byte quota 10: a(4)+c(4)=8 fits, b evicted.
  assert.equal(c.get("b"), undefined);
  assert.ok(c.get("a") instanceof ArrayBuffer);
  assert.ok(c.get("c") instanceof ArrayBuffer);
  // Entry quota: adding d evicts the least-recently-used entry. After the
  // byte-quota eviction above the entries are a and c, and a was touched
  // before c was inserted, so a must go.
  c.set("d", new Uint8Array([1]).buffer);
  assert.equal(c.entryCount, 2);
  assert.equal(c.get("a"), undefined, "a is least recently used and must be evicted");
  assert.ok(c.get("d") instanceof ArrayBuffer);
  c.clear();
  assert.equal(c.entryCount, 0);
  assert.equal(c.byteSize, 0);
});
