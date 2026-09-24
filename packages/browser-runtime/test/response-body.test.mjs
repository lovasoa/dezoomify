import assert from "node:assert/strict";
import test from "node:test";
import { readErrorPreview, readResponseBytes } from "../src/response-body.ts";

test("an unknown-length error body is cancelled after a bounded diagnostic prefix", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      pull(c) {
        c.enqueue(new TextEncoder().encode("<b>upstream refused</b>".repeat(500)));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  assert.ok((await readErrorPreview(response)).length <= 300);
  assert.equal(cancelled, true);
});

test("cancelling an attempt releases a stalled response reader", async () => {
  const controller = new AbortController();
  const pending = readResponseBytes(new Response(new ReadableStream()), 1024, controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
