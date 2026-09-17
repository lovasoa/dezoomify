// Node conformance for the generated object ABI. The declarations and runtime
// module are emitted by the same WASM build immediately before this file runs.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const TARGET_DIR = JSON.parse(execFileSync(
  "cargo",
  ["metadata", "--format-version", "1", "--no-deps"],
  { cwd: ROOT, encoding: "utf8" },
)).target_directory;
const GENERATED = path.join(TARGET_DIR, "wasm-node-harness", "dezoomify_wasm.js");

assert.ok(
  existsSync(GENERATED),
  "generated Node bindings are missing; run through `cargo xtask test wasm`",
);
const wasm = createRequire(import.meta.url)(GENERATED);

function start(session, url = "https://example.com/image.dzi") {
  return session.dispatch({ type: "start", inputs: [{ url }] });
}

function discoveryRequest(result) {
  assert.equal(result.status, "ok");
  return result.messages.find((message) =>
    message.kind === "effect" && message.type === "acquire-resource"
  )?.request;
}

describe("generated typed WASM surface", () => {
  it("returns effects and events directly from dispatch", () => {
    assert.equal(typeof wasm.Session, "function");
    const session = new wasm.Session({});
    const result = start(session);
    assert.equal(result.status, "ok");
    assert.equal(result.messages[0].kind, "event");
    assert.equal(result.messages[0].type, "job-state");
    assert.ok(discoveryRequest(result));
    const disposed = session.dispose();
    assert.equal(disposed.status, "ok");
    assert.ok(disposed.messages.some((message) => message.type === "cancelled"));
    assert.deepEqual(session.dispose(), { status: "ok", messages: [] });
  });

  it("moves typed handles and bytes directly", () => {
    const session = new wasm.Session({});
    const handle = session.allocateBuffer(4);
    assert.deepEqual(Object.keys(handle).sort(), ["generation", "id"]);
    session.writeBuffer(handle, 0, Uint8Array.from([3, 1, 4, 1]));
    session.commitBuffer(handle, 4);
    const buffer = session.bufferHandle(handle);
    assert.deepEqual(
      { id: buffer.id, generation: buffer.generation, length: buffer.length },
      { id: handle.id, generation: handle.generation, length: 4 },
    );
    assert.deepEqual(Array.from(session.takeBuffer(handle)), [3, 1, 4, 1]);
    session.dispose();
  });

  it("preserves a complete metadata transport failure through the engine", () => {
    const session = new wasm.Session({});
    const request = discoveryRequest(start(session, "https://example.com/info.json"));
    assert.ok(request);
    const result = session.dispatch({
      type: "provide-fetch-failure",
      request: request.id,
      error: {
        code: "PROXY_ERROR",
        phase: "acquisition",
        retryable: true,
        message: "The metadata proxy returned an error.",
        recovery: [],
        request: request.uri,
        transport: "metadata-proxy",
        resource_kind: "metadata",
        http: 502,
        preview: "upstream timeout",
      },
    });
    assert.equal(result.status, "ok");
    const failed = result.messages.find((message) =>
      message.kind === "event" && message.type === "failed"
    );
    assert.equal(failed.error.code, "PROXY_ERROR");
    assert.equal(failed.error.phase, "discovery", "Rust derives phase from the answered effect");
    assert.equal(failed.error.transport, "metadata-proxy");
    assert.equal(failed.error.http, 502);
    assert.equal(failed.error.request, request.uri);
  });

  it("rejects malformed external objects at the generated conversion boundary", () => {
    const session = new wasm.Session({});
    assert.throws(() => session.dispatch({ type: "provide-fetch-failure" }), /typed ABI conversion failed/);
    session.dispose();
  });
});
