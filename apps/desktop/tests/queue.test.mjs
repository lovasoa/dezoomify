import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeDesktopEntry,
  cancelAllDesktop,
  cancelDesktopEntry,
  createDesktopQueue,
  enqueueDesktopQueue,
  finishActiveDesktopEntry,
  humanDesktopQueueSummary,
  isDesktopQueueAvailable,
  machineDesktopQueueSummary,
  pendingDesktopEntries,
  recordDesktopProgress,
  redactedOriginForQueue,
  retryDesktopEntry,
  summarizeDesktopQueue,
} from "../src/queue.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCENARIOS = path.join(HERE, "..", "..", "..", "testdata", "scenarios", "desktop");

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(SCENARIOS, rel), "utf8"));
}

test("desktop queue is capability-gated with N-1 compat", () => {
  assert.equal(isDesktopQueueAvailable({ bulkSupported: true }), true);
  assert.equal(isDesktopQueueAvailable({ bulkSupported: false }), false);
  assert.equal(isDesktopQueueAvailable({}), false);
  assert.equal(isDesktopQueueAvailable(null), false);
});

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
    pendingDesktopEntries(q).map((e) => e.inputUrl),
    ["https://example.com/b"],
  );
  for (const bad of ["", "file:///etc/passwd", "https://user:pass@example.com/x", `https://example.com/${"a".repeat(2048)}`]) {
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

test("failed entry does not stop the rest with CLI-parity summary", () => {
  let q = createDesktopQueue();
  q = enqueueDesktopQueue(q, "https://example.com/a").queue;
  q = enqueueDesktopQueue(q, "https://example.com/b").queue;
  q = enqueueDesktopQueue(q, "https://example.com/c").queue;
  q = finishActiveDesktopEntry(q, "failed", { errorCode: "tile.download-failed" }).queue;
  assert.equal(activeDesktopEntry(q).inputUrl, "https://example.com/b");
  q = finishActiveDesktopEntry(q, "done", { outputHash: "sha256:abc" }).queue;
  assert.equal(activeDesktopEntry(q).inputUrl, "https://example.com/c");
  q = finishActiveDesktopEntry(q, "done", { outputHash: "sha256:def" }).queue;
  assert.equal(q.activeId, null);
  const summary = summarizeDesktopQueue(q);
  assert.deepEqual(summary, { total: 3, succeeded: 2, failed: 1, cancelled: 0, pending: 0 });
  assert.equal(humanDesktopQueueSummary(summary), "bulk: 2 succeeded, 1 failed, 3 total");
  const machine = JSON.parse(machineDesktopQueueSummary(summary));
  assert.equal(machine.kind, "bulk-completed");
  assert.equal(machine.total, 3);
  assert.equal(machine.succeeded, 2);
  assert.equal(machine.failed, 1);
});

test("cancel one and cancel all stop issuing new work", () => {
  let q = createDesktopQueue();
  q = enqueueDesktopQueue(q, "https://example.com/a").queue;
  q = enqueueDesktopQueue(q, "https://example.com/b").queue;
  const active = activeDesktopEntry(q).id;
  const waiting = pendingDesktopEntries(q)[0].id;
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

test("retry failed moves behind the line and reports redacted origins only", () => {
  let q = createDesktopQueue();
  q = enqueueDesktopQueue(q, "https://example.com/a?token=CANARY").queue;
  const active = activeDesktopEntry(q).id;
  assert.equal(redactedOriginForQueue("https://example.com/a?token=CANARY"), "https://example.com");
  q = finishActiveDesktopEntry(q, "failed", { errorCode: "tile.download-failed" }).queue;
  const retried = retryDesktopEntry(q, active);
  assert.equal(retried.code, "ok");
  q = retried.queue;
  assert.equal(activeDesktopEntry(q).origin, "https://example.com");
  assert.ok(!JSON.stringify(summarizeDesktopQueue(q)).includes("CANARY"));
  const bad = retryDesktopEntry(q, active);
  assert.equal(bad.code, "job.unknown");
});

// Deterministic queue scenarios (testdata/scenarios/desktop/queue-*): the
// scripted steps drive the real integration-layer queue module and the
// golden per-entry outcomes, totals, and ordered transcript must match.
function runQueueScript(doc) {
  let q = createDesktopQueue();
  const events = [];
  const byIndex = [];
  for (const step of doc.script) {
    if (step.op === "enqueue") {
      const url = doc.entries[step.index].url;
      const res = enqueueDesktopQueue(q, url);
      assert.equal(res.code, "ok", `enqueue ${url}`);
      q = res.queue;
      byIndex[step.index] = res.entry.id;
      events.push({
        entry: res.entry.id,
        transition: res.entry.status,
        ...(res.entry.status === "active" || res.entry.status === "queued"
          ? { origin: res.entry.origin }
          : {}),
      });
    } else if (step.op === "progress") {
      const active = activeDesktopEntry(q);
      assert.ok(active, "progress needs an active entry");
      const res = recordDesktopProgress(q, active.id, step.acquired, step.total);
      assert.equal(res.code, "ok");
      q = res.queue;
      events.push({
        entry: active.id,
        transition: "progress",
        progress: { acquired: step.acquired, total: step.total },
      });
    } else if (step.op === "finish") {
      const active = activeDesktopEntry(q);
      assert.ok(active, "finish needs an active entry");
      const detail = {};
      if (step.outputHash) detail.outputHash = step.outputHash;
      if (step.errorCode) detail.errorCode = step.errorCode;
      const res = finishActiveDesktopEntry(q, step.outcome, detail);
      events.push({
        entry: active.id,
        transition: step.outcome,
        ...(step.errorCode ? { errorCode: step.errorCode } : {}),
      });
      q = res.queue;
      if (res.next) {
        events.push({ entry: res.next.id, transition: "active" });
      }
    } else if (step.op === "retry") {
      const res = retryDesktopEntry(q, step.entry);
      assert.equal(res.code, "ok", `retry ${step.entry}`);
      q = res.queue;
      assert.ok(res.entry);
      events.push({ entry: res.entry.id, transition: res.entry.status, origin: res.entry.origin });
    } else {
      assert.fail(`unknown script op ${step.op}`);
    }
  }
  return { queue: q, events, byIndex };
}

for (const id of ["queue-basic", "queue-retry"]) {
  test(`scenario ${id}: scripted queue run matches golden outcomes and transcript`, () => {
    const doc = readJson(`${id}/expected/result.json`);
    const transcript = readJson(`${id}/expected/transcript.json`);
    assert.equal(doc.scenario, `desktop/${id}`);
    assert.equal(doc.capabilities.bulkSupported, true, "queue scenarios need bulkSupported");
    assert.equal(doc.protocol, "1.0");
    assert.equal(doc.redacted, true);
    assert.ok(!JSON.stringify(doc).includes("CANARY"), "no secrets in the scenario");
    const { queue: q, events, byIndex } = runQueueScript(doc);
    assert.deepEqual(events, transcript.events, "ordered queue transcript");
    const outcomes = q.entries.map((e) => ({
      status: e.status,
      ...(e.outputHash ? { outputHash: e.outputHash } : {}),
      ...(e.errorCode ? { errorCode: e.errorCode } : {}),
    }));
    assert.deepEqual(outcomes, doc.golden.outcomes, "per-entry outcomes");
    const summary = summarizeDesktopQueue(q);
    assert.deepEqual(summary, doc.golden.summary, "totals");
    assert.equal(humanDesktopQueueSummary(summary), doc.golden.human, "human totals line");
    assert.deepEqual(JSON.parse(machineDesktopQueueSummary(summary)), doc.golden.machine, "machine totals");
    if (doc.golden.retriedIdDiffers) {
      const failedId = byIndex[1];
      const retried = q.entries.find((e) => e.status === "done" && e.id !== byIndex[0]);
      assert.ok(retried, "retried entry finished");
      assert.notEqual(retried.id, failedId, "retry runs under a fresh id");
    }
    // Golden origins stay redacted: scheme://host only, never full URLs.
    for (const entry of q.entries) {
      assert.match(entry.origin, /^https?:\/\/[^/]+$/, `redacted origin for ${entry.id}`);
    }
  });
}
