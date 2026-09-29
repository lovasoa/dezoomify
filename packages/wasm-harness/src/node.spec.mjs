// Executes the fresh wasm-bindgen module against injected asynchronous capabilities.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const target = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: root,
    encoding: "utf8",
  }),
).target_directory;
const wasm = createRequire(import.meta.url)(
  path.join(target, "wasm-node-harness/dezoomify_wasm.js"),
);
const url = "https://example.com/image.dzi";
const document = new TextEncoder().encode(
  '<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008"><Size Width="512" Height="512"/></Image>',
);
const options = {
  selection: { kind: "automatic", image_index: 0, largest: true },
  partial: "keep",
  max_concurrent: 2,
  max_retries: 0,
};

function host(overrides = {}) {
  const observed = { reads: [], tiles: [], progress: [], warnings: [], delays: [], settled: 0 };
  return {
    observed,
    async fetch(request) {
      observed.reads.push(request);
      await Promise.resolve();
      return { kind: "response", response: { bytes: document, final_uri: request.uri } };
    },
    async probe() {
      return { status: "missing" };
    },
    async acquireTile(tile) {
      await Promise.resolve();
      observed.tiles.push(tile);
    },
    async finish(request) {
      return {
        canvas: request.canvas,
        format: request.format,
        complete: request.missing.length === 0,
        missing: request.missing,
        disposition: "browser-save-ready",
      };
    },
    async chooseImage() {
      return 0;
    },
    async chooseLevel(image) {
      return image.levels.length - 1;
    },
    async choosePartial() {
      return "keep";
    },
    async checkpoint() {},
    async sleep(delay) {
      observed.delays.push(delay);
    },
    report(progress) {
      observed.progress.push(progress);
    },
    warn(message) {
      observed.warnings.push(message);
    },
    async settle() {
      observed.settled += 1;
    },
    ...overrides,
  };
}

test("async Host reads binary metadata and saves the full selected image", async () => {
  const platform = host();
  const output = await wasm.dezoomify([{ url }], options, platform);
  assert.deepEqual(output.canvas, { width: 512, height: 512 });
  assert.equal(output.complete, true);
  assert.equal(output.disposition, "browser-save-ready");
  assert.equal(platform.observed.tiles.length, 4);
  assert.equal(platform.observed.settled, 1);
  assert.ok(platform.observed.reads.every((request) => request.uri === url));
  assert.ok(platform.observed.progress.some((progress) => progress.completed === 4));
});

test("structured Host rejection retains request facts", async () => {
  const failure = {
    code: "TRANSPORT_HTTP_ERROR",
    phase: "discovery",
    retryable: false,
    message: "Fixture metadata refused.",
    request: url,
    transport: "direct",
    resource_kind: "metadata",
    http: 403,
  };
  const platform = host({
    async fetch() {
      throw failure;
    },
  });
  await assert.rejects(wasm.dezoomify([{ url }], options, platform), (error) => {
    assert.equal(error.code, failure.code);
    assert.equal(error.http, 403);
    assert.equal(error.request, url);
    return true;
  });
  assert.equal(platform.observed.settled, 1);
});

test("malformed JavaScript arguments and Host returns fail as typed errors and settle", async () => {
  for (const [inputs, configuration] of [
    ["invalid", options],
    [[{ url }], "invalid"],
  ]) {
    const platform = host();
    await assert.rejects(wasm.dezoomify(inputs, configuration, platform), {
      code: "binding.invalid-value",
    });
    assert.equal(platform.observed.settled, 1);
    assert.deepEqual(platform.observed.reads, []);
  }
  const platform = host({
    async acquireTile() {
      return "invalid";
    },
  });
  await assert.rejects(wasm.dezoomify([{ url }], options, platform), (error) => {
    assert.equal(error.code, "binding.invalid-value");
    assert.equal(platform.observed.settled, 1);
    return true;
  });
});

test("processing uses Uint8Array without numeric body arrays", () => {
  const bytes = Uint8Array.of(0, 1, 127, 128, 255);
  const result = wasm.applyProcessing("none", bytes);
  assert.ok(result instanceof Uint8Array);
  assert.deepEqual(result, bytes);
  assert.throws(() => wasm.applyProcessing("unknown-recipe", bytes), {
    code: "binding.invalid-value",
  });
});

