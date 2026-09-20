import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createWebFetcher } from "../packages/browser-runtime/src/web-fetch.ts";
import {
  errorTransportFor,
  isOrdinaryImageTile,
  isProxyEligible,
} from "../packages/browser-runtime/src/web-integration.ts";
import {
  PROXY_MAX_INFLIGHT,
  PROXY_MAX_REQUESTS_PER_SECOND,
  createProxyRateLimiter,
  createProxyTransport,
} from "../src/proxyTransport.ts";
import { DIRECT_TRANSPORT_LABEL, PROXY_TRANSPORT_LABEL } from "../packages/app-model/src/labels.ts";
import { DIRECT_METADATA_TIMEOUT_MS } from "../packages/browser-runtime/src/tile-policy.ts";
import { drawPlacedTile } from "../packages/browser-runtime/src/tile-draw.ts";
import { renderSaveGuidance } from "../packages/shared-ui/src/components.ts";
import { canvasToPngBlob, isCanvasTaintError } from "../packages/browser-runtime/src/canvas-save.ts";
import { act } from "./react-dom.mjs";
import { presentIdle } from "../packages/shared-ui/src/snapshot-view.ts";
import { renderView } from "../packages/shared-ui/src/view.tsx";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function okBytes(...values) {
  return new Uint8Array(values).buffer;
}

function directImpl(bytes = okBytes(1), status = 200) {
  return {
    calls: 0,
    async fetchImpl() {
      this.calls += 1;
      return {
        status,
        url: "https://public.test/image.json",
        headers: { get: () => null },
        async arrayBuffer() {
          return bytes.slice(0);
        },
      };
    },
  };
}

function directCorsFail() {
  return {
    calls: 0,
    async fetchImpl() {
      this.calls += 1;
      throw new Error("Failed to fetch");
    },
  };
}

function proxyImpl(bytes = okBytes(9)) {
  return {
    calls: 0,
    async fetchViaProxy() {
      this.calls += 1;
      return { ok: true, status: 200, bytes: bytes.slice(0), contentType: "application/json" };
    },
  };
}

function webDeps({ direct, proxy }) {
  const attempts = [];
  let started = 0;
  const deps = {
    fetchImpl: (...args) => direct.fetchImpl(...args),
    proxyTransport: { fetchViaProxy: (...args) => proxy.fetchViaProxy(...args) },
    isProxyEligible: (req) => isProxyEligible(req),
    classifyHint: undefined,
    hooks: {
      onRequestStart: () => {
        started += 1;
        return started;
      },
      onRequestEnd() {},
      onLog() {},
      onUpdate() {},
      onMetadataAttempt: (attempt) => attempts.push(attempt),
    },
    messages: {
      rateLimitedBySite: "rate limited",
      siteBusy: "busy",
      discoveryFailed: () => "discovery failed",
    },
    sleepFn: async () => {},
    randomFn: () => 0,
  };
  return { deps, attempts };
}

test("direct is always first; proxy not called on direct success", async () => {
  const direct = directImpl();
  const proxy = proxyImpl();
  const { deps, attempts } = webDeps({ direct, proxy });
  const fetcher = createWebFetcher(deps);
  const res = await fetcher.fetchMetadataFor("https://public.test/image.json", {});
  assert.equal(res.via, "direct");
  assert.equal(direct.calls, 1);
  assert.equal(proxy.calls, 0);
  assert.equal(fetcher.getActiveTransport(), DIRECT_TRANSPORT_LABEL);
  assert.deepEqual(attempts.map((a) => a.transport), ["direct"]);
});

test("eligible metadata failure automatically calls proxy without extra user action", async () => {
  const direct = directCorsFail();
  const proxy = proxyImpl();
  const { deps, attempts } = webDeps({ direct, proxy });
  const fetcher = createWebFetcher(deps);
  const res = await fetcher.fetchMetadataFor("https://public.test/image.json", {});
  assert.equal(res.via, "proxy");
  assert.equal(direct.calls, 1);
  assert.equal(proxy.calls, 1);
  assert.equal(fetcher.getActiveTransport(), PROXY_TRANSPORT_LABEL);
  assert.deepEqual(attempts.map((a) => a.transport), ["direct", "metadata proxy"]);
});

