import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyDiscovery,
  classifyReadableBytes,
  isZoomableContent,
  looksLikeZoomableJson,
  looksLikeZoomableXml,
  hasZoomableContentMarker,
  bytesToTextPreview,
  textToBytes,
  noImageFoundError,
} from "../src/discovery.ts";
import * as discoveryJs from "../src/discovery.js";

const ANTHROPIC_LIKE_HTML = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Formalizing Fermat's Last Theorem</title>
<meta name="description" content="Research on formalizing mathematics">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Article","headline":"Formalizing Fermat"}</script>
<link rel="manifest" href="/manifest.json">
</head><body><article><h1>Formalizing Fermat's Last Theorem</h1>
<p>Mathematicians describe progress on formal proofs. There is not a single tile on that page.</p>
<p>Width 1200 height 800 is just prose, not a tile service.</p>
<img src="/images/fermat.jpg" alt="portrait">
</article></body></html>`;

const PWA_MANIFEST = JSON.stringify({
  name: "Example App",
  short_name: "Example",
  start_url: "/",
  display: "standalone",
  icons: [{ src: "/icon.png", sizes: "512x512", type: "image/png" }],
});

const GENERIC_JSON_LD = JSON.stringify({
  "@context": "https://schema.org",
  "@type": "Article",
  headline: "Hello",
});

const IIIF_INFO = JSON.stringify({
  "@context": "http://iiif.io/api/image/2/context.json",
  "@id": "https://example.test/iiif/image1",
  protocol: "http://iiif.io/api/image",
  width: 8000,
  height: 6000,
  tiles: [{ width: 512, scaleFactors: [1, 2, 4] }],
  profile: ["http://iiif.io/api/image/2/level2.json"],
});

const IIIF_MANIFEST_SNIPPET = JSON.stringify({
  "@context": "http://iiif.io/api/presentation/2/context.json",
  "@type": "sc:Manifest",
  sequences: [{ canvases: [{ "@id": "https://example.test/canvas/1" }] }],
});

const DZI_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="jpg" Overlap="1" TileSize="254">
<Size Height="8000" Width="6000"/>
</Image>`;

const ZOOMIFY_XML = `<?xml version="1.0"?>
<IMAGE_PROPERTIES WIDTH="8000" HEIGHT="6000" NUMTILES="28" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>`;

const OPENSEADRAGON_HTML = `<html><head><script src="/openseadragon.min.js"></script></head>
<body><div id="viewer"></div><script>OpenSeadragon({tileSources: "/images/sample.dzi"})</script></body></html>`;

const ZOOMIFY_PAGE_HTML = `<html><body><script>var zoomifyImagePath="/zoomify/pic";</script></body></html>`;

function readable(textOrBytes, extra = {}) {
  const bytes =
    typeof textOrBytes === "string" ? textToBytes(textOrBytes) : textOrBytes;
  return { via: "direct", result: { outcome: "readable", finalUrl: "https://x.test/", status: 200, headers: {}, bytes, ...extra } };
}

test("negative: generic article page (anthropic-like) is NO_IMAGE_FOUND, never tiles", () => {
  const res = classifyDiscovery("https://www.anthropic.com/research/formalizing-fermats-last-theorem", readable(ANTHROPIC_LIKE_HTML));
  assert.equal(res.found, false);
  assert.equal(res.error.code, "NO_IMAGE_FOUND");
  assert.equal(res.error.category, "discovery");
  assert.equal(res.error.retryable, false);
  assert.ok(res.error.message.toLowerCase().includes("no zoomable image"));
  // No tile counts leak through the classifier.
  assert.ok(!("imageCount" in res) && !("total" in res));
  assert.equal(isZoomableContent(ANTHROPIC_LIKE_HTML), false);
});

test("negative: empty, prose, PWA manifest, schema.org JSON-LD, SVG image tag are not zoomable", () => {
  for (const [name, input, contentType] of [
    ["empty", new Uint8Array(0).buffer, undefined],
    ["whitespace", "   \n  ", undefined],
    ["prose", "hello world, width 100 height 100", undefined],
    ["pwa-manifest", PWA_MANIFEST, "application/manifest+json"],
    ["schema-org", GENERIC_JSON_LD, "application/ld+json"],
    ["generic-xml", "<note><to>you</to></note>", "text/xml"],
    // Bare <image> in SVG must not count without DZI structure.
    ["svg-image", `<svg xmlns="http://www.w3.org/2000/svg"><image href="/a.jpg" width="10" height="10"/></svg>`, "image/svg+xml"],
  ]) {
    const extra = contentType ? { headers: { "content-type": contentType } } : {};
    const res = classifyDiscovery("https://public.test/page", readable(input, extra));
    assert.equal(res.found, false, name);
    assert.equal(res.error.code, "NO_IMAGE_FOUND", name);
  }
  assert.equal(looksLikeZoomableJson(PWA_MANIFEST), false);
  assert.equal(looksLikeZoomableJson(GENERIC_JSON_LD), false);
  assert.equal(looksLikeZoomableXml("<note><to>you</to></note>"), false);
  // SVG <image> alone is not a DZI catalog.
  assert.equal(
    looksLikeZoomableXml(`<svg><image href="/a.jpg" width="10" height="10"/></svg>`),
    false,
  );
});

