import assert from "node:assert/strict";
import { handleProxyRequest } from "../../src/server/proxy.ts";
import { forwardedClientHeaders } from "../../src/server/security.ts";

// Browser DNS maps a public hostname to this separate, deliberately no-CORS
// fixture origin. Relay policy stays real; only upstream transport is mapped.
export async function startPublicFixtureSource() {
  const { startFixtureServer } = await import("../fixture-server.mjs");
  const { server, origin } = await startFixtureServer({ cors: false, quiet: true });
  const requests = [];
  server.on("request", (req) => requests.push(req.headers));
  return {
    origin,
    requests,
    port: server.address().port,
    publicOrigin: "http://source.test",
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export async function relayFixtureRequest(route, source, websiteOrigin, observations) {
  const request = route.request();
  const body = request.postDataJSON();
  const headers = forwardedClientHeaders(request.headers());
  const result = await handleProxyRequest(
    { method: request.method(), ...body, headers },
    {
      websiteOrigin,
      fetchUpstream: async (url, init) => {
        const target = new URL(url);
        assert.equal(target.origin, source.publicOrigin);
        return fetch(new URL(target.pathname + target.search, source.origin), {
          ...init,
          redirect: "manual",
        });
      },
    },
  );
  const bytes = result.body === undefined ? undefined : Buffer.from(result.body);
  observations.push({
    target: body.targetUrl,
    range: headers.range,
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
