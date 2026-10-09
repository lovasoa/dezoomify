import assert from "node:assert/strict";
import test from "node:test";
import { RetryApproval } from "../packages/shared-ui/src/retry-approval.ts";

const request = (attempt, index = 0) => ({ tile: { index }, attempt, requires_approval: true });
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("one approval grants one extra attempt to every tile, including later arrivals", async () => {
  const warnings = [];
  const gate = new RetryApproval((pending) => {
    if (pending) warnings.push(pending);
  });
  let finished = 0;
  const first = gate.acquire(request(4)).then(() => finished++);
  const second = gate.acquire(request(4, 1)).then(() => finished++);
  await tick();
  assert.equal(warnings.length, 1);
  assert.equal(finished, 0);
  gate.retry();
  await Promise.all([first, second]);
  await gate.acquire(request(4, 2));
  assert.equal(warnings.length, 1);
  const next = gate.acquire(request(5));
  await tick();
  assert.equal(warnings.length, 2);
  gate.retry();
  await next;
});

test("cancellation settles every waiting acquisition and prevents further retries", async () => {
  const gate = new RetryApproval(() => {});
  const first = assert.rejects(gate.acquire(request(4)), { kind: "cancelled" });
  const second = assert.rejects(gate.acquire(request(5)), { kind: "cancelled" });
  gate.cancel();
  await Promise.all([first, second]);
  await assert.rejects(gate.acquire(request(4)), { kind: "cancelled" });
});
