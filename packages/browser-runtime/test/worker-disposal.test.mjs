import test from "node:test";
import assert from "node:assert/strict";
import { createJobWorkerHost } from "../src/worker-host.ts";

function fakeWasm(calls) {
  class Session {
    constructor() { calls.push("new-session"); }
    dispatch(command) {
      calls.push(`dispatch:${command.type}`);
      return { status: "ok", messages: [] };
    }
    allocateBuffer(n) { calls.push(`alloc:${n}`); return 1; }
    writeBuffer() {}
    commitBuffer() {}
    bufferHandle() { return { kind: "buffer", id: 1 }; }
    applyProcessing() { return new Uint8Array([9]).buffer; }
    dispose() { calls.push("dispose"); return { status: "ok", messages: [] }; }
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
  await host.onMessage({ type: "engine.bytes", requestId: 3, bytes: new Uint8Array([1, 2]) });
  await host.onMessage({ type: "engine.command", command: { type: "cancel" } });
  await host.onMessage({ type: "engine.probe", requestId: 4, outcome: { status: "missing" } });
  await host.onMessage({ type: "engine.display", requestId: 5 });
  assert.equal(calls.length, dispatches + 1, `retired worker dispatched late input: ${JSON.stringify(calls)}`);
  assert.ok(!sent.some((message) => message.type === "engine.messages"), "retired worker published messages");
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
