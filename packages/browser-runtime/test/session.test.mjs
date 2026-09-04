import test from "node:test";
import assert from "node:assert/strict";
import { createBrowserSession, transferBuffer } from "../src/session.ts";

test("transfer detaches original (neutering check)", () => {
  const buf = new Uint8Array([1, 2, 3, 4]).buffer;
  const moved = transferBuffer(buf);
  assert.equal(buf.byteLength, 0);
  assert.equal(moved.byteLength, 4);
  assert.deepEqual([...new Uint8Array(moved)], [1, 2, 3, 4]);
});

test("backpressure counter trips over quota", () => {
  const posted = [];
  const stub = { postMessage: (m, t) => posted.push([m, t]), terminate: () => {}, postedCount: 0 };
  const s = createBrowserSession({ maxPendingBytes: 4, workerClient: stub, onEvent: () => {} });
  const r1 = s.postBuffer(new Uint8Array([1, 2, 3, 4]).buffer);
  assert.equal(r1.transferred, true);
  assert.equal(s.pendingBytes, 4);
  const r2 = s.postBuffer(new Uint8Array([5, 6]).buffer);
  assert.equal(r2.transferred, true);
  assert.equal(s.backpressure, true);
  assert.equal(s.pendingBytes, 6);
});

test("seq-numbered events and completion exactly once", () => {
  const events = [];
  const stub = { postMessage: () => {}, terminate: () => {} };
  const s = createBrowserSession({ workerClient: stub, onEvent: (e) => events.push(e) });
  s.handleWorkerMessage({ kind: "progress", byteLength: 0 });
  assert.equal(events.length, 1);
  assert.equal(events[0].seq, 1);
  assert.ok(events[0].kind.includes("progress"));
  s.completeOnce({ ok: true });
  assert.equal(events[events.length - 1].kind, "completed");
  const n = events.length;
  s.completeOnce({ ok: true });
  assert.equal(events.length, n);
  // Worker completed also only once.
  s.handleWorkerMessage({ kind: "completed" });
  assert.equal(events.length, n);
  // Monotonic seq.
  for (let i = 1; i < events.length; i++) {
    assert.ok(events[i].seq > events[i - 1].seq);
  }
});

test("cancel is idempotent and late responses ignored after cancel", () => {
  const ev2 = [];
  let terminated = 0;
  const stub = { postMessage: () => {}, terminate: () => { terminated += 1; } };
  const s2 = createBrowserSession({ workerClient: stub, onEvent: (e) => ev2.push(e) });
  s2.cancel();
  assert.equal(s2.cancelled, true);
  assert.equal(ev2.length, 1);
  assert.equal(ev2[0].kind, "cancelled");
  s2.cancel();
  assert.equal(ev2.length, 1);
  s2.handleWorkerMessage({ kind: "progress" });
  s2.handleWorkerMessage({ kind: "completed" });
  assert.equal(ev2.length, 1);
  assert.equal(s2.completed, false);
  s2.dispose();
  s2.dispose();
  assert.equal(s2.disposed, true);
  assert.equal(terminated, 1);
});
