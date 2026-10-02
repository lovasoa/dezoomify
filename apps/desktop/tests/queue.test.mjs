import assert from "node:assert/strict";
import test from "node:test";
import {
  activeQueueEntry as activeDesktopEntry,
  cancelAllQueueEntries as cancelAllDesktop,
  cancelQueueEntry as cancelDesktopEntry,
  finishActiveQueueEntry as finishActiveDesktopEntry,
  summarizeQueue as summarizeDesktopQueue,
} from "@dezoomify/shared-ui";
import {
  createDesktopQueue,
  enqueueDesktopQueue,
  recordDesktopProgress,
  retryDesktopEntry,
} from "../src/queue.ts";

const queuedEntries = (q) => q.entries.filter((e) => e.status === "queued");

test("enqueue validates and runs one active job at a time", () => {
  let q = createDesktopQueue();
  const first = enqueueDesktopQueue(q, "https://example.com/a");
  assert.equal(first.code, "ok");
  q = first.queue;
  assert.equal(first.entry.status, "active");
  const second = enqueueDesktopQueue(q, "https://example.com/b");
  q = second.queue;
  assert.equal(second.entry.status, "queued");
  assert.equal(activeDesktopEntry(q).inputUrl, "https://example.com/a");
  assert.deepEqual(
    queuedEntries(q).map((e) => e.inputUrl),
    ["https://example.com/b"],
  );
  for (const bad of [
    "",
    "file:///etc/passwd",
    "https://user:pass@example.com/x",
    `https://example.com/${"a".repeat(2048)}`,
  ]) {
    const before = q.entries.length;
    const res = enqueueDesktopQueue(q, bad);
    assert.equal(res.code, "job.invalid-input");
    assert.equal(res.entry, null);
    assert.equal(res.queue.entries.length, before);
  }
});

test("progress per job is monotonic and never claims unknown totals", () => {
  let q = createDesktopQueue();
  q = enqueueDesktopQueue(q, "https://example.com/a").queue;
  const id = activeDesktopEntry(q).id;
  q = recordDesktopProgress(q, id, 5, 10).queue;
  assert.deepEqual(activeDesktopEntry(q).progress, { acquired: 5, total: 10 });
  q = recordDesktopProgress(q, id, 2, 10).queue;
  assert.deepEqual(activeDesktopEntry(q).progress, { acquired: 5, total: 10 });
  q = recordDesktopProgress(q, id, 7, 10).queue;
  assert.deepEqual(activeDesktopEntry(q).progress, { acquired: 7, total: 10 });
  const unknown = cancelDesktopEntry(q, "jobq:missing");
  assert.equal(unknown.code, "job.unknown");
});

test("failed entry does not stop the rest and totals reflect all entries", () => {
  let q = createDesktopQueue();
  q = enqueueDesktopQueue(q, "https://example.com/a").queue;
  q = enqueueDesktopQueue(q, "https://example.com/b").queue;
  q = enqueueDesktopQueue(q, "https://example.com/c").queue;
  q = finishActiveDesktopEntry(q, "failed", "job.partial-discarded").queue;
  assert.equal(activeDesktopEntry(q).inputUrl, "https://example.com/b");
  q = finishActiveDesktopEntry(q, "done").queue;
  assert.equal(activeDesktopEntry(q).inputUrl, "https://example.com/c");
  q = finishActiveDesktopEntry(q, "done").queue;
  assert.equal(q.activeId, null);
  const summary = summarizeDesktopQueue(q);
  assert.deepEqual(summary, { total: 3, succeeded: 2, failed: 1, cancelled: 0, pending: 0 });
});

test("cancel one and cancel all stop issuing new work", () => {
  let q = createDesktopQueue();
  q = enqueueDesktopQueue(q, "https://example.com/a").queue;
  q = enqueueDesktopQueue(q, "https://example.com/b").queue;
  const active = activeDesktopEntry(q).id;
  const waiting = queuedEntries(q)[0].id;
  let res = cancelDesktopEntry(q, waiting);
  assert.equal(res.code, "ok");
  q = res.queue;
  assert.equal(activeDesktopEntry(q).id, active);
  q = cancelAllDesktop(q);
  assert.equal(q.activeId, null);
  assert.ok(q.entries.every((e) => e.status === "cancelled"));
  res = cancelDesktopEntry(q, active);
  assert.equal(res.code, "job.stale");
});

test("retry failed moves behind the line and preserves the input URL", () => {
  let q = createDesktopQueue();
  q = enqueueDesktopQueue(q, "https://example.com/a?token=CANARY").queue;
  const active = activeDesktopEntry(q).id;
  q = finishActiveDesktopEntry(q, "failed", "job.partial-discarded").queue;
  const retried = retryDesktopEntry(q, active);
  assert.equal(retried.code, "ok");
  assert.notEqual(retried.entry.id, active);
  q = retried.queue;
  assert.equal(activeDesktopEntry(q).inputUrl, "https://example.com/a?token=CANARY");
  const bad = retryDesktopEntry(q, active);
  assert.equal(bad.code, "job.unknown");
});
