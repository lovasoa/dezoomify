import assert from "node:assert/strict";
import test from "node:test";
import { readRequestedBytes, requestedByteRange } from "../src/byte-range.ts";

const range = { start: 10, end: 13, length: 4 };
const headers = { "content-range": "bytes 10-13/100", "content-length": "4" };

test("requests accept one finite safe byte range and reject ambiguous ranges", () => {
  assert.equal(requestedByteRange([]), undefined);
  assert.deepEqual(requestedByteRange([{ name: "rAnGe", value: "bytes=10-13" }]), range);
  for (const value of [
    "bytes=-4",
    "bytes=10-",
    "bytes=10-9",
    "bytes=0-1,4-5",
    "bytes=0-9007199254740991",
    "bytes=9007199254740992-9007199254740993",
    "items=0-1",
  ]) {
    assert.throws(() => requestedByteRange([{ name: "Range", value }]), { kind: "bad-url" });
  }
  assert.throws(
    () =>
      requestedByteRange([
        { name: "Range", value: "bytes=0-1" },
        { name: "range", value: "bytes=0-1" },
      ]),
    { kind: "bad-url" },
  );
});

test("exact partial responses retain the requested bytes", async () => {
  const response = new Response("data", { status: 206, headers });
  const bytes = await readRequestedBytes(
    {
      status: response.status,
      headers: { get: (name) => response.headers.get(name) },
      body: response.body,
    },
    range,
    8,
  );
  assert.equal(new TextDecoder().decode(bytes), "data");
});

test("ignored and mismatched ranges cancel before consuming the response", async () => {
  for (const [status, responseHeaders] of [
    [200, headers],
    [206, {}],
    [206, { ...headers, "content-range": "bytes 11-14/100" }],
    [206, { ...headers, "content-range": "bytes 10-13/*" }],
    [206, { ...headers, "content-range": "bytes 10-13/13" }],
    [206, { ...headers, "content-range": "bytes 10-13/9007199254740992" }],
    [206, { ...headers, "content-length": "5" }],
  ]) {
    let cancelled = false;
    const body = new ReadableStream(
      {
        pull() {
          assert.fail("invalid response body must not be consumed");
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(
      readRequestedBytes(new Response(body, { status, headers: responseHeaders }), range, 8),
      { kind: "bad-url" },
    );
    assert.equal(cancelled, true);
  }
});

test("partial responses reject truncated, oversized, and over-budget bodies", async () => {
  const response = (body) =>
    new Response(body, { status: 206, headers: { "content-range": headers["content-range"] } });
  await assert.rejects(readRequestedBytes(response("abc"), range, 8), { kind: "bad-url" });
  await assert.rejects(readRequestedBytes(response("abcde"), range, 8), {
    kind: "size-limit",
    max_bytes: 4,
  });
  await assert.rejects(readRequestedBytes(response("data"), range, 3), {
    kind: "size-limit",
    max_bytes: 3,
  });
});
