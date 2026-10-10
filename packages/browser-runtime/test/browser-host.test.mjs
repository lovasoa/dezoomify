import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticRecorder } from "../../shared-ui/src/diagnostics.ts";
import { createCanvasAssembly } from "../src/assembly.ts";
import { BrowserHost } from "../src/browser-host.ts";
import { MAXIMUM_SELECTION_LIMITS } from "../src/limits.ts";
import { createTileDecoder } from "../src/tile-decode.ts";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const tile = {
  index: 0,
  request: { uri: "https://tiles.test/0.jpg", headers: [], purpose: "tile" },
  placement: {
    position: { x: 0, y: 0 },
    processing: "none",
    canvas: { width: 256, height: 256 },
    expected_size: null,
    role: { probe: false, output: true },
  },
};
const acquisition = (tile) => ({
  tile,
  attempt: 0,
  requires_approval: false,
  previous_failure: undefined,
});

function setup(overrides = {}) {
  const controller = new AbortController(),
    painted = [],
    reports = [];
  const diagnostics = createDiagnosticRecorder({ id: "browser", now: () => 0 });
  const assembly = {
    prepare() {},
    async acquireTile(...args) {
      painted.push(args);
    },
    acquireDisplayTile(...args) {
      painted.push(args);
    },
    async finalizeOutput() {
      return "browser-save-ready";
    },
    dimensions: () => ({ width: 256, height: 256 }),
    release() {},
  };
  const deps = {
    signal: controller.signal,
    selectionLimits: { maxWidth: 300, maxHeight: 300, maxArea: 90000 },
    diagnostics,
    assembly,
    decoder: {
      async decode() {
        return { width: 256, height: 256, close() {} };
      },
      dispose() {},
      async settle() {},
    },
    fetchResource: async () => ({
      kind: "response",
      response: { bytes: new Uint8Array([1, 2]), final_uri: null },
    }),
    onProgress: (p) => reports.push(p),
    approveRetry: async () => {},
    ...overrides,
  };
  return { host: new BrowserHost(deps), deps, controller, assembly, painted, reports, diagnostics };
}

test("acquisition decodes and paints readable bytes before returning", async () => {
  const h = setup();
  assert.equal(await h.host.acquireTile(acquisition(tile)), undefined);
  assert.deepEqual([...new Uint8Array(h.painted[0][2])], [1, 2]);
  assert.equal(h.painted[0][0], 0);
  assert.equal(h.painted[0][1], tile.placement);
});

test("untyped errors become network failures only at the readable-fetch boundary", async () => {
  const original = new Error("unexpected".repeat(300));
  const h = setup({
    fetchResource: async () => {
      throw original;
    },
  });
  await assert.rejects(h.host.fetch(tile.request, "forbidden"), {
    kind: "resource",
    request: tile.request.uri,
    resource_kind: "tile",
    source: {
      kind: "network-failure",
      transport: "direct",
      detail: String(original).slice(0, 2048),
    },
  });
  h.assembly.finalizeOutput = async () => {
    throw original;
  };
  await assert.rejects(h.host.finish({ missing: [], format: "png" }), {
    kind: "internal",
    detail: String(original).slice(0, 2048),
  });
});

test("discovery warnings reach diagnostics without changing progress and stop after cancellation", () => {
  const h = setup();
  h.host.warn("Some resolution information is missing.");
  h.controller.abort();
  h.host.warn("Cancelled work is no longer relevant.");
  const warnings = h.diagnostics
    .report()
    .records.filter((entry) => entry.event === "discovery-warning");
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].level, "warn");
  assert.deepEqual(warnings[0].fields, { message: "Some resolution information is missing." });
  assert.deepEqual(h.reports, []);
});

