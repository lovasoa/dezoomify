import assert from "node:assert/strict";
import test from "node:test";
import {
  activeQueueEntry as activeWebEntry,
  finishActiveQueueEntry as finishActiveWebEntry,
} from "@dezoomify/app-model";
import { createWebQueue, enqueueWebQueue, retryWebEntry } from "../src/queue.ts";

test("website queue validates and stores trimmed HTTP(S) URLs", () => {
  let q = createWebQueue();
  for (const bad of [
    "",
    "file:///etc/passwd",
    "https://user:pass@example.com/x",
    `https://example.com/${"a".repeat(2048)}`,
    42,
  ]) {
    const result = enqueueWebQueue(q, bad);
    assert.equal(result.code, "job.invalid-input");
    assert.equal(result.entry, null);
    assert.equal(result.queue, q);
  }

  const accepted = enqueueWebQueue(q, "  https://example.com/first  ");
  assert.equal(accepted.code, "ok");
  assert.equal(accepted.entry.id, "webq:0");
  assert.equal(accepted.entry.url, "https://example.com/first");
  assert.equal(accepted.entry.status, "active");
  q = accepted.queue;

  const queued = enqueueWebQueue(q, "https://example.com/second");
  assert.equal(queued.code, "ok");
  assert.equal(queued.entry.id, "webq:1");
  assert.equal(queued.entry.url, "https://example.com/second");
  assert.equal(queued.entry.status, "queued");
  assert.equal(activeWebEntry(queued.queue).url, "https://example.com/first");
});

test("website retry carries the failed entry URL into a fresh product entry", () => {
  let q = createWebQueue();
  const submitted = enqueueWebQueue(q, "https://example.com/retry");
  q = finishActiveWebEntry(submitted.queue, "failed", "tile.download-failed").queue;

  const retried = retryWebEntry(q, submitted.entry.id);
  assert.equal(retried.code, "ok");
  assert.equal(retried.entry.url, submitted.entry.url);
  assert.notEqual(retried.entry.id, submitted.entry.id);
  assert.match(retried.entry.id, /^webq:/);
});
