import assert from "node:assert/strict";
import test from "node:test";
import { createWebFetcher } from "../packages/browser-runtime/src/web-fetch.ts";

const LITERAL_FREE_HEADS = {
  "gac-lh3-head":
    '<!doctype html><html><head><title>Artwork</title><meta charset="utf-8"></head>' +
    '<body><img src="https://lh3.googleusercontent.com/abc123=w1600"></body></html>',
  "krpano-tour-head":
    '<!doctype html><html><head><title>Tour</title><script src="/tour/viewer.js"></script></head>' +
    '<body><div id="pano"></div><script>embedViewer({xml:"tour.xml"})</script></body></html>',
  "iiif-info-link-head":
    "<!doctype html><html><head><title>Scan</title></head>" +
    '<body><a href="https://example.test/image/42/info.json">view</a></body></html>',
};

function fetcherForHead(head) {
  const bytes = new TextEncoder().encode(head).buffer;
  return createWebFetcher({
    fetchImpl: async () => new Response(bytes, { headers: { "content-type": "text/html" } }),
    isProxyEligible: () => ({ eligible: false }),
    hooks: { onRequestStart: () => 0, onRequestEnd() {}, onLog() {}, onUpdate() {} },
    messages: {
      rateLimitedBySite: "rate limited",
      siteBusy: "busy",
      discoveryFailed: () => "discovery failed",
    },
  });
}

test("regression: literal-free heads are forwarded to discovery, never failed by the hint", async () => {
  for (const [name, head] of Object.entries(LITERAL_FREE_HEADS)) {
    const fetcher = fetcherForHead(head);
    const res = await fetcher.fetchResource(
      { uri: "https://example.test/", purpose: "metadata", headers: [] },
      new AbortController().signal,
    );
    assert.ok(res.bytes.byteLength > 0, `${name} bytes reach the parser`);
  }
});
