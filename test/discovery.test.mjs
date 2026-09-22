import assert from "node:assert/strict";
import test from "node:test";
import { createWebFetcher } from "../packages/browser-runtime/src/web-fetch.ts";
import * as discoveryJs from "../src/discovery.ts";
import {
  bytesToTextPreview,
  classifyReadableBytes,
  hasZoomableContentMarker,
  isZoomableContent,
  looksLikeZoomableJson,
  looksLikeZoomableXml,
  noImageFoundError,
  textToBytes,
} from "../src/discovery.ts";

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
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="jpg" Overlap="1" TileSize="254"><Size Height="8000" Width="6000"/>
</Image>`;

const ZOOMIFY_XML = `<?xml version="1.0"?>
<IMAGE_PROPERTIES WIDTH="8000" HEIGHT="6000" NUMTILES="28" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>`;

const OPENSEADRAGON_HTML = `<html><head><script src="/openseadragon.min.js"></script></head>
<body><div id="viewer"></div><script>OpenSeadragon({tileSources: "/images/sample.dzi"})</script></body></html>`;

const ZOOMIFY_PAGE_HTML = `<html><body><script>var zoomifyImagePath="/zoomify/pic";</script></body></html>`;

// Real shape served by lh3.googleusercontent.com at "<base_url>=g".
const GOOGLE_ARTS_TILEINFO_XML = `<?xml version="1.0" encoding="UTF-8"?><TileInfo tile_width="512" tile_height="512" full_pyramid_depth="4" origin="TOP_LEFT" timestamp="1788621048" tiler_version_number="2" image_width="2446" image_height="3524"><pyramid_level num_tiles_x="1" num_tiles_y="1" inverse_scale="8" empty_pels_x="207" empty_pels_y="72"/><pyramid_level num_tiles_x="2" num_tiles_y="2" inverse_scale="4" empty_pels_x="413" empty_pels_y="2"/></TileInfo>`;

function hint(textOrBytes, contentType) {
  return classifyReadableBytes(textOrBytes, { via: "direct", contentType });
}

test("negative: generic article page (anthropic-like) is NO_IMAGE_FOUND, never tiles", () => {
  const res = hint(ANTHROPIC_LIKE_HTML);
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
    // Marker words in plain prose are not Google Arts tile metadata: prose
    // never looks like XML, and the strong-marker path still requires an
    // XML-shaped document for these markers.
    ["prose-tileinfo", "The article mentions tileinfo and pyramid_level.", "text/html"],
    // Bare <image> in SVG must not count without DZI structure.
    [
      "svg-image",
      `<svg xmlns="http://www.w3.org/2000/svg"><image href="/a.jpg" width="10" height="10"/></svg>`,
      "image/svg+xml",
    ],
  ]) {
    const res = hint(input, contentType);
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

test("positive: DZI, Zoomify, IIIF, Google Arts tile info, and viewer embeds are found", () => {
  const positives = [
    ["dzi-xml", DZI_XML, "text/xml"],
    ["zoomify-xml", ZOOMIFY_XML, "text/xml"],
    ["iiif-info", IIIF_INFO, "application/json"],
    ["iiif-manifest", IIIF_MANIFEST_SNIPPET, "application/json"],
    ["openseadragon-html", OPENSEADRAGON_HTML, "text/html"],
    ["zoomify-page", ZOOMIFY_PAGE_HTML, "text/html"],
    [
      "krpano-html",
      `<html><body><div id="pano" data-xml="tiles.xml"></div><script src="krpano.js"></script></body></html>`,
      "text/html",
    ],
    // Google Arts & Culture tile information, served at "<base_url>=g" and
    // fetched as the second discovery resource. Without this marker the
    // webapp rejected real Google Arts tile XML with NO_IMAGE_FOUND.
    ["google-arts-tileinfo", GOOGLE_ARTS_TILEINFO_XML, "text/xml"],
  ];
  for (const [name, text, ct] of positives) {
    assert.equal(hint(textToBytes(text), ct).found, true, name);
    assert.equal(isZoomableContent(text), true, name);
  }
  assert.equal(looksLikeZoomableJson(IIIF_INFO), true);
  assert.equal(looksLikeZoomableXml(DZI_XML), true);
  assert.equal(hasZoomableContentMarker(OPENSEADRAGON_HTML), true);
});

test("typed module surface stays exportable (no dead error-path classifier)", () => {
  assert.equal(typeof discoveryJs.bytesToTextPreview, "function");
  assert.equal(typeof discoveryJs.bytesToTextPreview(textToBytes("hi")), "string");
  assert.equal(discoveryJs.isZoomableContent(ANTHROPIC_LIKE_HTML), false);
  assert.equal(discoveryJs.isZoomableContent(DZI_XML), true);
  assert.equal(bytesToTextPreview(textToBytes("hi")), "hi");
});

test("negatives carry a structured terminal discovery error", () => {
  const err = noImageFoundError("direct");
  assert.equal(err.code, "NO_IMAGE_FOUND");
  assert.equal(err.retryable, false);
  assert.equal(err.phase, "discovery");
});

// Same-URL parity: these heads carry no zoomable literal, so the substring
// classifier stays negative (hint only). The website must still forward every
// payload to the WASM core, which alone reports NO_IMAGE_FOUND.
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

test("regression: heads without zoomable literals are a negative hint, not a verdict", () => {
  for (const [name, head] of Object.entries(LITERAL_FREE_HEADS)) {
    assert.equal(isZoomableContent(head), false, `${name} has no head literal (hint negative)`);
    const verdict = classifyReadableBytes(textToBytes(head), {
      via: "direct",
      contentType: "text/html",
    });
    assert.equal(verdict.found, false, `${name} hint is negative`);
    assert.equal(verdict.error.code, "NO_IMAGE_FOUND", name);
  }
});

function fetcherForHead(head) {
  const bytes = textToBytes(head).slice(0);
  return createWebFetcher({
    fetchImpl: async () => ({
      status: 200,
      url: "https://example.test/",
      headers: { get: () => "text/html" },
      async arrayBuffer() {
        return bytes;
      },
    }),
    isProxyEligible: () => ({ eligible: false }),
    classifyHint: (hintBytes, info) => classifyReadableBytes(hintBytes, info),
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
    const res = await fetcher.fetchMetadataFor("https://example.test/", {});
    assert.equal(res.via, "direct", name);
    assert.ok(res.bytes.byteLength > 0, `${name} bytes reach the engine`);
  }
});
