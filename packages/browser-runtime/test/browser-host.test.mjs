import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticRecorder } from "../../shared-ui/src/diagnostics.ts";
import { BrowserHost } from "../src/browser-host.ts";
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
    choosePartial: async () => "keep",
    ...overrides,
  };
  return { host: new BrowserHost(deps), deps, controller, assembly, painted, reports, diagnostics };
}

test("acquisition decodes and paints readable bytes before returning", async () => {
  const h = setup();
  assert.equal(await h.host.acquireTile(tile), undefined);
  assert.deepEqual([...new Uint8Array(h.painted[0][2])], [1, 2]);
  assert.equal(h.painted[0][0], 0);
  assert.equal(h.painted[0][1], tile.placement);
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
    await assert.rejects(h.host.acquireTile(tile), {
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
    assert.equal(displays, 0);
    const failure = h.diagnostics.report().failures[0].first.fields;
    assert.equal(failure["source.status"], http);
    assert.equal(failure.request, tile.request.uri);
  }
});

test("an unreadable origin is classified once across concurrent ordinary tiles", async () => {
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
  const results = await Promise.all(
    [0, 1, 2].map((index) => h.host.acquireTile({ ...tile, index })),
  );
  assert.equal(reads, 1);
  assert.equal(displays, 3);
  assert.ok(results.every((result) => result === undefined));
  await h.host.acquireTile({ ...tile, index: 3 });
  assert.equal(reads, 1);
});

test("processed tiles and permission denial never use ordinary images", async () => {
  const network = { kind: "network-failure", transport: "direct" };
  const denied = {
    kind: "policy-denied",
    blocked_reason: "access-required",
    transport: "browser-session",
  };
  for (const [processing, failure] of [
    ["google-arts-decrypt", network],
    ["none", denied],
  ]) {
    const h = setup({
      fetchResource: async () => {
        throw failure;
      },
      loadDisplayImage: async () => assert.fail("pixels must be readable"),
    });
    await assert.rejects(
      h.host.acquireTile({ ...tile, placement: { ...tile.placement, processing } }),
      { kind: "resource", request: tile.request.uri, resource_kind: "tile", source: failure },
    );
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
});

test("output waits for saving and preserves actual disposition and missing tiles", async () => {
  const h = setup();
  let save;
  h.assembly.finalizeOutput = () =>
    new Promise((resolve) => {
      save = resolve;
    });
  let finished = false;
  const pending = h.host
    .finish({ canvas: tile.placement.canvas, format: "png", missing: [2] })
    .then((output) => {
      finished = true;
      return output;
    });
  await tick();
  assert.equal(finished, false);
  save("browser-save-initiated");
  assert.deepEqual(await pending, {
    canvas: tile.placement.canvas,
    format: "png",
    missing: [2],
    disposition: "browser-save-initiated",
  });
});

test("surface and output failures retain their typed kind", async () => {
  const h = setup();
  h.assembly.prepare = () => {
    throw { kind: "output-unavailable", detail: "No canvas" };
  };
  await assert.rejects(h.host.acquireTile(tile), {
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
  await assert.rejects(h.host.acquireTile(tile), {
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
  await assert.rejects(h.host.acquireTile(tile), {
    kind: "resource",
    request: tile.request.uri,
    resource_kind: "tile",
    source: { kind: "output-unavailable", detail: "the output cannot be allocated" },
  });
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
  const rejected = assert.rejects(h.host.acquireTile(tile), { kind: "cancelled" });
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

test("settlement cancels a permission interaction and suppresses a late image", async () => {
  let image, signal;
  const h = setup({
    fetchResource: async () => {
      throw { kind: "network-failure", transport: "direct" };
    },
    loadDisplayImage: (_url, owned) => {
      signal = owned;
      return new Promise((resolve) => {
        image = resolve;
      });
    },
    choosePartial: (_missing, owned) =>
      new Promise((_, reject) =>
        owned.addEventListener("abort", () => reject(owned.reason), { once: true }),
      ),
  });
  const painting = assert.rejects(h.host.acquireTile(tile), { kind: "cancelled" });
  const choosing = assert.rejects(h.host.choosePartial({ missing: [] }), {
    kind: "cancelled",
  });
  await tick();
  const cleanup = h.host.settle();
  assert.equal(signal.aborted, true);
  image({ naturalWidth: 256, naturalHeight: 256 });
  await Promise.all([painting, choosing, cleanup]);
  assert.deepEqual(h.painted, []);
});

test("permission failures retain their canonical facts", async () => {
  const denied = {
    kind: "policy-denied",
    blocked_reason: "access-required",
    transport: "browser-session",
    detail: "Denied",
  };
  const h = setup({
    fetchResource: async () => {
      throw denied;
    },
    loadDisplayImage: async () => assert.fail("denied permission is not display-only"),
  });
  await assert.rejects(h.host.acquireTile(tile), {
    kind: "resource",
    request: tile.request.uri,
    resource_kind: "tile",
    source: denied,
  });
});
