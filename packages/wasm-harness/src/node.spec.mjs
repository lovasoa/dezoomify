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
    message.type === "acquire-resource"
  )?.request;
}

const DZI = `<?xml version="1.0" encoding="UTF-8"?>
<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008">
  <Size Width="512" Height="512"/>
</Image>
`;

function tileError(code, http) {
  return {
    code,
    retryable: false,
    message: `tile refused: ${code}`,
    recovery: [],
    transport: "direct",
    http: http ?? null,
  };
}

/// Drive one session through discovery and selection of the largest level.
/// Returns the live session plus `(tile, request)` pairs in effect order.
/// Discovery bodies cross directly in the command; nothing is retained.
function acquireTiles(session) {
  const started = start(session);
  const request = discoveryRequest(started);
  assert.ok(request);
  const bytes = Array.from(Buffer.from(DZI, "utf8"));
  const provided = session.dispatch({
    type: "provide-resource",
    request: request.id,
    bytes,
  });
  assert.equal(provided.status, "ok");
  const catalog = provided.snapshot.selection.catalog;
  assert.ok(catalog, "metadata yields a catalog in the snapshot");
  const selected = session.dispatch({ type: "select-image", image: 0 });
  assert.equal(selected.status, "ok");
  const levels = catalog.entries[0].levels.length;
  const leveled = session.dispatch({ type: "select-level", level: levels - 1 });
  assert.equal(leveled.status, "ok");
  const tiles = leveled.messages
    .filter((message) => message.type === "acquire-tile")
    .map((message) => ({ tile: message.tile, request: message.request.id }));
  assert.equal(tiles.length, 4, "largest DZI level is a 2x2 grid");
  return { tiles };
}

describe("generated typed WASM surface", () => {
  it("returns effects directly from dispatch plus the absolute snapshot", () => {
    assert.equal(typeof wasm.Session, "function");
    const session = new wasm.Session({});
    const result = start(session);
    assert.equal(result.status, "ok");
    assert.equal(result.messages[0].type, "acquire-resource");
    assert.equal(result.snapshot.lifecycle, "Discovering");
    assert.ok(discoveryRequest(result));
    const disposed = session.dispose();
    assert.equal(disposed.status, "ok");
    assert.ok(disposed.messages.some((message) => message.type === "cancel-work"));
    assert.equal(disposed.snapshot.terminal.type, "cancelled");
    const again = session.dispose();
    assert.equal(again.status, "ok");
    assert.deepEqual(again.messages, []);
  });

  it("carries discovery bodies directly in provide-resource", () => {
    const session = new wasm.Session({});
    const request = discoveryRequest(start(session));
    assert.ok(request);
    const bytes = Array.from(Buffer.from(DZI, "utf8"));
    const provided = session.dispatch({
      type: "provide-resource",
      request: request.id,
      bytes,
    });
    assert.equal(provided.status, "ok");
    assert.ok(
      provided.snapshot.selection.catalog,
      "direct bytes yield a catalog in the snapshot",
    );
    session.dispose();
  });

  it("rejects tile bytes through provide-resource", () => {
    const session = new wasm.Session({});
    const { tiles } = acquireTiles(session);
    const rejected = session.dispatch({
      type: "provide-resource",
      request: tiles[0].request,
      bytes: [1, 2, 3, 4],
    });
    assert.equal(rejected.status, "error", "tile bytes never enter the adapter");
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
        retryable: true,
        message: "The metadata proxy returned an error.",
        recovery: [],
        transport: "metadata-proxy",
        http: 502,
        preview: "upstream timeout",
      },
    });
    assert.equal(result.status, "ok");
    const failed = result.snapshot.terminal;
    assert.equal(failed.type, "failed");
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

  it("drives tiles to completion through display-only acknowledgements", () => {
    const session = new wasm.Session({});
    const { tiles } = acquireTiles(session);
    let messageCount = 0;
    let finalized = false;
    for (const { request } of tiles) {
      const result = session.dispatch({ type: "provide-display-outcome", request });
      assert.equal(result.status, "ok");
      messageCount += result.messages.length;
      finalized ||= result.messages.some((message) =>
        message.type === "finalize-output"
      );
    }
    assert.ok(finalized, "display-only acquisition still finalizes");
    // eslint-disable-next-line no-console
    console.log(`display-only completion: ${messageCount} host messages, body-free acks`);
    session.dispose();
  });

  it("retries a transient failure after the explicit host wait", () => {
    const session = new wasm.Session({});
    const { tiles } = acquireTiles(session);
    const failed = session.dispatch({
      type: "provide-fetch-failure",
      request: tiles[0].request,
      error: tileError("TRANSPORT_TIMEOUT"),
    });
    assert.equal(failed.status, "ok");
    const wait = failed.messages.find((message) =>
      message.type === "wait-retry-timer"
    );
    assert.equal(wait.tile, tiles[0].tile);
    assert.equal(wait.attempt, 1);
    assert.ok(wait.delay_ms > 0, "the host waits before retrying");
    const elapsed = session.dispatch({
      type: "retry-timer-elapsed",
      tile: wait.tile,
      attempt: wait.attempt,
    });
    assert.equal(elapsed.status, "ok");
    const reacquired = elapsed.messages.filter((message) =>
      message.type === "acquire-tile" && message.tile === wait.tile
    );
    assert.equal(reacquired.length, 1, "the timer completion issues exactly one re-acquisition");
    session.dispose();
  });
});