test("accepted format warnings reach the Host without preventing output", async () => {
  const platform = host();
  const output = await wasm.dezoomify(
    [
      {
        url: "https://images.test/ImageProperties.xml",
        contents:
          '<IMAGE_PROPERTIES WIDTH="500" HEIGHT="500" NUMTILES="9" NUMIMAGES="1" VERSION="1.8" TILESIZE="256"/>',
      },
    ],
    { ...options, format: "zoomify" },
    platform,
  );
  assert.equal(output.complete, true);
  assert.deepEqual(platform.observed.warnings, [
    "Zoomify tile count mismatch: computed 5, metadata declares 9",
  ]);
  assert.equal(platform.observed.settled, 1);
});

test("Rust classifies raw Host errors while retaining exact failure context", async () => {
  const failure = {
    code: "host.future-throttle",
    phase: "acquisition",
    message: "Original host message",
    request: "https://redirected.example/tile?signed=exact",
    transport: "native",
    resource_kind: "tile",
    blocked_reason: "throttled",
    http: 429,
    retry_after_ms: 900000,
    preview: "Original response",
    detail: "Original context",
  };
  const platform = host({
    async acquireTile(tile) {
      platform.observed.tiles.push(tile);
      if (tile.index === 1) throw failure;
    },
    async choosePartial({ missing }) {
      assert.equal(missing.length, 1);
      assert.equal(missing[0].tile, 1);
      assert.deepEqual(missing[0].failures, [
        { ...failure, retryable: true },
        { ...failure, retryable: true },
      ]);
      return "keep";
    },
  });
  const output = await wasm.dezoomify(
    [{ url }],
    { ...options, partial: "prompt", max_retries: 1 },
    platform,
  );
  assert.deepEqual(platform.observed.delays, [300000]);
  assert.deepEqual(output.missing, [1]);
  assert.equal(output.complete, false);
});

test("concurrent invocations use distinct Host objects and settle each once", async () => {
  const left = host();
  const right = host({
    async finish(request) {
      return {
        canvas: request.canvas,
        format: request.format,
        complete: request.missing.length === 0,
        missing: request.missing,
        disposition: "display-only",
      };
    },
  });
  const [a, b] = await Promise.all([
    wasm.dezoomify([{ url }], options, left),
    wasm.dezoomify([{ url }], options, right),
  ]);
  assert.equal(a.disposition, "browser-save-ready");
  assert.equal(b.disposition, "display-only");
  assert.equal(left.observed.tiles.length, 4);
  assert.equal(right.observed.tiles.length, 4);
  assert.equal(left.observed.settled, 1);
  assert.equal(right.observed.settled, 1);
});

test("malformed tile processing remains a permanent missing tile eligible for partial output", async () => {
  const platform = host({
    async acquireTile(tile) {
      platform.observed.tiles.push(tile);
      if (tile.index === 1)
        wasm.applyProcessing("google-arts-decrypt", Uint8Array.of(10, 10, 10, 10));
    },
    async choosePartial({ missing }) {
      assert.equal(missing.length, 1);
      assert.equal(missing[0].tile, 1);
      assert.equal(missing[0].failures[0].code, "tile.processing-failed");
      assert.equal(missing[0].failures[0].retryable, false);
      return "keep";
    },
  });
  assert.throws(() => wasm.applyProcessing("google-arts-decrypt", Uint8Array.of(10, 10, 10, 10)), {
    code: "tile.processing-failed",
    phase: "processing",
  });
  const output = await wasm.dezoomify(
    [{ url }],
    { ...options, partial: "prompt", max_retries: 3 },
    platform,
  );
  assert.equal(output.complete, false);
  assert.deepEqual(output.missing, [1]);
  assert.equal(platform.observed.tiles.length, 4);
  assert.equal(platform.observed.delays.length, 0);
  assert.equal(platform.observed.settled, 1);
});

test("cancelled invocation settles late reads before returning and never saves", async () => {
  let release;
  let cancelled = false;
  let acknowledge;
  const entered = new Promise((resolve) => {
    acknowledge = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const platform = host({
    async fetch(request) {
      acknowledge();
      await blocked;
      return { kind: "response", response: { bytes: document, final_uri: request.uri } };
    },
    async checkpoint() {
      if (cancelled)
        throw {
          code: "job.cancelled",
          phase: "cleanup",
          retryable: false,
          message: "Cancelled",
        };
    },
    async finish() {
      assert.fail("cancelled invocation cannot save");
    },
  });
  const running = wasm.dezoomify([{ url }], options, platform);
  await entered;
  cancelled = true;
  release();
  await assert.rejects(running, { code: "job.cancelled" });
  assert.equal(platform.observed.settled, 1);
  assert.equal(platform.observed.tiles.length, 0);
});
