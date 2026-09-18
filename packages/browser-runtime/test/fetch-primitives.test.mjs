import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeBase64Payload,
  forwardCoreHeaders,
  isHttpSuccessStatus,
  isPublicHttpUrl,
  normalizeErrorPreviewText,
  normalizeFetchMethod,
  originOfPublicUrl,
  originOfUrl,
  sanitizeHeaderPair,
  validateEngineHeaders,
} from "../src/fetch-primitives.ts";

test("public URL check accepts http(s) and rejects the rest", () => {
  assert.equal(isPublicHttpUrl("https://gallery.example/info.json"), true);
  assert.equal(isPublicHttpUrl("http://127.0.0.1:9/tile.png"), true);
  for (const bad of ["ftp://gallery.example/f", "data:text/plain,x", "chrome-extension://id/page", "", null, 42, "https://exa mple.com/"]) {
    assert.equal(isPublicHttpUrl(bad), false, String(bad));
  }
});

test("origin helpers separate strict comparison from public origins", () => {
  assert.equal(originOfUrl("https://Gallery.Example:443/a?b=c"), "https://gallery.example");
  assert.equal(originOfUrl("http://127.0.0.1:8080/t.png"), "http://127.0.0.1:8080");
  assert.equal(originOfUrl("not a url"), "");
  assert.equal(originOfUrl(null), "");
  assert.equal(originOfPublicUrl("https://gallery.example/a"), "https://gallery.example");
  assert.equal(originOfPublicUrl("ftp://gallery.example/a"), null);
  assert.equal(originOfPublicUrl(null), null);
});

test("method normalization defaults, uppercases, and rejects", () => {
  assert.equal(normalizeFetchMethod(undefined), "GET");
  assert.equal(normalizeFetchMethod("get"), "GET");
  assert.equal(normalizeFetchMethod("POST"), "POST");
  for (const bad of ["", "FETCH", "GET ", "G@T", "x".repeat(17), null, 42]) {
    assert.equal(normalizeFetchMethod(bad), null, String(bad));
  }
});

test("engine header validation accepts well-formed pairs and rejects the rest", () => {
  assert.deepEqual(
    validateEngineHeaders([{ name: "Accept", value: "application/json" }]),
    [{ name: "Accept", value: "application/json" }],
  );
  assert.equal(validateEngineHeaders([]).length, 0);
  assert.equal(validateEngineHeaders([{ name: "", value: "x" }]), null);
  assert.equal(validateEngineHeaders([{ name: "A", value: "b\rc" }]), null);
  assert.equal(validateEngineHeaders([{ name: "A" }]), null);
  assert.equal(validateEngineHeaders("Accept: x"), null);
  assert.equal(validateEngineHeaders(new Array(65).fill({ name: "A", value: "b" })), null);
  assert.equal(validateEngineHeaders([{ name: "A".repeat(257), value: "b" }]), null);
  assert.equal(sanitizeHeaderPair("A", "b")?.value, "b");
  assert.equal(sanitizeHeaderPair("A", "b\n"), null);
});

test("core header forwarding keeps the allowlist and drops credentials", () => {
  const supplied = [
    { name: "Accept", value: "application/xml" },
    { name: "Range", value: "bytes=0-4" },
    { name: "If-None-Match", value: "etag" },
    { name: "Cookie", value: "session=1" },
    { name: "Authorization", value: "Bearer x" },
    { name: "Referer", value: "https://gallery.example/" },
    { name: "X-Custom", value: "yes" },
  ];
  assert.deepEqual(forwardCoreHeaders(supplied, "tile"), { accept: "application/xml", range: "bytes=0-4" });
  assert.deepEqual(
    forwardCoreHeaders(supplied, "metadata"),
    { accept: "application/xml", range: "bytes=0-4", "if-none-match": "etag" },
  );
  assert.deepEqual(forwardCoreHeaders({ Accept: "text/html" }, "tile"), { accept: "text/html" });
  assert.deepEqual(forwardCoreHeaders(null, "tile"), {});
});

test("HTTP success is an integer 200-299", () => {
  assert.equal(isHttpSuccessStatus(200), true);
  assert.equal(isHttpSuccessStatus(299), true);
  for (const bad of [199, 300, 404, 200.5, "200", null]) assert.equal(isHttpSuccessStatus(bad), false, String(bad));
});

test("base64 payload decoding round-trips and enforces bounds", () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);
  const data = Buffer.from(bytes).toString("base64");
  assert.deepEqual(decodeBase64Payload(data, 8), bytes);
  assert.equal(decodeBase64Payload(data, 3), null);
  for (const bad of ["", null, 42, "!!!", "A".repeat(10) + "!", data.slice(0, -1) + "%"]) {
    assert.equal(decodeBase64Payload(bad, 1024), null, String(bad)?.slice(0, 20));
  }
});

test("base64 decoding falls back without the native codec", () => {
  const native = Uint8Array.fromBase64;
  Uint8Array.fromBase64 = undefined;
  try {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const data = Buffer.from(bytes).toString("base64");
    assert.deepEqual(decodeBase64Payload(data, 8), bytes);
    assert.equal(decodeBase64Payload("!!!", 8), null);
  } finally {
    Uint8Array.fromBase64 = native;
  }
});

test("error preview text strips markup, collapses, truncates, and rejects binary", () => {
  assert.equal(normalizeErrorPreviewText("<html><body>  Access   Denied  </body></html>", 300), "Access Denied");
  assert.equal(normalizeErrorPreviewText("a\0b", 300), "");
  assert.equal(normalizeErrorPreviewText("", 300), "");
  assert.equal(normalizeErrorPreviewText("x".repeat(400), 300).length, 300);
});