test("negative: single-image bytes and image content-type never count as zoomable", () => {
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).buffer;
  const viaType = classifyReadableBytes(fakeJpeg, { via: "direct", contentType: "image/jpeg" });
  assert.equal(viaType.found, false);
  assert.equal(viaType.error.code, "NO_IMAGE_FOUND");
  // Even without a content-type, binary without markers is negative.
  const noType = classifyReadableBytes(fakeJpeg, { via: "direct" });
  assert.equal(noType.found, false);
});

test("error: http statuses map to plain retryable/terminal transport errors", () => {
  const cases = [
    ["https://public.test/missing", { via: "direct", result: { outcome: "http-error", finalUrl: "https://public.test/missing", status: 404, headers: {} } }, "TRANSPORT_HTTP_ERROR", false],
    ["https://public.test/denied", { via: "direct", result: { outcome: "http-error", finalUrl: "https://public.test/denied", status: 403, headers: {} } }, "TRANSPORT_HTTP_ERROR", false],
    ["https://public.test/busy", { via: "direct", result: { outcome: "http-error", finalUrl: "https://public.test/busy", status: 500, headers: {} } }, "TRANSPORT_HTTP_ERROR", true],
    ["https://public.test/rate", { via: "direct", result: { outcome: "http-error", finalUrl: "https://public.test/rate", status: 429, headers: {} } }, "TRANSPORT_HTTP_ERROR", true],
  ];
  for (const [url, fetchOutput, code, retryable] of cases) {
    const res = classifyDiscovery(url, fetchOutput);
    assert.equal(res.found, false, url);
    assert.equal(res.error.code, code, url);
    assert.equal(res.error.retryable, retryable, url);
    assert.ok(!res.error.message.match(/cors|proxy|dezoomer/i), `no jargon in ${url}: ${res.error.message}`);
  }
});

test("error: network, cancelled, policy-denied, and malformed map distinctly", () => {
  const net = classifyDiscovery("https://public.test/x", { via: "direct", result: { outcome: "network-error", reason: "Failed to fetch" } });
  assert.equal(net.found, false);
  assert.equal(net.error.code, "TRANSPORT_NETWORK_ERROR");
  assert.equal(net.error.retryable, true);

  const cancelled = classifyDiscovery("https://public.test/x", { via: "direct", result: { outcome: "cancelled", reason: "aborted" } });
  assert.equal(cancelled.found, false);
  assert.equal(cancelled.cancelled, true);

  const denied = classifyDiscovery("https://public.test/x", { via: "direct", result: { outcome: "policy-denied", reason: "x", code: "TRANSPORT_POLICY_DENIED" } });
  assert.equal(denied.found, false);
  assert.equal(denied.error.retryable, false);

  const ordinary = classifyDiscovery("https://public.test/x", { via: "direct", result: { outcome: "ordinary-image-allowed", finalUrl: "https://public.test/x" } });
  assert.equal(ordinary.found, false);
  assert.equal(ordinary.error.code, "NO_IMAGE_FOUND");

  const malformed = classifyDiscovery("https://public.test/x", { via: "direct", result: { outcome: "weird" } });
  assert.equal(malformed.found, false);

  const missing = classifyDiscovery("https://public.test/x", { via: "direct" });
  assert.equal(missing.found, false);
});

test("error: proxy failures map without leaking proxy internals to tile progress", () => {
  const rate = classifyDiscovery("https://public.test/x.json", { via: "proxy", result: { ok: false, status: 429, code: "PROXY_RATE_LIMITED" } });
  assert.equal(rate.found, false);
  assert.equal(rate.error.retryable, true);

  const budget = classifyDiscovery("https://public.test/x.json", { via: "proxy", result: { ok: false, status: 413, code: "PROXY_BUDGET_EXCEEDED" } });
  assert.equal(budget.found, false);
  assert.equal(budget.error.retryable, false);

  const denied = classifyDiscovery("https://public.test/x.json", { via: "proxy", result: { ok: false, status: 403, code: "PROXY_POLICY_DENIED" } });
  assert.equal(denied.found, false);

  const http = classifyDiscovery("https://public.test/x.json", { via: "proxy", result: { ok: false, status: 404, code: "TRANSPORT_HTTP_ERROR" } });
  assert.equal(http.found, false);
  assert.equal(http.error.code, "TRANSPORT_HTTP_ERROR");

  const proxyCancelled = classifyDiscovery("https://public.test/x.json", { via: "proxy", result: { ok: false, status: 0, code: "TRANSPORT_CANCELLED" } });
  assert.equal(proxyCancelled.cancelled, true);

  // Proxy success with generic HTML is still negative.
  const proxyHtml = classifyDiscovery("https://public.test/page", {
    via: "proxy",
    result: { ok: true, status: 200, bytes: textToBytes(ANTHROPIC_LIKE_HTML), contentType: "text/html" },
  });
  assert.equal(proxyHtml.found, false);
  assert.equal(proxyHtml.error.code, "NO_IMAGE_FOUND");
  assert.equal(proxyHtml.via, "proxy");
});