test("HTTP failures retain status, retry hints and preview without ordinary-image fallback", async () => {
  for (const http of [403, 404, 429, 503]) {
    let reads = 0,
      displays = 0;
    const h = setup({
      fetchResource: async () => {
        reads++;
        throw {
          kind: "http-error",
          status: http,
          transport: "direct",
          retry_after_ms: 3000,
          preview: "Challenge",
        };
      },
      loadDisplayImage: async () => {
        displays++;
        return { naturalWidth: 256, naturalHeight: 256 };
      },
    });
    await assert.rejects(h.host.acquireTile(acquisition(tile)), {
      kind: "resource",
      request: tile.request.uri,
      resource_kind: "tile",
      source: {
        kind: "http-error",
        status: http,
        transport: "direct",
        retry_after_ms: 3000,
        preview: "Challenge",
      },
    });
    assert.equal(reads, 1);
    assert.deepEqual(await h.host.probe(tile), { status: "missing" });
    assert.equal(displays, 0);
    const failure = h.diagnostics.report().failures[0].first.fields;
    assert.equal(failure["source.status"], http);
    assert.equal(failure.request, tile.request.uri);
  }
});

test("an unreadable origin is classified once across concurrent probes and ordinary tiles", async () => {
  let reads = 0,
    displays = 0;
  const h = setup({
    fetchResource: async () => {
      reads++;
      throw { kind: "network-failure", transport: "direct" };
    },
    loadDisplayImage: async () => {
      displays++;
      return { naturalWidth: 256, naturalHeight: 256 };
    },
  });
  const [measured, ...results] = await Promise.all([
    h.host.probe({ ...tile, placement: { ...tile.placement, role: { output: false } } }),
    ...[1, 2].map((index) => h.host.acquireTile(acquisition({ ...tile, index }))),
  ]);
  assert.deepEqual(measured, { status: "available", width: 256, height: 256 });
  assert.equal(reads, 1);
  assert.equal(displays, 3);
  assert.ok(results.every((result) => result === undefined));
  await h.host.acquireTile(acquisition({ ...tile, index: 3 }));
  assert.equal(reads, 1);
});

test("processed tiles, policy and resource limits never use ordinary images", async () => {
  const network = { kind: "network-failure", transport: "direct" };
  const denied = {
    kind: "policy-denied",
    blocked_reason: "access-required",
    transport: "browser-session",
  };
  for (const [processing, failure] of [
    ["google-arts-decrypt", network],
    ["none", denied],
    ["none", { kind: "size-limit", max_bytes: 1 }],
    ["none", { kind: "resource-limit", detail: "budget exceeded" }],
    ["none", { kind: "cancelled" }],
  ]) {
    let displays = 0;
    const h = setup({
      fetchResource: async () => {
        throw failure;
      },
      loadDisplayImage: async () => {
        displays++;
        assert.fail("pixels must be readable");
      },
    });
    const expected =
      failure.kind === "cancelled"
        ? failure
        : { kind: "resource", request: tile.request.uri, resource_kind: "tile", source: failure };
    await assert.rejects(
      h.host.acquireTile(acquisition({ ...tile, placement: { ...tile.placement, processing } })),
      expected,
    );
    if (["policy-denied", "cancelled"].includes(failure.kind))
      await assert.rejects(h.host.probe(tile), expected);
    else
      assert.deepEqual(
        await h.host.probe({ ...tile, placement: { ...tile.placement, processing } }),
        { status: "missing" },
      );
    assert.equal(displays, 0);
  }
});

test("probe output is painted from its first fetch without reacquisition", async () => {
  let reads = 0;
  const h = setup({
    fetchResource: async () => {
      reads++;
      return { kind: "response", response: { bytes: new Uint8Array([5]), final_uri: null } };
    },
  });
  assert.deepEqual(
    await h.host.probe({
      ...tile,
      placement: { ...tile.placement, role: { probe: true, output: true } },
    }),
    { status: "available", width: 256, height: 256 },
  );
  assert.equal(reads, 1);
  assert.equal(h.painted.length, 1);
  h.painted.length = 0;
  assert.deepEqual(
    await h.host.probe({ ...tile, placement: { ...tile.placement, role: { output: false } } }),
    { status: "available", width: 256, height: 256 },
  );
  assert.equal(h.painted.length, 0);
});

test("failed probe measurements stay missing without decode fallback", async () => {
  for (const overrides of [
    {
      fetchResource: async () => {
        throw new Error("unreadable");
      },
    },
    {
      decoder: createTileDecoder({
        createImageBitmap: async () => {
          throw new Error("corrupt");
        },
      }),
      loadDisplayImage: async () => assert.fail("decode must not trigger fallback"),
    },
    {
      decoder: createTileDecoder({
        createImageBitmap: async () => ({ width: 0, height: 1, close() {} }),
      }),
    },
  ]) {
    const h = setup(overrides);
    assert.deepEqual(await h.host.probe(tile), { status: "missing" });
    assert.deepEqual(h.painted, []);
  }
});

