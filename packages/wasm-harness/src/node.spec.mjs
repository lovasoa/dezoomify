// Executes the fresh wasm-bindgen module against injected asynchronous capabilities.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { BrowserHost, createCanvasAssembly, selectionLimitsFor } from "@dezoomify/browser-runtime";

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
  max_concurrent: 2,
  max_retries: 0,
};

function host(overrides = {}) {
  const observed = { reads: [], tiles: [], progress: [], warnings: [], delays: [], settled: 0 };
  let clock = 0;
  return {
    observed,
    async observe() {
      return [];
    },
    async parseHtml() {
      return {}; // These bridge fixtures use XML metadata and need no HTML projections.
    },
    async fetch(request) {
      observed.reads.push(request);
      await Promise.resolve();
      return { kind: "response", response: { bytes: document, final_uri: request.uri } };
    },
    async probe() {
      return { status: "missing" };
    },
    async beginOutput(plan) {
      assert.equal(observed.tiles.length, 0);
      observed.plan = plan;
    },
    async acquireTile({ tile }) {
      await Promise.resolve();
      observed.tiles.push(tile);
    },
    async finish(request) {
      return {
        canvas: request.canvas,
        format: request.format,
        disposition: "browser-save-ready",
      };
    },
    async chooseImage() {
      return 0;
    },
    async chooseLevel(image) {
      return image.levels.length - 1;
    },
    async checkpoint() {
      return { time_ms: clock };
    },
    async sleep(delay) {
      observed.delays.push(delay);
      clock += delay;
      return { time_ms: clock };
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
  assert.equal(output.disposition, "browser-save-ready");
  assert.equal(platform.observed.tiles.length, 4);
  assert.deepEqual(platform.observed.plan.grid, {
    tile_size: { width: 256, height: 256 },
    overlap: { width: 0, height: 0 },
  });
  assert.equal(platform.observed.plan.tile_count, 4);
  assert.equal(platform.observed.settled, 1);
  assert.ok(platform.observed.reads.every((request) => request.uri === url));
  assert.ok(platform.observed.progress.some((progress) => progress.completed === 4));
});

test("Gallica viewer and manifest save the largest fitting IIIF resolution without an advertised pyramid", async () => {
  const service = "https://gallica.bnf.fr/iiif/ark:/12148/btv1b52504834s/f1";
  const manifestUrl = "https://gallica.bnf.fr/iiif/ark:/12148/btv1b52504834s/manifest.json";
  const fixture = path.join(root, "fixtures/iiif/approximate-gallica");
  const info = {
    ...JSON.parse(readFileSync(path.join(fixture, "info.json"), "utf8")),
    "@id": service,
    width: 23541,
    height: 21746,
  };
  const manifest = JSON.parse(readFileSync(path.join(fixture, "manifest.json"), "utf8"));
  const painting = manifest.sequences[0].canvases[0].images[0].resource;
  painting.service["@id"] = service;
  painting["@id"] = `${service}/full/full/0/native.jpg`;
  for (const source of [
    "https://gallica.bnf.fr/view3if/ga/ark:/12148/btv1b52504834s",
    manifestUrl,
  ]) {
    const requests = [];
    const probes = [];
    const decoded = (bytes) => {
      const [width, height] = JSON.parse(new TextDecoder().decode(bytes));
      return { width, height, close() {} };
    };
    let saved;
    // Real planning, selection, URL construction and assembly lifecycle, but
    // synthetic bitmaps: the regression must not allocate a 128MP image.
    const assembly = createCanvasAssembly({
      decode: async (bytes) => decoded(bytes),
      processTile: (_recipe, bytes) => bytes,
      createCanvas: (width, height) => ({ width, height, ctx2d: { drawImage() {} } }),
      encode: async () => new Blob(["synthetic pixels"]),
      save: (_blob, width, height) => {
        saved = { width, height };
        return "browser-save-ready";
      },
    });
    const platform = new BrowserHost({
      signal: new AbortController().signal,
      selectionLimits: selectionLimitsFor(),
      assembly,
      decoder: { decode: async (bytes) => decoded(bytes), dispose() {}, async settle() {} },
      async fetchResource(request) {
        requests.push(request.uri);
        if (request.purpose === "probe") probes.push(request.uri);
        let response = request.uri === manifestUrl ? manifest : info;
        if (request.purpose !== "metadata") {
          const suffix = request.uri.slice(service.length);
          assert.ok(request.uri.startsWith(`${service}/`), request.uri);
          const tile = suffix.match(/^\/(\d+),(\d+),(\d+),(\d+)\/(\d+),(\d+)\/0\/native\.jpg$/);
          assert.ok(tile, request.uri);
          response = [Number(tile[5]), Number(tile[6])];
        } else {
          assert.ok([manifestUrl, `${service}/info.json`].includes(request.uri), request.uri);
        }
        return {
          kind: "response",
          response: { bytes: new TextEncoder().encode(JSON.stringify(response)) },
        };
      },
      onProgress() {},
      async chooseImage() {
        return 0;
      },
      async approveRetry() {
        assert.fail("no retry expected");
      },
    });
    platform.parseHtml = async () => ({});
    const output = await wasm.dezoomify([{ url: source }], options, platform);
    assert.deepEqual(output.canvas, { width: 11771, height: 10873 });
    assert.deepEqual(saved, output.canvas);
    assert.equal(output.disposition, "browser-save-ready");
    assert.deepEqual(probes, [], "declared IIIF geometry must not block acquisition on a probe");
    assert.ok(requests.includes(`${service}/0,0,1024,1024/512,512/0/native.jpg`));
    assert.ok(requests.includes(`${service}/22528,21504,1013,242/507,121/0/native.jpg`));
  }
});

test("pacing and throttling work with arbitrary clock origins", async () => {
  for (const origin of [0, 1700000000000]) {
    let elapsed = 0;
    let refusedAt;
    const timing = () => ({ time_ms: origin + elapsed });
    const platform = host({
      async checkpoint() {
        return timing();
      },
      async sleep(delay) {
        elapsed += delay;
        platform.observed.delays.push(delay);
        return timing();
      },
      async acquireTile({ tile }) {
        if (tile.index === 0 && refusedAt === undefined) {
          refusedAt = elapsed;
          throw { kind: "http-error", status: 429, retry_after_ms: 3000, transport: "direct" };
        }
        if (tile.index === 0) assert.ok(elapsed >= refusedAt + 3000);
        platform.observed.tiles.push(tile);
      },
    });
    const output = await wasm.dezoomify(
      [{ url }],
      {
        ...options,
        max_retries: 1,
        pacing: { start_rps: 4, max_rps: 64 },
      },
      platform,
    );
    assert.equal(output.disposition, "browser-save-ready");
    assert.equal(platform.observed.tiles.length, 4);
    assert.equal(new Set(platform.observed.tiles.map((tile) => tile.index)).size, 4);
    assert.equal(platform.observed.settled, 1);
  }
});

test("additional observations finish the same WASM invocation after inert discovery fails", async () => {
  const interactions = [];
  const platform = host({
    async fetch(request) {
      platform.observed.reads.push(request);
      return {
        kind: "response",
        response: { bytes: new TextEncoder().encode("<html></html>"), final_uri: request.uri },
      };
    },
    async observe(interaction) {
      interactions.push(interaction);
      return interaction === "forbidden"
        ? []
        : [
            {
              url: "https://viewer.example/#loaded",
              kind: "observed-metadata",
              contents: new TextDecoder().decode(document),
            },
          ];
    },
  });
  const output = await wasm.dezoomify([{ url: "https://example.com/viewer" }], options, platform);
  assert.deepEqual(output.canvas, { width: 512, height: 512 });
  assert.deepEqual(interactions, ["forbidden", "allowed"]);
  assert.equal(platform.observed.tiles.length, 4);
  assert.equal(platform.observed.settled, 1);
});

test("FreezoomPack WASM plans match the native/browser fixture golden", async () => {
  const scenario = path.join(root, "testdata/scenarios/formats/fzp");
  const expected = JSON.parse(readFileSync(path.join(scenario, "expected/result.json"), "utf8"));
  for (const [profile, levels] of Object.entries(expected)) {
    for (const [position, golden] of levels.entries()) {
      const source = `https://fixtures.test/fzp/resources/${profile}/root.xml`;
      const bytes = readFileSync(
        path.join(scenario, `payloads/127.0.0.1/fzp/resources/${profile}/root.xml`),
      );
      const platform = host({
        async chooseLevel() {
          return levels.length - 1 - position;
        },
        async fetch(request) {
          platform.observed.reads.push(request);
          assert.equal(request.uri, source);
          assert.equal(request.purpose, "metadata");
          return { kind: "response", response: { bytes, final_uri: source } };
        },
      });
      const output = await wasm.dezoomify([{ url: source }], options, platform);
      assert.deepEqual(output.canvas, { width: golden.width, height: golden.height });
      const tiles = platform.observed.tiles.sort((a, b) => a.index - b.index);
      assert.deepEqual(
        tiles.map((tile) => new URL(tile.request.uri).pathname),
        golden.requests,
      );
      for (const tile of tiles) {
        assert.equal(tile.request.purpose, "tile");
        assert.equal(tile.placement.processing, "none");
        assert.ok(tile.placement.expected_size.width > 0);
        assert.ok(tile.placement.expected_size.height > 0);
      }
    }
  }
});

test("structured Host rejection retains request facts", async () => {
  const failure = {
    kind: "resource",
    request: url,
    resource_kind: "metadata",
    source: {
      kind: "http-error",
      status: 403,
      transport: "direct",
      detail: "Fixture metadata refused.",
    },
  };
  const platform = host({
    async fetch() {
      throw failure;
    },
  });
  await assert.rejects(wasm.dezoomify([{ url }], options, platform), (error) => {
    assert.equal(error.kind, "discovery-failed");
    assert.equal(error.cause.kind, "resource");
    assert.equal(error.cause.request, url);
    assert.equal(error.cause.resource_kind, "metadata");
    assert.equal(error.cause.source.kind, "http-error");
    assert.equal(error.cause.source.status, 403);
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
      kind: "binding-invalid-value",
    });
    assert.equal(platform.observed.settled, 1);
    assert.deepEqual(platform.observed.reads, []);
  }
  for (const method of ["parseHtml", "acquireTile"]) {
    const platform = host({
      async [method]() {
        return "invalid";
      },
    });
    await assert.rejects(wasm.dezoomify([{ url }], options, platform), (error) => {
      assert.equal(error.kind, "binding-invalid-value");
      assert.equal(platform.observed.settled, 1);
      return true;
    });
  }
});