test("metadata proxy rate-limit retries once, then succeeds", async () => {
  const direct = directCorsFail();
  const proxy = {
    calls: 0,
    async fetchViaProxy() {
      this.calls += 1;
      if (this.calls === 1) return { ok: false, status: 429, code: "PROXY_RATE_LIMITED", retryAfterMs: 0 };
      return { ok: true, status: 200, bytes: okBytes(5), contentType: "application/json" };
    },
  };
  const { deps } = webDeps({ direct, proxy });
  const fetcher = createWebFetcher(deps);
  const res = await fetcher.fetchMetadataFor("https://public.test/image.json", {});
  assert.equal(res.via, "proxy");
  assert.equal(proxy.calls, 2);
  assert.ok(res.bytes.byteLength > 0, "retried bytes reach discovery");
});

test("proxy eligibility matrix", () => {  const okReq = { url: "https://public.test/image.json", kind: "metadata" };
  assert.equal(isProxyEligible(okReq).eligible, true);
  // Tile never proxied.
  assert.equal(isProxyEligible({ ...okReq, kind: "tile" }).eligible, false);
  // Credential-bearing targets ineligible.
  assert.equal(isProxyEligible({ url: "https://user:pw@public.test/x", kind: "metadata" }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x?token=abc", kind: "metadata" }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", headers: { Cookie: "a=b" } }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", headers: { Authorization: "Bearer x" } }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", requiresCookies: true }).eligible, false);
  assert.equal(isProxyEligible({ url: "https://public.test/x", kind: "metadata", requiresAuth: true }).eligible, false);
  // Private/local ineligible.
  for (const u of ["http://localhost/x", "http://127.0.0.1/x", "https://10.0.0.5/x", "https://192.168.1.1/x"]) {
    assert.equal(isProxyEligible({ url: u, kind: "metadata" }).eligible, false, u);
  }
});

test("no proxy for http-error, ineligible targets, cancelled, tile", async () => {
  // HTTP refusals never fall back: the failure is authoritative, not a CORS gap.
  {
    const direct = directImpl(okBytes(7), 404);
    const proxy = proxyImpl();
    const { deps } = webDeps({ direct, proxy });
    const fetcher = createWebFetcher(deps);
    await assert.rejects(fetcher.fetchMetadataFor("https://public.test/x", {}), (error) => error.code === "DISCOVERY_HTTP_ERROR");
    assert.equal(proxy.calls, 0);
  }
  // Credential-bearing targets are ineligible: no proxy attempt is made.
  {
    const direct = directCorsFail();
    const proxy = proxyImpl();
    const { deps } = webDeps({ direct, proxy });
    const fetcher = createWebFetcher(deps);
    await assert.rejects(
      fetcher.fetchMetadataFor("https://user:pw@public.test/x", {}),
      (error) => error.code === "DISCOVERY_FAILED",
    );
    assert.equal(proxy.calls, 0);
  }
  // A retired job never falls back to the proxy.
  {
    const direct = directCorsFail();
    const proxy = proxyImpl();
    const { deps } = webDeps({ direct, proxy });
    const fetcher = createWebFetcher(deps);
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(
      fetcher.fetchMetadataFor("https://public.test/x", {}, ctrl.signal),
      (error) => error.code === "TRANSPORT_CANCELLED",
    );
    assert.equal(proxy.calls, 0);
  }
  // Tile path never proxies even on network-error.
  {
    const direct = directCorsFail();
    const proxy = proxyImpl();
    const { deps } = webDeps({ direct, proxy });
    const fetcher = createWebFetcher(deps);
    await assert.rejects(fetcher.fetchTileFor("https://public.test/0_0.jpg", {}, 0));
    assert.equal(proxy.calls, 0);
  }
});