test("only successful ordinary-image loading establishes display-only mode", async () => {
  let reads = 0,
    displays = 0;
  const h = setup({
    fetchResource: async () => {
      reads++;
      throw { kind: "timeout", transport: "direct" };
    },
    loadDisplayImage: async () => {
      if (++displays === 1) throw new Error("image failed");
      return { naturalWidth: 256, naturalHeight: 256 };
    },
  });
  assert.deepEqual(await h.host.probe(tile), { status: "missing" });
  h.assembly.acquireDisplayTile = () => {
    throw { kind: "output-unavailable", detail: "paint failed" };
  };
  for (let index = 1; index <= 2; index++)
    await assert.rejects(h.host.acquireTile(acquisition({ ...tile, index })), {
      source: { kind: "output-unavailable", detail: "paint failed" },
    });
  assert.equal(
    reads,
    2,
    "failed loading does not cache, successful loading does even if painting fails",
  );
  assert.equal(displays, 3);
});

test("decode, processing and painting failures retain their cause without transport fallback", async () => {
  for (const stage of ["decode", "processing", "painting"])
    for (const typed of [true, false]) {
      const original = typed
        ? { kind: stage === "painting" ? "output-unavailable" : `${stage}-failed`, detail: stage }
        : new Error(stage);
      let reads = 0,
        displays = 0,
        closed = 0;
      const h = setup({
        decoder: createTileDecoder({
          createImageBitmap: async () => {
            if (stage === "decode") throw original;
            return {
              width: 256,
              height: 256,
              close() {
                closed++;
              },
            };
          },
        }),
        fetchResource: async () => {
          reads++;
          return { kind: "response", response: { bytes: [1], final_uri: null } };
        },
        loadDisplayImage: async () => {
          displays++;
          assert.fail("post-fetch failures cannot trigger fallback");
        },
      });
      h.deps.assembly = createCanvasAssembly({
        decode: (bytes) => h.deps.decoder.decode(bytes, h.controller.signal),
        processTile: () => {
          throw original;
        },
        createCanvas: (width, height) => ({
          width,
          height,
          ctx2d: {
            drawImage() {
              if (stage === "painting") throw original;
            },
          },
        }),
      });
      const input = {
        ...tile,
        placement: {
          ...tile.placement,
          processing: stage === "processing" ? "google-arts-decrypt" : "none",
        },
      };
      const expectedKind = stage === "painting" ? "internal" : `${stage}-failed`;
      const rejects = (error) => {
        assert.equal(error.kind, "resource");
        assert.equal(error.request, tile.request.uri);
        assert.equal(error.resource_kind, "tile");
        if (typed) assert.equal(error.source, original);
        else {
          assert.equal(error.source.kind, expectedKind);
          assert.equal(error.source.detail, String(original));
        }
        return true;
      };
      await assert.rejects(h.host.acquireTile(acquisition(input)), rejects);
      if (stage === "decode") assert.deepEqual(await h.host.probe(input), { status: "missing" });
      else await assert.rejects(h.host.probe(input), rejects);
      assert.equal(reads, 2);
      assert.equal(displays, 0);
      if (stage === "painting")
        assert.equal(closed, 3, "measurement and painted bitmaps close on failure");
      await h.host.settle();
    }
});

test("output waits for saving and preserves actual disposition", async () => {
  const h = setup();
  let save;
  h.assembly.finalizeOutput = () =>
    new Promise((resolve) => {
      save = resolve;
    });
  let finished = false;
  const pending = h.host.finish({ canvas: tile.placement.canvas, format: "png" }).then((output) => {
    finished = true;
    return output;
  });
  await tick();
  assert.equal(finished, false);
  save("browser-save-initiated");
  assert.deepEqual(await pending, {
    canvas: tile.placement.canvas,
    format: "png",

    disposition: "browser-save-initiated",
  });
});

