import assert from "node:assert/strict";
import test from "node:test";
import {
  activeQueueEntry,
  cancelAllQueueEntries,
  createSequentialQueue,
  enqueueSequential,
  finishActiveQueueEntry,
  isValidInputUrl,
  readInitialUrl,
  retryQueueEntry,
  summarizeQueue,
} from "../packages/shared-ui/src/index.ts";

test("website input accepts ordinary HTTP(S) URLs only", () => {
  for (const bad of [
    "",
    "file:///etc/passwd",
    "https://user:pass@example.com/x",
    `https://example.com/${"a".repeat(2048)}`,
    42,
  ])
    assert.equal(isValidInputUrl(bad), false);
  assert.equal(isValidInputUrl("  https://example.com/first  "), true);
});

test("prefill refuses secret-bearing candidates before any job starts", () => {
  assert.equal(readInitialUrl({ search: "?url=https://example.com/ok" }), "https://example.com/ok");
  for (const loc of [
    { search: "?url=https://example.com/item?token=secret" },
    { search: "?src=https://example.com/item?APIKEY=secret" },
    { hash: "#url=https%3A%2F%2Fexample.com%2Fitem%3Fsig%3Dabc" },
    { hash: "#https://example.com/item#session=abc" },
  ])
    assert.equal(readInitialUrl(loc), null, JSON.stringify(loc));
});

test("queue advances in order and retries with the same URL and a fresh identity", () => {
  let queue = createSequentialQueue("webq:");
  const first = enqueueSequential(queue, (id, status) => ({
    id,
    status,
    url: "https://example.com/first",
  }));
  const second = enqueueSequential(first.queue, (id, status) => ({
    id,
    status,
    url: "https://example.com/second",
  }));
  queue = second.queue;
  assert.equal(first.entry.status, "active");
  assert.equal(second.entry.status, "queued");
  assert.equal(activeQueueEntry(queue).id, first.entry.id);
  queue = finishActiveQueueEntry(queue, "failed", "tile.download-failed").queue;
  assert.equal(activeQueueEntry(queue).id, second.entry.id);
  const retried = retryQueueEntry(queue, first.entry.id, (id, previous, status) => ({
    id,
    status,
    url: previous.url,
  }));
  assert.equal(retried.code, "ok");
  assert.equal(retried.entry.url, first.entry.url);
  assert.notEqual(retried.entry.id, first.entry.id);
  assert.equal(retried.entry.status, "queued");
  queue = finishActiveQueueEntry(retried.queue, "done").queue;
  assert.equal(activeQueueEntry(queue).id, retried.entry.id);
  queue = cancelAllQueueEntries(queue);
  assert.equal(activeQueueEntry(queue), null);
  assert.deepEqual(summarizeQueue(queue), {
    total: 2,
    succeeded: 1,
    failed: 0,
    cancelled: 1,
    pending: 0,
  });
});
