import assert from "node:assert/strict";
import http from "node:http";
import { handleProxyRequest } from "../../src/server/proxy.ts";
import { forwardedClientHeaders } from "../../src/server/security.ts";

export const PUBLIC_ZIF_URL = "http://zif-relay.test/image.zif";

// Chromium maps the public test hostname to this separate loopback origin.
// Unlike the shared fixture server, this source deliberately grants no CORS.
export async function startNoCorsZifServer() {
  const { serve } = await import("../../fixtures/zif/approximate-basic/server.js");
  const requests = [];
  const server = http.createServer(async (req, res) => {
    try {
      const fixture = new Request(
        "http://zif-relay.test/fixtures/zif/approximate-basic/image.zif",
        { method: req.method, headers: req.headers },
      );
      const response =
        new URL(req.url, PUBLIC_ZIF_URL).pathname === "/image.zif"
          ? serve(fixture)
          : new Response("Unknown fixture", { status: 404 });
      const body = Buffer.from(await response.arrayBuffer());
      requests.push({
        range: req.headers.range,
        origin: req.headers.origin,
        status: response.status,
      });
      res.writeHead(response.status, {
        ...Object.fromEntries(response.headers),
        "content-length": body.length,
      });
      res.end(body);
    } catch (error) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    port,
    requests,
    origin: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

// Keep the real relay and its public-target, header, MIME, range and size
// policies. Only its transport maps this one public URL to a local source.
export async function relayZifRequest(route, sourceOrigin, websiteOrigin, observations) {
  const request = route.request();
  const body = request.postDataJSON();
  const incomingHeaders = request.headers();
  const result = await handleProxyRequest(
    {
      method: request.method(),
      targetUrl: body.targetUrl,
      protocolVersion: body.protocolVersion,
      origin: incomingHeaders.origin,
      headers: forwardedClientHeaders(incomingHeaders),
    },
    {
      websiteOrigin,
      fetchUpstream: async (url, init) => {
        assert.equal(url, PUBLIC_ZIF_URL, "the relay must preserve the public container URL");
        return fetch(new URL("/image.zif", sourceOrigin), { ...init, redirect: "manual" });
      },
    },
  );
  const bytes = result.body === undefined ? null : Buffer.from(result.body);
  observations.push({
    target: body.targetUrl,
    range: incomingHeaders.range,
    status: result.status,
    jpeg: bytes?.[0] === 0xff && bytes?.[1] === 0xd8,
  });
  await route.fulfill({
    status: result.status,
    headers: result.headers,
    body:
      bytes ??
      JSON.stringify({
        code: result.code,
        reason: result.reason,
        requestId: result.requestId,
        preview: result.preview,
      }),
  });
}