test("surface and output failures retain their typed kind", async () => {
  const h = setup();
  h.assembly.prepare = () => {
    throw { kind: "output-unavailable", detail: "No canvas" };
  };
  await assert.rejects(h.host.acquireTile(acquisition(tile)), {
    kind: "resource",
    request: tile.request.uri,
    resource_kind: "tile",
    source: { kind: "output-unavailable", detail: "No canvas" },
  });
  await assert.rejects(
    h.host.probe({
      ...tile,
      placement: { ...tile.placement, role: { probe: true, output: true } },
    }),
    {
      kind: "resource",
      request: tile.request.uri,
      resource_kind: "tile",
      source: { kind: "output-unavailable", detail: "No canvas" },
    },
  );
  h.assembly.finalizeOutput = async () => {
    throw { kind: "encode-failed", detail: "No PNG" };
  };
  await assert.rejects(h.host.finish({ missing: [], format: "png" }), {
    kind: "encode-failed",
    detail: "No PNG",
  });
});

test("output errors retain the original diagnostic details", async () => {
  const h = setup();
  h.assembly.finalizeOutput = async () => {
    throw { kind: "write-failed", detail: "FILE_NO_SPACE" };
  };
  await assert.rejects(h.host.finish({ missing: [], format: "png" }), {
    kind: "write-failed",
    detail: "FILE_NO_SPACE",
  });
});

test("canonical failures retain their precise request and affected resource", async () => {
  const h = setup({
    fetchResource: async () => {
      throw {
        kind: "http-error",
        status: 403,
        request: "https://redirect.test/actual.jpg",
        transport: "browser-session",
        detail: "the redirected file was refused",
      };
    },
  });
  await assert.rejects(h.host.acquireTile(acquisition(tile)), {
    kind: "resource",
    request: tile.request.uri,
    resource_kind: "tile",
    source: {
      kind: "http-error",
      status: 403,
      request: "https://redirect.test/actual.jpg",
      transport: "browser-session",
      detail: "the redirected file was refused",
    },
  });
  h.assembly.prepare = () => {
    throw { kind: "output-unavailable", detail: "the output cannot be allocated" };
  };
  await assert.rejects(h.host.acquireTile(acquisition(tile)), {
    kind: "resource",
    request: tile.request.uri,
    resource_kind: "tile",
    source: { kind: "output-unavailable", detail: "the output cannot be allocated" },
  });
});

test("output preflight ignores acquisition pause and classifies cancellation", async () => {
  const h = setup();
  h.host.pause();
  await h.host.beginOutput({ canvas: tile.placement.canvas, grid: null, title: null });
  h.controller.abort();
  await assert.rejects(h.host.beginOutput({}), { kind: "cancelled" });
});

test("pause gates acquisition, resume releases it, cancellation interrupts waits and late progress", async () => {
  const h = setup();
  h.host.pause();
  let acquired = false;
  const pending = h.host.checkpoint("acquisition").then(() => {
    acquired = true;
  });
  await h.host.checkpoint("cancellation");
  await tick();
  assert.equal(acquired, false);
  h.host.resume();
  await pending;
  assert.equal(acquired, true);
  h.host.pause();
  const cancelled = assert.rejects(h.host.checkpoint("acquisition"), {
    kind: "cancelled",
  });
  const sleep = assert.rejects(h.host.sleep(999999), { kind: "cancelled" });
  h.controller.abort();
  await Promise.all([cancelled, sleep]);
  h.host.report({ phase: "acquisition", completed: 2, total: 2 });
  assert.deepEqual(h.reports, []);
});

test("cancellation rejects late readable bytes before painting", async () => {
  let complete;
  const h = setup({
    fetchResource: () =>
      new Promise((resolve) => {
        complete = resolve;
      }),
  });
  const rejected = assert.rejects(h.host.acquireTile(acquisition(tile)), { kind: "cancelled" });
  h.controller.abort();
  complete({ kind: "response", response: { bytes: new Uint8Array([1]), final_uri: null } });
  await rejected;
  assert.deepEqual(h.painted, []);
});

