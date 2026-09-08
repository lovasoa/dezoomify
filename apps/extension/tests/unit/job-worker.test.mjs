import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function loadWorker() {
  let src = readFileSync(new URL("../../src/job/worker.ts", import.meta.url), "utf8");
  // The production worker's generated-WASM dynamic import is unreachable in
  // node (no WorkerGlobalScope), so the worker host stays directly testable.
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(src)}`);
}

const { createJobWorkerHost } = await loadWorker();

test("worker delegates start and correlated bytes to the WASM Session", async () => {
  const sent = [];
  const calls = [];
  class Session {
    constructor(version, quotas) { calls.push(["new", version, quotas]); }
    dispatch(bytes) { calls.push(["dispatch", JSON.parse(new TextDecoder().decode(bytes))]); }
    drainMessages() { return JSON.stringify([{ protocol: "1.0", kind: "effect", type: "acquire-resource", job: "job:one", request: { id: "req:one" } }]); }
    allocateBuffer(length) { calls.push(["allocate", length]); return JSON.stringify({ id: "buf:one", generation: 0, length }); }
    protocolHandle(handle) { calls.push(["protocolHandle", JSON.parse(handle)]); return handle; }
    writeBuffer(handle, offset, bytes) { calls.push(["write", JSON.parse(handle), offset, [...bytes]]); }
    commitBuffer(handle, length) { calls.push(["commit", JSON.parse(handle), length]); }
    dispose() { calls.push(["dispose"]); }
  }
  const host = createJobWorkerHost({ postMessage: (message) => sent.push(message), wasm: async () => ({ default: async () => {}, Session }) });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputUrl: "https://example.test/image.dzi" });
  await host.onMessage({ type: "engine.bytes", jobId: "job:one", requestId: "req:one", bytes: new Uint8Array([1, 2]) });
  assert.equal(calls.filter(([kind]) => kind === "new").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "dispatch").length, 2);
  assert.deepEqual(calls.find(([kind]) => kind === "write"), ["write", { id: "buf:one", generation: 0, length: 2 }, 0, [1, 2]]);
  assert.equal(sent.every((message) => message.type === "engine.messages"), true);
});

test("worker disposal is repeat-safe and does not manufacture effects", async () => {
  const calls = [];
  class Session { dispatch() {} drainMessages() { return "[]"; } dispose() { calls.push("dispose"); } }
  const host = createJobWorkerHost({ postMessage() {}, wasm: async () => ({ Session }) });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputUrl: "https://example.test/image.dzi" });
  await host.onMessage({ type: "engine.dispose" });
  await host.onMessage({ type: "engine.dispose" });
  assert.deepEqual(calls, ["dispose"]);
});
