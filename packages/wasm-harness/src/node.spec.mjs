// Test-only Node conformance harness for the dezoomify-wasm adapter.
//
// Uses only Node builtins (`node:test`, `node:fs`, `node:path`,
// `node:child_process`); it imports nothing from the network and performs
// no fetches. It asserts:
//   1. the required JS surface is exported by `crates/dezoomify-wasm/src/lib.rs`
//      (protocolVersion, Session, dispatch, drain, buffers, process, dispose),
//   2. the crate manifest stays adapter-only (cdylib+rlib, no web-sys
//      Window/Document/fetch/Canvas/storage/worker features, no
//      reqwest/tokio/image),
//   3. native conformance: `cargo test` for the crate passes,
//   4. cross-target conformance: `cargo check --target wasm32-unknown-unknown`
//      passes,
//   5. the checked-in wasm transcript golden parses and carries protocol 1.0.
//
// EXCEPTION (recorded, not a failure): real `wasm-pack` Node/browser tests
// (`wasm-pack test --node/--headless`) require pinned `wasm-pack` plus
// browsers. Neither is installed in this environment, so generated-glue and
// headless-browser workflows are out of scope here; the native tests above
// exercise the same adapter logic (wasm-bindgen exports are thin
// `cfg(target_arch = "wasm32")` wrappers over it).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..", "..");
const CRATE = path.join(ROOT, "crates", "dezoomify-wasm");
const SRC = path.join(CRATE, "src");
const GOLDEN = path.join(
  ROOT,
  "testdata",
  "scenarios",
  "wasm",
  "replay",
  "expected",
  "wasm.json",
);

function readSource(name) {
  return readFileSync(path.join(SRC, name), "utf8");
}

describe("P07-EXPORTS: required JS surface is exported", () => {
  const lib = readSource("lib.rs");

  // JS export name -> evidence expected in lib.rs (doc surface table,
  // re-export, fn name, or wasm-bindgen js_name).
  const surface = {
    protocolVersion: ["protocolVersion", "protocol_version"],
    Session: ["Session"],
    dispatch: ["dispatch"],
    drain: ["drain", "drainMessages", "drain_messages"],
    buffers: [
      "buffers",
      "allocate_buffer",
      "commit_buffer",
      "take_buffer",
      "free_buffer",
    ],
    process: ["process", "composite_crop", "composite-crop", "process_crop"],
    dispose: ["dispose"],
  };
  for (const [exportName, evidence] of Object.entries(surface)) {
    it(`exports ${exportName}`, () => {
      assert.ok(
        evidence.some((token) => lib.includes(token)),
        `lib.rs must mention ${exportName} (looked for ${evidence.join(", ")})`,
      );
    });
  }

  it("documents the ownership/reentrancy/disposal contract", () => {
    for (const token of ["Reentrancy", "Disposal", "exactly once", "invalidat"]) {
      assert.ok(lib.includes(token), `lib.rs must document ${token}`);
    }
  });
});

describe("P07-CAPABILITIES: adapter stays capability-free", () => {
  const manifest = readFileSync(path.join(CRATE, "Cargo.toml"), "utf8");

  it("builds as cdylib+rlib", () => {
    assert.match(manifest, /crate-type\s*=\s*\["cdylib",\s*"rlib"\]/);
  });

  it("has no forbidden dependencies or features", () => {
    const forbidden = [
      "web-sys",
      "reqwest",
      "tokio",
      "Window",
      "Document",
      "fetch",
      "Canvas",
      "storage",
      "worker",
    ];
    const lower = manifest.toLowerCase();
    for (const token of forbidden) {
      // `fetch`/`worker`/etc. must not appear as features or deps; the
      // words only occur in prose comments, never as manifest keys.
      const hits = manifest
        .split("\n")
        .filter((line) => !line.trim().startsWith("#"));
      assert.ok(
        !hits.some((line) => line.toLowerCase().includes(token.toLowerCase())),
        `Cargo.toml must not reference ${token}`,
      );
      void lower;
    }
  });

  it("depends inward on core/protocol only (+serde/wasm-bindgen)", () => {
    for (const dep of ["dezoomify-core", "dezoomify-protocol", "serde", "wasm-bindgen"]) {
      assert.ok(manifest.includes(dep), `Cargo.toml must depend on ${dep}`);
    }
  });

  it("sources avoid forbidden host APIs", () => {
    const files = ["lib.rs", "session.rs", "buffer.rs", "processing.rs", "error.rs", "codec.rs"];
    // Strip line comments so contract prose (which names the forbidden
    // capabilities) is not mistaken for usage.
    const code = files
      .map(readSource)
      .map((src) =>
        src
          .split("\n")
          .filter((line) => !line.trim().startsWith("//"))
          .join("\n"),
      )
      .join("\n");
    for (const token of ["web_sys", "reqwest", "tokio", "js_sys", "Canvas"]) {
      assert.ok(!code.includes(token), `adapter sources must not use ${token}`);
    }
  });
});

describe("P07-WORKFLOWS: native conformance", () => {
  it("cargo test passes (buffer/dispatch/drain/process/dispose/isolation)", () => {
    const run = spawnSync(
      "cargo",
      ["test", "--manifest-path", path.join(CRATE, "Cargo.toml"), "--offline"],
      { encoding: "utf8", timeout: 600_000 },
    );
    assert.equal(run.status, 0, `cargo test failed:\n${run.stdout}\n${run.stderr}`);
    // Honest gate: all suites pass, none fail. Never pin an exact test count
    // (counts grow with negative coverage); assert pass + zero failures.
    assert.match(run.stdout, /[0-9]+ passed/);
    assert.ok(!/failed/.test(run.stdout) || /0 failed/.test(run.stdout), "no failures");
  });

  it("cargo check passes for wasm32-unknown-unknown", () => {
    const run = spawnSync(
      "cargo",
      [
        "check",
        "--manifest-path",
        path.join(CRATE, "Cargo.toml"),
        "--offline",
        "--target",
        "wasm32-unknown-unknown",
      ],
      { encoding: "utf8", timeout: 600_000 },
    );
    assert.equal(run.status, 0, `wasm32 check failed:\n${run.stdout}\n${run.stderr}`);
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
    assert.equal(types[0], "acquire-resource", "engine effect leads the transcript");
    assert.ok(types.includes("job-state"), "state events present");
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

describe("P07-PACKAGE: wasm-pack conformance", () => {
  it("runs wasm-pack --node tests when wasm-pack is installed", () => {
    const probe = spawnSync("wasm-pack", ["--version"], { encoding: "utf8" });
    if (probe.status !== 0) {
      console.warn(
        "EXCEPTION-RECORDED: wasm-pack is not installed; " +
          "wasm-pack --node/--headless browser tests are out of scope. " +
          "Native conformance above exercises the same adapter logic.",
      );
      return;
    }
    // wasm-pack present: the conformance suite must actually run on the
    // wasm target through the real toolchain.
    const run = spawnSync("wasm-pack", ["test", "--node", CRATE], {
      encoding: "utf8",
      timeout: 600_000,
    });
    assert.equal(
      run.status,
      0,
      `wasm-pack test --node failed:\n${run.stdout}\n${run.stderr}`,
    );
    assert.match(
      `${run.stdout}\n${run.stderr}`,
      /4 passed/,
      "all wasm-bindgen conformance tests ran on the wasm target",
    );
  });
});
