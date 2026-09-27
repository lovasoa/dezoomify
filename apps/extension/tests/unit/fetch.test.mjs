import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { asFetchFailure, createExtensionFetcher } from "../../src/runtime/fetch.ts";

let origin;
const requests = [];
const server = createServer((request, response) => {
  requests.push(request);
  if (request.url === "/redirect") return response.writeHead(302, { location: "/image" }).end();
  if (request.url === "/stall")
    return response.writeHead(200, { "content-type": "image/png" }).write("first chunk");
  response.writeHead(Number(request.url.slice(1)) || 200, {
    "content-type": request.url === "/html" ? "text/html" : "image/png",
    "retry-after": "3",
  });
  response.end("image bytes");
});
test.before(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => {
  server.closeAllConnections();
  server.close();
});
const resource = (path, purpose = "tile") => ({ id: 7, uri: origin + path, purpose, headers: [] });
const fetcher = (options = {}) => createExtensionFetcher({ hasPermission: () => true, ...options });
const signal = () => new AbortController().signal;

test("redirects retain their final URI and generated headers reach the network", async () => {
  const request = {
    ...resource("/redirect", "metadata"),
    headers: [
      { name: "Accept", value: "image/png" },
      { name: "Authorization", value: "must-not-leave" },
    ],
  };
  const result = await fetcher().fetchResource(request, signal());
  assert.equal(result.finalUri, origin + "/image");
  assert.equal(new TextDecoder().decode(result.bytes), "image bytes");
  assert.equal(requests.at(-1).headers.accept, "image/png");
  assert.equal(requests.at(-1).headers.authorization, undefined);
});

test("metadata accepts viewer HTML but tiles reject it", async () => {
  assert.equal(
    (await fetcher().fetchResource(resource("/html", "metadata"), signal())).bytes.length,
    11,
  );
  await assert.rejects(
    fetcher().fetchResource(resource("/html"), signal()),
    /unsupported response type/,
  );
});

test("HTTP refusals and throttles retain status without becoming permission requests", async () => {
  for (const status of [401, 403, 429, 503]) {
    await assert.rejects(fetcher().fetchResource(resource(`/${status}`), signal()), (error) => {
      const failure = asFetchFailure(error);
      assert.equal(failure.http, status);
      assert.equal(failure.retryable, status >= 429);
      assert.notEqual(error.code, "permission-denied");
      if (status === 429) assert.equal(failure.retry_after_ms, 3000);
      return true;
    });
  }
});

test("missing grants and forbidden URLs do not perform network requests", async () => {
  const before = requests.length;
  await assert.rejects(
    fetcher({ hasPermission: () => false }).fetchResource(resource("/image"), signal()),
    { code: "permission-denied" },
  );
  await assert.rejects(fetcher().fetchResource(resource("/api/proxy?u=secret"), signal()), /proxy/);
  await assert.rejects(
    fetcher().fetchResource({ ...resource("/image"), uri: "file:///etc/passwd" }, signal()),
    /scheme/,
  );
  assert.equal(requests.length, before);
});

test("oversized response bodies fail before becoming image bytes", async () => {
  await assert.rejects(fetcher({ maxBytes: 4 }).fetchResource(resource("/image"), signal()), {
    category: "limit-exceeded",
  });
});

test("the attempt signal cancels a stalled real request", async () => {
  const controller = new AbortController();
  const arrived = once(server, "request");
  const pending = fetcher().fetchResource(resource("/stall"), controller.signal);
  await arrived;
  controller.abort();
  await assert.rejects(pending, { category: "cancelled" });
});

test("a request deadline stays distinguishable from user cancellation", async () => {
  let expire;
  const arrived = once(server, "request");
  const pending = fetcher({
    setTimeoutFn: (fn) => {
      expire = fn;
      return 0;
    },
    clearTimeoutFn: () => {},
  }).fetchResource(resource("/stall"), signal());
  await arrived;
  expire();
  await assert.rejects(
    pending,
    (error) => error.category === "network" && error.message === "fetch timeout",
  );
});
