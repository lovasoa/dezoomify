import test from "node:test";
import assert from "node:assert/strict";
import { buildHash, looksLikeUsableUrl, parseHash } from "../src/hash.ts";
import { formatElapsed, formatRemaining } from "../packages/shared-ui/src/components.ts";

test("legacy hash round-trips raw URLs", () => {
  const url = "https://example.com/viewer?id=42";
  assert.equal(buildHash(url), `#${url}`);
  // Legacy wrote window.location.hash = url; reading sliced the leading '#'.
  assert.equal(parseHash(`#${url}`), url);
  assert.equal(parseHash(url), url);
});

test("hash parsing tolerates legacy variants", () => {
  assert.equal(parseHash(""), null);
  assert.equal(parseHash("#"), null);
  assert.equal(parseHash("#!/https://example.com/x"), "https://example.com/x");
  assert.equal(parseHash("#/https://example.com/x"), "https://example.com/x");
  const encoded = `#${encodeURIComponent("https://example.com/a b?c=d")}`;
  assert.equal(parseHash(encoded), "https://example.com/a b?c=d");
  // Undecodable bodies fall back to raw rather than throwing.
  assert.equal(parseHash("#https://example.com/100%"), "https://example.com/100%");
  assert.equal(parseHash(null), null);
});

test("usable-url gate keeps auto-start safe", () => {
  assert.equal(looksLikeUsableUrl("https://example.com/x"), true);
  assert.equal(looksLikeUsableUrl("http://localhost/x"), true);
  assert.equal(looksLikeUsableUrl("javascript:alert(1)"), false);
  assert.equal(looksLikeUsableUrl("not a url"), false);
  assert.equal(looksLikeUsableUrl(null), false);
});

test("elapsed formatting stays quiet for fast requests", () => {
  assert.equal(formatElapsed(100), "");
  assert.equal(formatElapsed(1999), "");
  assert.equal(formatElapsed(3000), "3 s");
  assert.equal(formatElapsed(65000), "1 min 5 s");
  assert.equal(formatElapsed(120000), "2 min");
});

test("remaining formatting counts down the 30 s timeout", () => {
  assert.equal(formatRemaining(0, 30000), "30 s left");
  assert.equal(formatRemaining(29500, 30000), "1 s left");
  assert.equal(formatRemaining(30000, 30000), "0 s left");
});
