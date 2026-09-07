import test from "node:test";
import assert from "node:assert/strict";
import {
  activeWebEntry,
  cancelAllWeb,
  cancelWebEntry,
  createWebQueue,
  enqueueWebQueue,
  finishActiveWebEntry,
  humanWebQueueSummary,
  isWebQueueAvailable,
  pendingWebEntries,
  retryWebEntry,
  summarizeWebQueue,
} from "../src/queue.ts";

test("website single-queue is capability-gated with N-1 compat", () => {
  assert.equal(isWebQueueAvailable({ bulkSupported: true }), true);
  assert.equal(isWebQueueAvailable({ bulkSupported: false }), false);
  assert.equal(isWebQueueAvailable({}), false);
  assert.equal(isWebQueueAvailable(null), false);
  assert.equal(isWebQueueAvailable(undefined), false);
});

test("enqueue while idle activates, further submits wait FIFO", () => {
  let q = createWebQueue();
  const first = enqueueWebQueue(q, "https://example.com/a");
  assert.equal(first.code, "ok");
  q = first.queue;
  assert.equal(first.entry.status, "active");
  assert.equal(q.activeId, first.entry.id);
  const second = enqueueWebQueue(q, "https://example.com/b");
  q = second.queue;
  assert.equal(second.entry.status, "queued");
  assert.equal(q.activeId, first.entry.id);
  assert.deepEqual(
    pendingWebEntries(q).map((e) => e.url),
    ["https://example.com/b"],
  );
  assert.equal(activeWebEntry(q).url, "https://example.com/a");
});

test("invalid URLs rejected without state change", () => {
  let q = createWebQueue();
  for (const bad of ["", "file:///etc/passwd", "https://user:pass@example.com/x", `https://example.com/${"a".repeat(2048)}`]) {
    const before = q.entries.length;
    const res = enqueueWebQueue(q, bad);
    assert.equal(res.code, "job.invalid-input");
    assert.equal(res.entry, null);
    assert.equal(res.queue.entries.length, before);
    q = res.queue;
  }
  assert.equal(q.activeId, null);
});

test("failed entry does not stop the rest; sequential advance", () => {
  let q = createWebQueue();
  q = enqueueWebQueue(q, "https://example.com/a").queue;
  q = enqueueWebQueue(q, "https://example.com/b").queue;
  q = enqueueWebQueue(q, "https://example.com/c").queue;
  const active = activeWebEntry(q).id;
  const step1 = finishActiveWebEntry(q, "failed", "tile.download-failed");
  q = step1.queue;
  assert.ok(step1.next);
  assert.equal(step1.next.url, "https://example.com/b");
  assert.equal(activeWebEntry(q).url, "https://example.com/b");
  const step2 = finishActiveWebEntry(q, "done");
  q = step2.queue;
  assert.equal(activeWebEntry(q).url, "https://example.com/c");
  const step3 = finishActiveWebEntry(q, "done");
  q = step3.queue;
  assert.equal(step3.next, null);
  assert.equal(q.activeId, null);
  const summary = summarizeWebQueue(q);
  assert.deepEqual(summary, { total: 3, succeeded: 2, failed: 1, cancelled: 0, pending: 0 });
  assert.equal(humanWebQueueSummary(summary), "bulk: 2 succeeded, 1 failed, 3 total");
});

test("cancel one and cancel all stop new work", () => {
  let q = createWebQueue();
  q = enqueueWebQueue(q, "https://example.com/a").queue;
  q = enqueueWebQueue(q, "https://example.com/b").queue;
  const active = activeWebEntry(q).id;
  const waiting = pendingWebEntries(q)[0].id;
  const cancelledWaiting = cancelWebEntry(q, waiting);
  assert.equal(cancelledWaiting.code, "ok");
  q = cancelledWaiting.queue;
  assert.equal(activeWebEntry(q).id, active);
  assert.deepEqual(pendingWebEntries(q), []);
  q = cancelAllWeb(q);
  assert.equal(q.activeId, null);
  assert.ok(q.entries.every((e) => e.status === "cancelled"));
  const stale = cancelWebEntry(q, active);
  assert.equal(stale.code, "job.stale");
});

test("retry failed re-queues behind the line", () => {
  let q = createWebQueue();
  q = enqueueWebQueue(q, "https://example.com/a").queue;
  const active = activeWebEntry(q).id;
  q = finishActiveWebEntry(q, "failed", "tile.download-failed").queue;
  assert.equal(activeWebEntry(q), null);
  const retried = retryWebEntry(q, active);
  assert.equal(retried.code, "ok");
  q = retried.queue;
  assert.equal(activeWebEntry(q).url, "https://example.com/a");
  const unknown = retryWebEntry(q, "webq:missing");
  assert.equal(unknown.code, "job.unknown");
});