test("positive: DZI, Zoomify, IIIF, and viewer embeds are found (direct and proxy)", () => {
  const positives = [
    ["dzi-xml", DZI_XML, "text/xml"],
    ["zoomify-xml", ZOOMIFY_XML, "text/xml"],
    ["iiif-info", IIIF_INFO, "application/json"],
    ["iiif-manifest", IIIF_MANIFEST_SNIPPET, "application/json"],
    ["openseadragon-html", OPENSEADRAGON_HTML, "text/html"],
    ["zoomify-page", ZOOMIFY_PAGE_HTML, "text/html"],
    ["krpano-html", `<html><body><div id="pano" data-xml="tiles.xml"></div><script src="krpano.js"></script></body></html>`, "text/html"],
  ];
  for (const [name, text, ct] of positives) {
    const direct = classifyDiscovery("https://public.test/item", {
      via: "direct",
      result: { outcome: "readable", finalUrl: "https://public.test/item", status: 200, headers: { "content-type": ct }, bytes: textToBytes(text) },
    });
    assert.equal(direct.found, true, `direct ${name}`);
    const proxy = classifyDiscovery("https://public.test/item", {
      via: "proxy",
      result: { ok: true, status: 200, bytes: textToBytes(text), contentType: ct },
    });
    assert.equal(proxy.found, true, `proxy ${name}`);
    assert.equal(isZoomableContent(text), true, name);
  }
  assert.equal(looksLikeZoomableJson(IIIF_INFO), true);
  assert.equal(looksLikeZoomableXml(DZI_XML), true);
  assert.equal(hasZoomableContentMarker(OPENSEADRAGON_HTML), true);
});

test("browser mirror stays in sync with the tested TS classifier", () => {
  const vectors = [
    readable(ANTHROPIC_LIKE_HTML),
    readable(DZI_XML),
    readable(IIIF_INFO),
    readable(PWA_MANIFEST),
    { via: "direct", result: { outcome: "network-error", reason: "x" } },
    { via: "direct", result: { outcome: "http-error", finalUrl: "https://x/", status: 404, headers: {} } },
    { via: "proxy", result: { ok: true, status: 200, bytes: textToBytes(OPENSEADRAGON_HTML), contentType: "text/html" } },
  ];
  for (const v of vectors) {
    const a = classifyDiscovery("https://public.test/u", v);
    const b = discoveryJs.classifyDiscovery("https://public.test/u", v);
    assert.deepEqual(b, a);
  }
  assert.equal(discoveryJs.isZoomableContent(ANTHROPIC_LIKE_HTML), false);
  assert.equal(discoveryJs.isZoomableContent(DZI_XML), true);
  assert.equal(typeof discoveryJs.bytesToTextPreview(textToBytes("hi")), "string");
  assert.equal(bytesToTextPreview(textToBytes("hi")), "hi");
});

test("entries never fabricate tile progress; negatives carry a structured error", () => {
  const thisFile = fileURLToPath(import.meta.url);
  const srcDir = path.dirname(path.dirname(thisFile));
  const mainJs = fs.readFileSync(path.join(srcDir, "src", "main.js"), "utf8");
  const mainTs = fs.readFileSync(path.join(srcDir, "src", "main.ts"), "utf8");
  // The reported bug was a hardcoded fake count shown for any URL.
  assert.ok(!mainJs.includes("14 of 28"), "main.js must not hardcode fake tile counts");
  assert.ok(!mainJs.includes("14, total: 28"), "main.js must not hardcode fake totals");
  // Both entries must gate success on the classifier.
  assert.ok(mainJs.includes("classifyDiscovery"), "main.js gates on discovery");
  assert.ok(mainTs.includes("classifyDiscovery"), "main.ts gates on discovery");
  // Negative verdict shape always carries a terminal discovery error.
  const err = noImageFoundError("direct");
  assert.equal(err.code, "NO_IMAGE_FOUND");
  assert.equal(err.retryable, false);
  assert.equal(err.phase, "discovery");
});