test("proxyTransport posts only targetUrl+protocolVersion, credentials omit, size guard", async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init };
    assert.equal(url, "/api/proxy");
    assert.equal(init.method, "POST");
    assert.equal(init.credentials, "omit");
    const body = JSON.parse(init.body);
    assert.deepEqual(Object.keys(body).sort(), ["protocolVersion", "targetUrl"]);
    assert.ok(!("cookie" in (init.headers ?? {})));
    return {
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === "content-type" ? "application/json" : null) },
      async arrayBuffer() {
        return new Uint8Array([1, 2]).buffer;
      },
    };
  };
  const pt = createProxyTransport(fetchImpl, { protocolVersion: 1, maxBytes: 1024 });
  const r = await pt.fetchViaProxy("https://public.test/x.json");
  assert.equal(r.ok, true);
  assert.equal(seen.init.headers["content-type"], "application/json");
  // Credential-bearing target rejected before request.
  let called = 0;
  const pt2 = createProxyTransport(async () => { called += 1; throw new Error("nope"); }, { protocolVersion: 1, maxBytes: 1024 });
  const denied = await pt2.fetchViaProxy("https://user:pw@public.test/x");
  assert.equal(denied.ok, false);
  assert.equal(denied.code, "PROXY_POLICY_DENIED");
  assert.equal(called, 0);
  // Oversize mapped to budget code.
  const pt3 = createProxyTransport(async () => ({
    status: 200,
    headers: { get: () => null },
    async arrayBuffer() {
      return new Uint8Array(2048).buffer;
    },
  }), { protocolVersion: 1, maxBytes: 1024 });
  const big = await pt3.fetchViaProxy("https://public.test/x.json");
  assert.equal(big.code, "PROXY_BUDGET_EXCEEDED");
  // Cancellation.
  const ctrl = new AbortController();
  ctrl.abort();
  const cancelled = await pt.fetchViaProxy("https://public.test/x.json", { signal: ctrl.signal });
  assert.equal(cancelled.code, "TRANSPORT_CANCELLED");
});

test("proxyTransport surfaces Retry-After on 429 so callers can back off once", async () => {
  const withHint = createProxyTransport(async () => ({
    status: 429,
    headers: { get: (k) => (k.toLowerCase() === "retry-after" ? "2" : null) },
    async arrayBuffer() {
      return new Uint8Array([1]).buffer;
    },
  }), { protocolVersion: 1, maxBytes: 1024 });
  const hinted = await withHint.fetchViaProxy("https://public.test/busy.json");
  assert.equal(hinted.ok, false);
  assert.equal(hinted.code, "PROXY_RATE_LIMITED");
  assert.equal(hinted.retryAfterMs, 2000);
  const bare = createProxyTransport(async () => ({
    status: 429,
    headers: { get: () => null },
    async arrayBuffer() {
      return new Uint8Array([1]).buffer;
    },
  }), { protocolVersion: 1, maxBytes: 1024 });
  const unhinted = await bare.fetchViaProxy("https://public.test/busy.json");
  assert.equal(unhinted.code, "PROXY_RATE_LIMITED");
  assert.equal(unhinted.retryAfterMs, undefined);
});

test("proxyTransport caps proxy load at 4 inflight and 4 starts per second", async () => {
  assert.equal(PROXY_MAX_INFLIGHT, 4);
  assert.equal(PROXY_MAX_REQUESTS_PER_SECOND, 4);
  // Isolated limiter so this burst never borrows quota from other tests.
  const limiter = createProxyRateLimiter();
  let inflight = 0;
  let maxInflight = 0;
  const fetchImpl = async () => {
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inflight -= 1;
    return {
      status: 200,
      headers: { get: () => null },
      async arrayBuffer() {
        return new Uint8Array([1]).buffer;
      },
    };
  };
  const pt = createProxyTransport(fetchImpl, { protocolVersion: 1, maxBytes: 1024, rateLimiter: limiter });
  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => pt.fetchViaProxy(`https://public.test/burst-${i}.json`)),
  );
  const elapsed = Date.now() - started;
  assert.ok(results.every((r) => r.ok), "every limited request still succeeds");
  assert.ok(maxInflight <= 4, `at most 4 proxy requests in flight (saw ${maxInflight})`);
  // 8 starts at 4/s need a second window: the tail must wait out the window.
  assert.ok(elapsed >= 900, `8 starts at 4/s take >= ~1s (took ${elapsed}ms)`);
});

