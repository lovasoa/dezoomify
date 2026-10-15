import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionFetcher } from "../../src/runtime/fetch.ts";

const request = {
  uri: "https://example.test/image.zif",
  purpose: "metadata",
  headers: [{ name: "Range", value: "bytes=10-13" }],
};
const signal = new AbortController().signal;

test("extension transport forwards and validates exact byte ranges", async () => {
  const fetcher = createExtensionFetcher({
    hasPermission: () => true,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.range, "bytes=10-13");
      return new Response("data", { status: 206, headers: { "content-range": "bytes 10-13/100" } });
    },
  });
  assert.equal(
    new TextDecoder().decode((await fetcher.fetchResource(request, signal)).bytes),
    "data",
  );
});

test("extension transport rejects ignored, mismatched, and truncated range responses", async () => {
  for (const response of [
    new Response("whole file"),
    new Response("data", { status: 206, headers: { "content-range": "bytes 0-3/100" } }),
    new Response("abc", { status: 206, headers: { "content-range": "bytes 10-13/100" } }),
  ]) {
    const fetcher = createExtensionFetcher({
      hasPermission: () => true,
      fetchImpl: async () => response,
    });
    await assert.rejects(fetcher.fetchResource(request, signal), { kind: "bad-url" });
  }
});
