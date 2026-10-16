import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionFetcher } from "../../src/runtime/fetch.ts";

const request = {
  uri: "https://example.test/image.zif",
  purpose: "metadata",
  headers: [{ name: "Range", value: "bytes=10-13" }],
};
const signal = new AbortController().signal;

test("extension transport forwards byte ranges and rejects servers that ignore them", async () => {
  const responses = [
    new Response("data", { status: 206, headers: { "content-range": "bytes 10-13/100" } }),
    new Response("whole file"),
  ];
  const fetcher = createExtensionFetcher({
    hasPermission: () => true,
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers.range, "bytes=10-13");
      return responses.shift();
    },
  });
  assert.equal(
    new TextDecoder().decode((await fetcher.fetchResource(request, signal)).bytes),
    "data",
  );
  await assert.rejects(fetcher.fetchResource(request, signal), { kind: "bad-url" });
});