test("processing uses Uint8Array without numeric body arrays", () => {
  const bytes = Uint8Array.of(0, 1, 127, 128, 255);
  const result = wasm.applyProcessing("none", bytes);
  assert.ok(result instanceof Uint8Array);
  assert.deepEqual(result, bytes);
  assert.throws(() => wasm.applyProcessing("unknown-recipe", bytes), {
    kind: "binding-invalid-value",
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
  assert.equal(output.disposition, "browser-save-ready");
  assert.deepEqual(platform.observed.warnings, [
    "Zoomify tile count mismatch: computed 5, metadata declares 9",
  ]);
  assert.equal(platform.observed.settled, 1);
});

test("Rust classifies raw Host errors while retaining exact failure context", async () => {
  const failure = {
    kind: "resource",
    request: "https://redirected.example/tile?signed=exact",
    resource_kind: "tile",
    source: {
      kind: "rate-limited",
      transport: "native",
      retry_after_ms: 900000,
      detail: "Original context",
    },
  };
  const attempts = [];
  const platform = host({
    async acquireTile(request) {
      const { tile } = request;
      platform.observed.tiles.push(tile);
      if (tile.index !== 1) return;
      attempts.push(request);
      if (request.requires_approval) {
        assert.equal(request.attempt, 2);
        assert.deepEqual(request.previous_failure, failure);
        return;
      }
      throw failure;
    },
  });
  await wasm.dezoomify(
    [{ url }],
    { ...options, interactive_retries: true, max_retries: 1 },
    platform,
  );
  assert.deepEqual(platform.observed.delays.slice(0, 2), [300000, 300000]);
  assert.deepEqual(
    attempts.map((request) => request.requires_approval),
    [false, false, true],
  );
  assert.equal(platform.observed.settled, 1);
});

test("concurrent invocations use distinct Host objects and settle each once", async () => {
  const left = host();
  const right = host({
    async finish(request) {
      return {
        canvas: request.canvas,
        format: request.format,
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

test("malformed tile processing aborts without optional retries or finalization", async () => {
  let finished = false;
  const platform = host({
    async acquireTile({ tile, requires_approval }) {
      assert.equal(requires_approval, false);
      if (tile.index === 1)
        wasm.applyProcessing("google-arts-decrypt", Uint8Array.of(10, 10, 10, 10));
    },
    async finish() {
      finished = true;
    },
  });
  await assert.rejects(
    wasm.dezoomify([{ url }], { ...options, interactive_retries: true, max_retries: 3 }, platform),
    (error) => {
      assert.equal(error.kind, "tile-failed");
      assert.equal(error.tile, 1);
      assert.equal(error.attempts, 1);
      assert.equal(error.cause.kind, "processing-failed");
      return true;
    },
  );
  assert.equal(finished, false);
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
      if (cancelled) throw { kind: "cancelled" };
      return { time_ms: 0 };
    },
    async finish() {
      assert.fail("cancelled invocation cannot save");
    },
  });
  const running = wasm.dezoomify([{ url }], options, platform);
  await entered;
  cancelled = true;
  release();
  await assert.rejects(running, { kind: "cancelled" });
  assert.equal(platform.observed.settled, 1);
  assert.equal(platform.observed.tiles.length, 0);
});

test("choice failures and cancellation settle without downloading", async () => {
  for (const method of ["chooseImage", "chooseLevel"]) {
    for (const error of [
      { kind: "cancelled" },
      { kind: "choice-failed", detail: "choice unavailable" },
    ]) {
      const platform = host({
        [method]: async () => {
          throw error;
        },
      });
      await assert.rejects(wasm.dezoomify([{ url }], options, platform), error);
      assert.equal(platform.observed.tiles.length, 0);
      assert.equal(platform.observed.settled, 1);
    }
  }
});