test("proxyTransport surfaces the upstream URL so proxied metadata keeps its tile base", async () => {
  const fetchImpl = async () => ({
    status: 200,
    headers: {
      get: (k) => {
        const l = k.toLowerCase();
        if (l === "content-type") return "application/xml";
        if (l === "x-proxy-upstream-url") return "https://public.test/galleria_04.xml";
        return null;
      },
    },
    async arrayBuffer() {
      return new Uint8Array([1]).buffer;
    },
  });
  const pt = createProxyTransport(fetchImpl, { protocolVersion: 1, maxBytes: 1024 });
  const r = await pt.fetchViaProxy("https://public.test/galleria_04.xml");
  assert.equal(r.ok, true);
  assert.equal(r.finalUrl, "https://public.test/galleria_04.xml");
  // Missing header: no finalUrl, callers fall back to the requested URL.
  const bare = createProxyTransport(async () => ({
    status: 200,
    headers: { get: () => null },
    async arrayBuffer() {
      return new Uint8Array([1]).buffer;
    },
  }), { protocolVersion: 1, maxBytes: 1024 });
  const r2 = await bare.fetchViaProxy("https://public.test/galleria_04.xml");
  assert.equal(r2.ok, true);
  assert.equal(r2.finalUrl, undefined);
});

test("proxy fallback is unconditional: no opt-out UI, 1500 ms direct head start", () => {
  assert.equal(DIRECT_METADATA_TIMEOUT_MS, 1500);
  const el = globalThis.document.createElement("div");
  globalThis.document.body.appendChild(el);
  act(() => renderView(el,
    presentIdle(),
    { onSubmitUrl: () => {}, onCancel: () => {}, onReset: () => {}, onSave: () => {} },
  ));
  assert.equal(el.querySelector("#dz-proxy-optin"), null, "idle view renders no proxy toggle");
});

test("ordinary display fallback only for unprocessed tiles", () => {
  assert.equal(isOrdinaryImageTile("none"), true);
  // Processed tiles need readable bytes: display fallback would drop the
  // processing, so it is never allowed.
  assert.equal(isOrdinaryImageTile("google-arts-decrypt"), false);
});

test("tile failures report the direct transport, never the metadata proxy", () => {
  assert.equal(errorTransportFor("TILE_FAILED", "Metadata proxy"), DIRECT_TRANSPORT_LABEL);
  assert.equal(errorTransportFor("TILE_FAILED", null), DIRECT_TRANSPORT_LABEL);
  assert.equal(errorTransportFor("DISCOVERY_FAILED", "Metadata proxy"), "Metadata proxy");
  assert.equal(errorTransportFor("NO_IMAGE_FOUND", null), "direct");
});

test("page policy permits cross-origin tile images for display", () => {
  // The engine-host display fallback draws ordinary <img> elements; the page
  // CSP must allow cross-origin tile images for that path.
  const html = fs.readFileSync(path.join(REPO_ROOT, "index.html"), "utf8");
  assert.ok(html.includes("img-src 'self' data: blob: https:"), "CSP must allow cross-origin tile display");
});

test("edge tiles crop to the plan, saves warn on color profiles, PNG encodes via canvas", async () => {
  // Padded edge tiles (e.g. Google Arts & Culture) crop from the right and
  // bottom; the mismatch is logged without identifying any tile.
  const draws = [];
  const mismatches = [];
  drawPlacedTile({ drawImage: (...args) => draws.push(args) }, { width: 512, height: 512 }, { x: 0, y: 0, w: 256, h: 256 }, (line) => mismatches.push(line));
  assert.deepEqual(draws, [[{ width: 512, height: 512 }, 0, 0, 256, 256, 0, 0, 256, 256]]);
  assert.equal(mismatches.length, 1);
  assert.ok(mismatches[0].includes("A tile size differed from the plan"));
  assert.ok(!mismatches[0].includes("256,0") && !mismatches[0].includes("http"), "no tile identity leaks");

  // The browser canvas path strips ICC/EXIF, so save guidance warns that
  // colors may shift.
  assert.ok(renderSaveGuidance(true).includes("Colors may shift"));

  // The shipped save path encodes through the canvas host: a blob resolves
  // the save, a null blob fails closed with a typed code, and a tainted
  // canvas error propagates untouched for the display-only fallback.
  const seen = [];
  const blob = { kind: "png-blob" };
  const ok = await canvasToPngBlob({ toBlob: (cb, mime) => { seen.push(mime); cb(blob); } });
  assert.equal(ok, blob);
  assert.deepEqual(seen, ["image/png"]);
  await assert.rejects(canvasToPngBlob({ toBlob: (cb) => cb(null) }), (error) => error.code === "OUTPUT_ENCODE_FAILED");
  const taint = new Error("tainted");
  taint.name = "SecurityError";
  assert.equal(isCanvasTaintError(taint), true);
  await assert.rejects(canvasToPngBlob({ toBlob: () => { throw taint; } }), (error) => error === taint);
});
