import test from "node:test";
import assert from "node:assert/strict";
import { createDiscoveryClient, failure } from "../src/session.ts";

/**
 * Loopback test worker: runs the worker side of the protocol against a
 * scripted core session so the client logic is exercised end to end without
 * a browser or wasm.
 */
function loopbackWorker(script) {
  const worker = {
    onmessage: null,
    terminated: false,
    postMessage(msg) {
      const reply = script(msg, (response, transfer) => {
        queueMicrotask(() => worker.onmessage?.({ data: response }));
      });
      if (reply) {
        queueMicrotask(() => worker.onmessage?.({ data: reply }));
      }
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

test("start routes needs through fetchMetadata and resolves the catalog", async () => {
  const fetched = [];
  const worker = loopbackWorker((msg, respond) => {
    if (msg.type === "start") {
      respond({ type: "need", id: 0, uri: "https://site.test/info.json", headers: {} });
      return;
    }
    if (msg.type === "provide") {
      assert.equal(msg.id, 0);
      assert.ok(msg.bytes instanceof ArrayBuffer);
      respond({ type: "catalog", catalog: { images: [{ id: 0, format: "iiif", levels: [{ index: 0 }] }] } });
      return;
    }
  });
  const client = createDiscoveryClient({
    worker,
    fetchMetadata: async (url) => {
      fetched.push(url);
      return { bytes: new ArrayBuffer(4), finalUri: url };
    },
    fetchTile: async () => ({ bytes: new ArrayBuffer(0) }),
    probeSize: async () => ({ ok: false, width: 0, height: 0 }),
  });
  const catalog = await client.start("https://site.test/info.json");
  assert.deepEqual(fetched, ["https://site.test/info.json"]);
  assert.equal(catalog.images.length, 1);
  client.dispose();
  assert.equal(worker.terminated, true);
});

test("plan drives probe rounds until the plan resolves", async () => {
  let probes = 0;
  const worker = loopbackWorker((msg, respond) => {
    if (msg.type === "plan") {
      respond({ type: "probe", uri: "https://site.test/tiles/0_0.png", headers: {} });
      return;
    }
    if (msg.type === "probe-submit") {
      probes += 1;
      assert.equal(msg.ok, true);
      assert.equal(msg.width, 256);
      if (probes < 2) {
        respond({ type: "probe", uri: "https://site.test/tiles/1_0.png", headers: {} });
      } else {
        respond({
          type: "plan",
          canvas: { x: 512, y: 256 },
          tiles: [{ uri: "https://site.test/tiles/0_0.png", x: 0, y: 0, processing: "none" }],
        });
      }
      return;
    }
  });
  const client = createDiscoveryClient({
    worker,
    fetchMetadata: async () => ({ bytes: new ArrayBuffer(1) }),
    fetchTile: async () => ({ bytes: new ArrayBuffer(8) }),
    probeSize: async () => ({ ok: true, width: 256, height: 256 }),
  });
  const plan = await client.plan(0, 0);
  assert.equal(probes, 2);
  assert.equal(plan.canvas.x, 512);
  assert.equal(plan.tiles.length, 1);
  client.dispose();
});

test("worker errors reject with structured codes", async () => {
  const worker = loopbackWorker((msg, respond) => {
    respond({
      type: "error",
      code: "NO_IMAGE_FOUND",
      message: "No zoomable image was found at this address.",
    });
  });
  const client = createDiscoveryClient({
    worker,
    fetchMetadata: async () => ({ bytes: new ArrayBuffer(1) }),
    fetchTile: async () => ({ bytes: new ArrayBuffer(1) }),
    probeSize: async () => ({ ok: false, width: 0, height: 0 }),
  });
  await assert.rejects(
    () => client.start("https://site.test/page.html"),
    (error) => error.code === "NO_IMAGE_FOUND" && error.retryable === false,
  );
});

test("fetch failures are forwarded to the worker as fail messages", async () => {
  const failures = [];
  const worker = loopbackWorker((msg, respond) => {
    if (msg.type === "start") {
      respond({ type: "need", id: 3, uri: "https://site.test/blocked.json", headers: {} });
      return;
    }
    if (msg.type === "fail") {
      failures.push(msg);
      respond({ type: "catalog", catalog: { images: [] } });
      return;
    }
  });
  const client = createDiscoveryClient({
    worker,
    fetchMetadata: async () => {
      throw failure("PROXY_ERROR", "proxy down", false);
    },
    fetchTile: async () => ({ bytes: new ArrayBuffer(1) }),
    probeSize: async () => ({ ok: false, width: 0, height: 0 }),
  });
  const catalog = await client.start("https://site.test/blocked.json");
  assert.equal(failures.length, 1);
  assert.equal(failures[0].code, "PROXY_ERROR");
  assert.deepEqual(catalog.images, []);
  client.dispose();
});

test("a second operation is rejected while one is pending", async () => {
  const worker = loopbackWorker(() => {
    // Never responds: keeps the first operation pending.
  });
  const client = createDiscoveryClient({
    worker,
    fetchMetadata: async () => ({ bytes: new ArrayBuffer(1) }),
    fetchTile: async () => ({ bytes: new ArrayBuffer(1) }),
    probeSize: async () => ({ ok: false, width: 0, height: 0 }),
  });
  const first = client.start("https://site.test/slow");
  await assert.rejects(
    () => client.plan(0, 0),
    (error) => error.code === "CLIENT_BUSY",
  );
  client.dispose();
  await assert.rejects(() => first, (error) => error.code === "DISPOSED");
});

test("dispose rejects pending operations and stops the worker", async () => {
  const worker = loopbackWorker(() => {});
  const client = createDiscoveryClient({
    worker,
    fetchMetadata: async () => ({ bytes: new ArrayBuffer(1) }),
    fetchTile: async () => ({ bytes: new ArrayBuffer(1) }),
    probeSize: async () => ({ ok: false, width: 0, height: 0 }),
  });
  const pending = client.start("https://site.test/x");
  client.dispose();
  await assert.rejects(() => pending, (error) => error.code === "DISPOSED");
  assert.equal(worker.terminated, true);
});
