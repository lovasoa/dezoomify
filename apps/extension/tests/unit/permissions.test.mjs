import assert from "node:assert/strict";
import test from "node:test";
import { createAttemptPermissions } from "../../src/job/permissions.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function setup() {
  const grants = new Set();
  const requests = [];
  let pending = [];
  const permissions = createAttemptPermissions(
    {
      contains: async ({ origins }) => grants.has(origins[0]),
      request: ({ origins }) => new Promise((resolve) => requests.push({ origins, resolve })),
    },
    (value) => {
      pending = value;
    },
  );
  return {
    ...permissions,
    grants,
    requests,
    get pending() {
      return pending;
    },
  };
}

test("same-origin waits share a click; other origins remain pending until their own grant", async () => {
  const p = setup(),
    controller = new AbortController();
  const a = p.ensure("https://a.example", controller.signal),
    b = p.ensure("https://a.example", controller.signal);
  const c = p.ensure("https://b.example", controller.signal);
  const cancelled = assert.rejects(c, { name: "AbortError" });
  await tick();
  p.pending[0].request();
  p.pending[0].request();
  assert.equal(p.requests.length, 1, "browser request occurs synchronously in the click");
  p.grants.add("https://a.example/*");
  p.requests[0].resolve(true);
  await Promise.all([a, b]);
  assert.deepEqual(
    p.pending.map((item) => item.origin),
    ["https://b.example"],
  );
  controller.abort();
  await cancelled;
  assert.equal(p.pending.length, 0);
});

test("denial and unretained grants fail every waiter instead of reopening a prompt", async () => {
  for (const accepted of [false, true]) {
    const p = setup(),
      controller = new AbortController();
    const result = assert.rejects(p.ensure("https://a.example", controller.signal), {
      code: "access-required",
    });
    await tick();
    p.pending[0].request();
    p.requests[0].resolve(accepted);
    await result;
    assert.equal(p.pending.length, 0);
    assert.equal(p.requests.length, 1);
  }
});

test("cancellation removes one waiter; a late grant cannot settle a replacement wait", async () => {
  const p = setup(),
    old = new AbortController(),
    next = new AbortController();
  const cancelled = assert.rejects(p.ensure("https://a.example", old.signal), {
    name: "AbortError",
  });
  await tick();
  const stale = p.pending[0];
  stale.request();
  old.abort();
  await cancelled;
  const replacement = assert.rejects(p.ensure("https://a.example", next.signal), {
    name: "AbortError",
  });
  await tick();
  p.grants.add("https://a.example/*");
  p.requests[0].resolve(true);
  await tick();
  assert.equal(p.pending.length, 1);
  stale.request();
  assert.equal(p.requests.length, 1);
  next.abort();
  await replacement;
});
