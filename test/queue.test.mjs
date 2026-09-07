import test from "node:test";
import assert from "node:assert/strict";
import {
  activeWebEntry,
  cancelAllWeb,
  createWebQueue,
  enqueueWebQueue,
  finishActiveWebEntry,
  humanWebQueueSummary,
  isWebQueueAvailable,
  summarizeWebQueue,
} from "../packages/browser-runtime/src/queue.ts";

// Website single-queue (todo 5.3): enqueue while a job runs, sequential over
// the single-job engine. These tests drive the integration-layer queue the
// website orchestrator (src/main.ts) uses, including the N-1 capability gate
// and the hash-only-current-URL invariant.

test("web queue is capability-gated with N-1 compat", () => {
  // Current website baseline offers the queue.
  assert.equal(isWebQueueAvailable({ bulkSupported: true }), true);
  // N-1 peers (bulk_supported false, or a payload omitting the field)
  // disable queue controls without breaking the handshake.
  assert.equal(isWebQueueAvailable({ bulkSupported: false }), false);
  assert.equal(isWebQueueAvailable({}), false);
  assert.equal(isWebQueueAvailable(null), false);
  assert.equal(isWebQueueAvailable(undefined), false);
});

test("enqueue while running waits FIFO and runs sequentially", () => {
  let q = createWebQueue();
  q = enqueueWebQueue(q, "https://example.com/first").queue;
  assert.equal(activeWebEntry(q).url, "https://example.com/first");
  // A second submit while the first runs waits instead of cancelling it.
  const queued = enqueueWebQueue(q, "https://example.com/second");
  q = queued.queue;
  assert.equal(queued.entry.status, "queued");
  assert.equal(activeWebEntry(q).url, "https://example.com/first");
  // Settling the active job starts the waiting one; the engine never runs two.
  const settled = finishActiveWebEntry(q, "done");
  q = settled.queue;
  assert.equal(settled.next.url, "https://example.com/second");
  assert.equal(activeWebEntry(q).url, "https://example.com/second");
});

test("hash stays owned by the active URL only", () => {
  // Models src/main.ts writeHash discipline: only the running job writes the
  // location hash; queued URLs never do until they become active.
  let q = createWebQueue();
  let hash = "";
  const writeHash = (url) => {
    hash = `#${url}`;
  };
  q = enqueueWebQueue(q, "https://example.com/first").queue;
  writeHash(activeWebEntry(q).url);
  assert.equal(hash, "#https://example.com/first");
  q = enqueueWebQueue(q, "https://example.com/second").queue;
  assert.equal(hash, "#https://example.com/first", "queued submit must not touch the hash");
  q = finishActiveWebEntry(q, "done").queue;
  writeHash(activeWebEntry(q).url);
  assert.equal(hash, "#https://example.com/second", "promoted job takes hash ownership");
});

test("failed entry never stops the rest with CLI-parity totals", () => {
  let q = createWebQueue();
  q = enqueueWebQueue(q, "https://example.com/a").queue;
  q = enqueueWebQueue(q, "https://example.com/b").queue;
  q = enqueueWebQueue(q, "https://example.com/c").queue;
  q = finishActiveWebEntry(q, "failed", "tile.download-failed").queue;
  assert.equal(activeWebEntry(q).url, "https://example.com/b");
  q = finishActiveWebEntry(q, "done").queue;
  q = finishActiveWebEntry(q, "done").queue;
  assert.equal(q.activeId, null);
  const summary = summarizeWebQueue(q);
  assert.deepEqual(summary, { total: 3, succeeded: 2, failed: 1, cancelled: 0, pending: 0 });
  assert.equal(humanWebQueueSummary(summary), "bulk: 2 succeeded, 1 failed, 3 total");
});

test("cancel-all issues no new work", () => {
  let q = createWebQueue();
  q = enqueueWebQueue(q, "https://example.com/a").queue;
  q = enqueueWebQueue(q, "https://example.com/b").queue;
  q = cancelAllWeb(q);
  assert.equal(q.activeId, null);
  assert.ok(q.entries.every((e) => e.status === "cancelled"));
});