test("settlement aborts and joins a dropped sibling fetch before returning", async () => {
  let rejectFetch,
    signal,
    aborted = false;
  const h = setup({
    fetchResource: (_request, owned) => {
      signal = owned;
      return new Promise((_, reject) => {
        rejectFetch = reject;
        owned.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
      });
    },
  });
  const sibling = assert.rejects(h.host.fetch(tile.request, "forbidden"), {
    kind: "cancelled",
  });
  let settled = false;
  const cleanup = h.host.settle().then(() => {
    settled = true;
  });
  await tick();
  assert.equal(signal.aborted, true);
  assert.equal(aborted, true);
  assert.equal(settled, false);
  rejectFetch(new DOMException("Aborted", "AbortError"));
  await Promise.all([cleanup, sibling]);
  assert.equal(settled, true);
  assert.equal(
    h.controller.signal.aborted,
    false,
    "resource cleanup preserves the completed invocation result",
  );
});

test("settlement waits for native decoding after promptly rejecting the cancelled probe", async () => {
  let finish;
  const decoder = createTileDecoder({
    createImageBitmap: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const h = setup({ decoder });
  const probe = assert.rejects(h.host.probe(tile), { kind: "cancelled" });
  await tick();
  let settled = false;
  const cleanup = h.host.settle().then(() => {
    settled = true;
  });
  await probe;
  await tick();
  assert.equal(settled, false);
  let closed = false;
  finish({
    width: 256,
    height: 256,
    close() {
      closed = true;
    },
  });
  await cleanup;
  assert.equal(closed, true);
  assert.equal(settled, true);
  assert.deepEqual(h.painted, []);
});

test("settlement cancels a pending retry approval without requiring a host response", async () => {
  const h = setup({ approveRetry: () => new Promise(() => {}) });
  const acquiring = assert.rejects(
    h.host.acquireTile({ tile, attempt: 4, requires_approval: true }),
    { kind: "cancelled" },
  );
  await tick();
  assert.deepEqual(h.painted, []);
  await Promise.all([acquiring, h.host.settle()]);
  assert.deepEqual(h.painted, []);
});

const image = (sizes) => ({ format: "test", levels: sizes.map((size) => ({ label: "", size })) });
const square = (width) => ({ width, height: width });

test("image choice compares actual levels, skips deferred entries, and preserves ties", async () => {
  const host = setup().host;
  const deferred = { kind: "image-request", uri: "https://images.test/info.json" };
  const wide = {
    kind: "image",
    ...image([
      { width: 1000, height: 1 },
      { width: 1, height: 1000 },
    ]),
    size: square(1000),
  };
  const bigger = { kind: "image", ...image([square(100)]) };
  assert.equal(await host.chooseImage({ entries: [deferred, wide, bigger] }), 2);
  assert.equal(await host.chooseImage({ entries: [deferred, deferred] }), 0);
  assert.equal(await host.chooseImage({ entries: [bigger, bigger] }), 1);
  assert.equal(
    await host.chooseImage({ entries: [deferred, { kind: "image", ...image([undefined]) }] }),
    1,
  );
});

test("resolution choice fits device limits and preserves fallback behavior", async () => {
  const host = setup().host;
  for (const [sizes, expected] of [
    [[square(1), square(256), square(512)], 1],
    [[square(512), square(1024)], 0],
    [[undefined, undefined], 1],
    [[square(0), square(256)], 1],
    [[square(256), square(256)], 1],
    [
      [
        { width: 300, height: 300 },
        { width: 301, height: 1 },
      ],
      0,
    ],
  ])
    assert.equal(await host.chooseLevel(image(sizes)), expected);
  const areaHost = setup({
    selectionLimits: { maxWidth: 1000, maxHeight: 1000, maxArea: 100 },
  }).host;
  assert.equal(await areaHost.chooseLevel(image([square(10), square(20)])), 0);
  const maximum = setup({ selectionLimits: MAXIMUM_SELECTION_LIMITS }).host;
  assert.equal(await maximum.chooseLevel(image([square(256), square(32768)])), 1);
});

test("invalid resolution limits fail before fetching and cancelled choices reject", async () => {
  for (const key of ["maxWidth", "maxHeight", "maxArea"]) {
    assert.throws(
      () => setup({ selectionLimits: { maxWidth: 300, maxHeight: 300, maxArea: 90000, [key]: 0 } }),
      { kind: "invalid-options" },
    );
  }
  const h = setup();
  h.controller.abort();
  await assert.rejects(h.host.chooseImage({ entries: [] }), { kind: "cancelled" });
  await assert.rejects(h.host.chooseLevel(image([square(1)])), { kind: "cancelled" });
});
