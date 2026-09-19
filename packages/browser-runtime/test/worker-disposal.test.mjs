import test from "node:test";
import assert from "node:assert/strict";
import { createJobWorkerHost } from "../src/worker-host.ts";

const IDLE = {
  revision: 0,
  lifecycle: "Created",
  paused: false,
  progress: { completed: 0, total: 0 },
  selection: { image: null, level: null, level_count: 0, deferred: [] },
  decision: null,
  terminal: null,
  output: null,
};

function fakeWasm(calls) {
  class Session {
    constructor() { calls.push("new-session"); }
    dispatch(command) {
      calls.push(`dispatch:${command.type}`);
      return { status: "ok", messages: [], snapshot: { ...IDLE } };
    }
    applyProcessing() { return new Uint8Array([9]).buffer; }
    dispose() { calls.push("dispose"); return { status: "ok", messages: [], snapshot: { ...IDLE } }; }
  }
  return { Session };
}

test("a disposed worker drops late bytes and commands; the retired job cannot mutate its successor", async () => {
  const calls = [];
  const sent = [];
  const host = createJobWorkerHost({
    postMessage: (message) => sent.push(message),
    wasm: async () => fakeWasm(calls),
  });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputs: [{ url: "https://a.test/x.dzi" }] });
  assert.ok(calls.includes("dispatch:start"));
  const dispatches = calls.length;
  await host.onMessage({ type: "engine.dispose" });
  assert.ok(calls.includes("dispose"));
  // Disposal itself publishes the session's final snapshot once (asserted
  // below); only messages after that point must stay silent.
  const sentAfterDispose = sent.length;
  await host.onMessage({ type: "engine.bytes", requestId: 3, bytes: new Uint8Array([1, 2]) });
  await host.onMessage({ type: "engine.command", command: { type: "cancel" } });
  await host.onMessage({ type: "engine.probe", requestId: 4, outcome: { status: "missing" } });
  await host.onMessage({ type: "engine.display", requestId: 5 });
  await host.onMessage({ type: "engine.acquired", requestId: 6 });
  assert.equal(calls.length, dispatches + 1, `retired worker dispatched late input: ${JSON.stringify(calls)}`);
  assert.ok(!sent.slice(sentAfterDispose).some((message) => message.type === "engine.messages"), "retired worker published messages");
});

test("worker disposal is repeat-safe and publishes the session dispose result once", async () => {
  const calls = [];
  const sent = [];
  const host = createJobWorkerHost({
    postMessage: (message) => sent.push(message),
    wasm: async () => fakeWasm(calls),
  });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputs: [{ url: "https://a.test/x.dzi" }] });
  await host.onMessage({ type: "engine.dispose" });
  await host.onMessage({ type: "engine.dispose" });
  assert.equal(calls.filter((call) => call === "dispose").length, 1);
});

test("byte provide dispatches direct bytes with no arena reservation", async () => {
  const dispatched = [];
  const sent = [];
  class Session {
    dispatch(command) { dispatched.push(command); return { status: "ok", messages: [], snapshot: { ...IDLE } }; }
    dispose() { return { status: "ok", messages: [], snapshot: { ...IDLE } }; }
  }
  const host = createJobWorkerHost({
    postMessage: (message) => sent.push(message),
    wasm: async () => ({ Session }),
  });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputs: [{ url: "https://a.test/x.dzi" }] });
  const bytes = new Uint8Array([1, 2, 3]);
  await host.onMessage({ type: "engine.bytes", requestId: 9, bytes, finalUri: "https://a.test/final" });
  const provide = dispatched.find((command) => command.type === "provide-resource");
  assert.ok(provide, "expected a provide-resource dispatch");
  assert.equal(provide.request, 9);
  assert.ok(Array.isArray(provide.bytes), "bytes ride inline as a plain array per the generated contract");
  assert.deepEqual(provide.bytes, [1, 2, 3]);
  assert.equal(provide.final_uri, "https://a.test/final");
  assert.ok(!("buffer" in provide), "direct-bytes provide carries no arena buffer handle");
  assert.ok(!sent.some((message) => message.type === "engine.error"), "direct provide must not fault the ABI");
});

test("processed tile bytes transfer ownership to the host instead of copying", async () => {
  const sent = [];
  const transfers = [];
  const host = createJobWorkerHost({
    postMessage: (message, transfer) => { sent.push(message); transfers.push(transfer ?? []); },
    wasm: async () => fakeWasm([]),
  });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputs: [{ url: "https://a.test/x.dzi" }] });
  const bytes = new Uint8Array([1, 2, 3]).buffer;
  await host.onMessage({ type: "engine.process", requestId: 7, recipe: "none", bytes });
  const processed = sent.find((message) => message.type === "engine.processed");
  assert.ok(processed, "expected an engine.processed reply");
  assert.ok(processed.bytes instanceof ArrayBuffer);
  assert.equal(transfers.flat().length, 1, "processed bytes must transfer, not copy");
});

test("acquired tiles acknowledge body-free with a typed outcome", async () => {
  const dispatched = [];
  class Session {
    dispatch(command) { dispatched.push(command); return { status: "ok", messages: [], snapshot: { ...IDLE } }; }
    dispose() { return { status: "ok", messages: [], snapshot: { ...IDLE } }; }
  }
  const host = createJobWorkerHost({
    postMessage() {},
    wasm: async () => ({ Session }),
  });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputs: [{ url: "https://a.test/x.dzi" }] });
  await host.onMessage({ type: "engine.acquired", requestId: 11 });
  const acquired = dispatched.find((command) => command.type === "tile-acquired");
  assert.ok(acquired, "expected a tile-acquired dispatch");
  assert.equal(acquired.request, 11);
  assert.ok(!("bytes" in acquired), "tile acknowledgment carries no body");
});
