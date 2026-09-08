// Test-only Node conformance harness for the dezoomify-wasm adapter.
//
// Uses only Node builtins and the freshly generated wasm-bindgen Node module;
// it imports nothing from the network and performs no fetches. It asserts:
//   1. the required JS surface is genuinely exported and executable
//      (protocolVersion, Session, dispatch, drain, buffers, dispose),
//   2. the checked-in wasm transcript golden parses and carries protocol 1.0.
//
// Real headless-browser coverage runs through `cargo xtask test wasm
// --browser`, which executes the compiled adapter inside Chromium via the
// webapp E2E suite; the native tests above exercise the same adapter logic
// (wasm-bindgen exports are thin
// `cfg(target_arch = "wasm32")` wrappers over it).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const TARGET_DIR = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
  cwd: ROOT,
  encoding: "utf8",
})).target_directory;
const GENERATED = path.join(
  TARGET_DIR,
  "wasm-node-harness",
  "dezoomify_wasm.js",
);
const GOLDEN = path.join(
  ROOT,
  "testdata",
  "scenarios",
  "wasm",
  "replay",
  "expected",
  "wasm.json",
);

describe("P07-EXPORTS: generated JS surface executes", () => {
  assert.ok(
    existsSync(GENERATED),
    "generated Node bindings are missing; run through `cargo xtask test wasm`",
  );
  const wasm = createRequire(import.meta.url)(GENERATED);

  it("exports the protocol version and Session constructor", () => {
    assert.equal(wasm.protocolVersion(), "1.0");
    assert.equal(typeof wasm.Session, "function");
  });

  it("executes dispatch and exactly-once message draining", () => {
    const session = new wasm.Session("1.0", "{}");
    const command = new TextEncoder().encode(JSON.stringify({
      protocol: "1.0",
      kind: "command",
      type: "start",
      job: "job:node-bindings-1",
      input_url: "https://example.com/image.dzi",
    }));
    session.dispatch(command);
    const messages = JSON.parse(session.drainMessages());
    assert.equal(messages.length, 2);
    assert.equal(messages[0].type, "job-state");
    assert.equal(messages[1].type, "acquire-resource");
    assert.deepEqual(JSON.parse(session.drainMessages()), []);
    session.dispose();
    session.dispose();
  });

  it("moves bytes through the generated arena methods", () => {
    const session = new wasm.Session("1.0", "{}");
    const handle = session.allocateBuffer(4);
    session.writeBuffer(handle, 0, Uint8Array.from([3, 1, 4, 1]));
    session.commitBuffer(handle, 4);
    assert.deepEqual(Array.from(session.takeBuffer(handle)), [3, 1, 4, 1]);
    session.freeBuffer(handle);
    session.dispose();
  });
});

describe("P07-WORKFLOWS: transcript golden", () => {
  it("wasm.json is a protocol-1.0 job-engine-driven transcript array", () => {
    assert.ok(existsSync(GOLDEN), "golden wasm.json is checked in");
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
    assert.ok(Array.isArray(golden), "golden is an array");
    assert.ok(golden.length > 3, "delegated lifecycle emits the full engine transcript");
    for (const entry of golden) {
      assert.equal(entry.protocol, "1.0");
    }
    const types = golden.map((entry) => entry.type);
    assert.equal(types[0], "job-state", "engine state event leads the transcript");
    assert.ok(types.includes("acquire-resource"), "discovery fetch effect present");
    assert.ok(types.includes("catalog"), "catalog event present (delegation)");
    assert.ok(types.includes("progress"), "progress events present (delegation)");
    assert.ok(types.includes("acquire-tile"), "tile acquisition present (delegation)");
    assert.equal(types[types.length - 1], "completed", "terminal completed event");
    // Scaffold machine ids must never reappear.
    const text = readFileSync(GOLDEN, "utf8");
    assert.ok(!text.includes("req:wasm-meta-1"), "no scaffold request id");
    assert.ok(!text.includes("out:wasm-1"), "no scaffold output id");
  });
});
