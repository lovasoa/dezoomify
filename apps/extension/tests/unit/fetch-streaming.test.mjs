import assert from "node:assert/strict";
import test from "node:test";
import { forwardCoreHeaders } from "@dezoomify/browser-runtime";
import { createExtensionFetcher } from "../../src/runtime/fetch.ts";

function stream(chunks, { stall = false } = {}) {
  let index = 0;
  let cancelled = false;
  return {
    getReader() {
      return {
        async read() {
          if (stall) return new Promise(() => {});
          if (index >= chunks.length) return { done: true };
          return { done: false, value: chunks[index++] };
        },
        async cancel() {
          cancelled = true;
        },
      };
    },
    get cancelled() {
      return cancelled;
    },
  };
}

function fetcher(fetchImpl) {
  return createExtensionFetcher({ fetchImpl, hasPermission: async () => true });
}

test("streaming body aborts before retaining an oversized chunk", async () => {
  let signal;
  const f = fetcher(async (_url, init) => {
    signal = init.signal;
    return {
      status: 200,
      url: "https://tiles.example/a",
      headers: { "content-type": "image/jpeg" },
      body: stream([new Uint8Array(7), new Uint8Array(7)]),
    };
  });
  await assert.rejects(
    () =>
      f.fetchResource("https://tiles.example/a", {
        userIntent: true,
        purpose: "tile",
        maxBytes: 10,
      }),
    (error) => error.category === "limit-exceeded",
  );
  assert.equal(signal.aborted, true);
});

test("cancellation aborts a stalled fetch", async () => {
  let captured;
  const f = fetcher(async (_url, init) => {
    captured = init.signal;
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      ),
    );
  });
  const pending = f.fetchResource("https://tiles.example/a", { userIntent: true, purpose: "tile" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  f.cancel();
  await assert.rejects(
    () => pending,
    (error) => error.category === "cancelled",
  );
  assert.equal(captured.aborted, true);
});

test("only purpose-appropriate core headers are forwarded", async () => {
  const supplied = [
    { name: "Accept", value: "application/xml" },
    { name: "Range", value: "bytes=0-4" },
    { name: "If-None-Match", value: "etag" },
    { name: "Authorization", value: "secret" },
    { name: "X-Injection\n", value: "bad" },
  ];
  assert.deepEqual(forwardCoreHeaders(supplied, "tile"), {
    accept: "application/xml",
    range: "bytes=0-4",
  });
  assert.deepEqual(forwardCoreHeaders(supplied, "metadata"), {
    accept: "application/xml",
    range: "bytes=0-4",
    "if-none-match": "etag",
  });
});

test("missing grant pauses access instead of prompting", async () => {
  let requests = 0;
  const f = createExtensionFetcher({
    fetchImpl: async () => {
      requests += 1;
      throw new Error("must not fetch");
    },
    hasPermission: async () => false,
  });
  await assert.rejects(
    () => f.fetchResource("https://cdn.example/a", { userIntent: true }),
    (error) =>
      error.category === "access-required" &&
      error.code === "permission-denied" &&
      error.hosts[0] === "https://cdn.example",
  );
  assert.equal(requests, 0);
});

test("granted-origin refusal never pauses for another grant", async () => {
  const f = createExtensionFetcher({
    fetchImpl: async (url) => ({
      status: 403,
      url,
      headers: { "content-type": "text/html" },
      bytes: new Uint8Array([1]),
    }),
    hasPermission: async () => true,
  });
  await assert.rejects(
    () => f.fetchResource("https://cdn.example/a", { userIntent: true, purpose: "metadata" }),
    (error) => error.category === "forbidden" && error.category !== "access-required",
  );
});
