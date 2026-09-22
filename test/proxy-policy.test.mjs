// Single proxy policy vector: pins the metadata-only policy that lives once
// in src/server/security.ts and serves POST /api/proxy through
// src/server/proxy.ts plus functions/api/proxy.ts, while GET /proxy keeps the
// legacy policy served from legacy/. Legacy behavior at / stays byte-identical.

import assert from "node:assert/strict";
import test from "node:test";
import * as shim from "../functions/proxy.js";
import { handleProxyRequest } from "../src/server/proxy.ts";
import {
  PROXY_MAX_BYTES,
  PROXY_MAX_REDIRECTS,
  stripUpstreamHeaders,
} from "../src/server/security.ts";

function hdr(obj) {
  const lower = {};
  for (const [k, v] of Object.entries(obj)) lower[k.toLowerCase()] = v;
  return { get: (n) => lower[n.toLowerCase()] ?? null };
}

test("proxy policy vector: 2MB, 5 redirects, header allowlist, manual revalidation, legacy route", async () => {
  assert.equal(PROXY_MAX_BYTES, 2 * 1024 * 1024, "metadata budget is 2MB");
  assert.equal(PROXY_MAX_REDIRECTS, 5, "redirect budget is 5 hops");

  const stripped = stripUpstreamHeaders({
    Accept: "application/json",
    "Accept-Language": "en",
    "User-Agent": "dz-test",
    Range: "bytes=0-99",
    Cookie: "session=secret",
    Authorization: "Bearer secret",
    Referer: "https://evil.test/",
    "X-Custom": "drop",
    Connection: "keep-alive",
  });
  assert.deepEqual(
    Object.keys(stripped).sort(),
    ["accept", "accept-language", "range", "user-agent"],
    "only the narrow safe set flows upstream",
  );

  // Dependency gate: the legacy route module exposes its handlers.
  assert.equal(typeof shim.onRequestGet, "function", "GET /proxy handler exists");
  assert.equal(typeof shim.onRequestHead, "function", "HEAD /proxy handler exists");
  assert.equal(typeof shim.onRequestOptions, "function", "OPTIONS /proxy handler exists");

  // Round trip on the real legacy path: OPTIONS preflight answers locally,
  // and a GET without url fails closed before any upstream fetch.
  const preflight = await shim.onRequestOptions();
  assert.equal(preflight.status, 204, "legacy OPTIONS answers 204");
  const missing = await shim.onRequestGet({ request: new Request("https://site.test/proxy") });
  assert.equal(missing.status, 400, "legacy GET without url fails closed");

  const base = { websiteOrigin: "https://site.test" };
  const chain = (redirectsBeforeSuccess) => {
    let calls = 0;
    return {
      calls: () => calls,
      fetchUpstream: async () => {
        calls += 1;
        if (calls <= redirectsBeforeSuccess) {
          return {
            status: 302,
            headers: hdr({ location: `https://public.test/hop${calls}.json` }),
            async arrayBuffer() {
              return new ArrayBuffer(0);
            },
          };
        }
        return {
          status: 200,
          headers: hdr({ "content-type": "application/json" }),
          async arrayBuffer() {
            return new Uint8Array([1]).buffer;
          },
        };
      },
    };
  };

  const five = chain(5);
  const ok = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/start.json", protocolVersion: 1 },
    { ...base, fetchUpstream: five.fetchUpstream },
  );
  assert.equal(ok.status, 200, "5 redirect hops succeed within budget");
  assert.equal(five.calls(), 6, "5 hops plus the final fetch");

  const six = chain(6);
  const over = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/start.json", protocolVersion: 1 },
    { ...base, fetchUpstream: six.fetchUpstream },
  );
  assert.equal(over.status, 508, "6th hop exceeds the 5-redirect budget");
  assert.equal(over.code, "PROXY_POLICY_DENIED");

  const redirPrivate = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/start.json", protocolVersion: 1 },
    {
      ...base,
      fetchUpstream: async () => ({
        status: 302,
        headers: hdr({ location: "http://169.254.169.254/latest/meta-data" }),
        async arrayBuffer() {
          return new ArrayBuffer(0);
        },
      }),
    },
  );
  assert.equal(redirPrivate.status, 403, "redirect hop revalidates (manual, never followed)");

  const oversize = await handleProxyRequest(
    { method: "POST", targetUrl: "https://public.test/big.json", protocolVersion: 1 },
    {
      ...base,
      fetchUpstream: async () => ({
        status: 200,
        headers: hdr({
          "content-type": "application/json",
          "content-length": String(PROXY_MAX_BYTES + 1),
        }),
        async arrayBuffer() {
          return new Uint8Array([1]).buffer;
        },
      }),
    },
  );
  assert.equal(oversize.status, 413, "declared bytes over 2MB fail closed");
});
