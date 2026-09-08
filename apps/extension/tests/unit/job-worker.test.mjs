import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

async function importSource(url) {
  return import(`data:text/javascript;charset=utf-8,${encodeURIComponent(readFileSync(url, "utf8"))}`);
}

const wasm = await importSource(new URL("../../../../wasm/dezoomify-wasm.js", import.meta.url));
await wasm.default({
  module_or_path: readFileSync(new URL("../../../../wasm/dezoomify-wasm_bg.wasm", import.meta.url)),
});

async function loadWorker() {
  // The production worker's generated-WASM dynamic import is unreachable in
  // node (no WorkerGlobalScope), so the worker host stays directly testable.
  return importSource(new URL("../../src/job/worker.ts", import.meta.url));
}

const { createJobWorkerHost } = await loadWorker();

test("worker and generated WASM complete the first discovery round trip", async () => {
  const sent = [];
  const host = createJobWorkerHost({ postMessage: (message) => sent.push(message), wasm: async () => wasm });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputUrl: "https://example.test/image.dzi" });
  const first = sent.flatMap((message) => message.messages ?? []);
  const acquire = first.find((message) => message.type === "acquire-resource");
  assert.ok(acquire?.request?.id, "engine did not request the input metadata");

  sent.length = 0;
  const metadata = new TextEncoder().encode('<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>');
  await host.onMessage({ type: "engine.bytes", jobId: "job:one", requestId: acquire.request.id, bytes: metadata });
  assert.equal(sent.some((message) => message.type === "engine.error"), false);
  assert.ok(
    sent.flatMap((message) => message.messages ?? []).some((message) => message.type === "catalog"),
    JSON.stringify(sent),
  );
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
