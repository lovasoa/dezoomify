import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as wasm from "../../../../wasm/dezoomify-wasm.js";
import { createJobWorkerHost } from "@dezoomify/browser-runtime/worker-host";

await wasm.default({
  module_or_path: readFileSync(new URL("../../../../wasm/dezoomify-wasm_bg.wasm", import.meta.url)),
});

test("worker and generated WASM complete the first discovery round trip", async () => {
  const sent = [];
  const logs = [];
  const host = createJobWorkerHost({ postMessage: (message) => sent.push(message), wasm: async () => wasm, log: (level, code, detail) => logs.push({ level, code, detail }) });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputUrl: "https://example.test/image.dzi" });
  const first = sent.flatMap((message) => message.messages ?? []);
  const acquire = first.find((message) => message.type === "acquire-resource");
  assert.ok(
    Number.isSafeInteger(acquire?.request?.id),
    `engine did not request the input metadata: ${JSON.stringify(sent)}`,
  );

  sent.length = 0;
  const metadata = new TextEncoder().encode('<Image TileSize="256" Overlap="0" Format="jpg"><Size Width="512" Height="512"/></Image>');
  await host.onMessage({ type: "engine.bytes", jobId: "job:one", requestId: acquire.request.id, bytes: metadata });
  assert.equal(sent.some((message) => message.type === "engine.error"), false);
  assert.ok(
    sent.flatMap((message) => message.messages ?? []).some((message) => message.type === "catalog"),
    JSON.stringify(sent),
  );
  const codes = logs.map((entry) => entry.code);
  assert.ok(codes.includes("session-created"));
  assert.ok(codes.includes("command-dispatched"));
  assert.ok(codes.includes("messages-drained"));
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

test("worker preserves typed WASM diagnostics", async () => {
  const sent = [];
  const logs = [];
  class Session {
    constructor() {}
    dispatch() {
      throw JSON.stringify({
        code: "adapter.wrong-state",
        phase: "validation",
        retryable: false,
        message: "command not accepted in state AcquiringTiles",
      });
    }
  }
  const host = createJobWorkerHost({
    postMessage: (message) => sent.push(message),
    wasm: async () => ({ Session }),
    log: (level, code, detail) => logs.push({ level, code, detail }),
  });
  await host.onMessage({ type: "engine.start", jobId: "job:one", inputUrl: "https://example.test/image.dzi" });
  assert.ok(logs.some((entry) => entry.code === "core-error" && entry.level === "error"));
  assert.deepEqual(sent, [{
    type: "engine.error",
    error: {
      code: "adapter.wrong-state",
      phase: "validation",
      retryable: false,
      message: "command not accepted in state AcquiringTiles",
      detail: "adapter.wrong-state: command not accepted in state AcquiringTiles",
      transport: "browser-session",
    },
  }]);
});
