// Web worker: owns the real wasm core discovery session. Pure computation —
// the worker never fetches anything; the main thread performs every network
// request through the classified transport and feeds bytes back here.
import init, { DiscoverySession } from "../wasm/dezoomify-wasm.js";

let ready = null;
let session = null;
let busy = Promise.resolve();

function post(message, transfer) {
  self.postMessage(message, transfer ?? []);
}

async function ensureReady() {
  if (!ready) {
    ready = init();
  }
  await ready;
}

/** Pump every outstanding core need to the main thread, then emit the catalog. */
function pumpNeeds() {
  for (;;) {
    const need = session.nextNeed();
    if (need === "null" || need === null || need === undefined) break;
    const parsed = JSON.parse(need);
    post({ type: "need", id: parsed.id, uri: parsed.uri, headers: parsed.headers ?? {} });
    // Needs are sequential: wait for the main thread to answer this one.
    return false;
  }
  const catalog = JSON.parse(session.finish());
  post({ type: "catalog", catalog });
  return true;
}

function dispatchPlan(image, level) {
  const result = JSON.parse(session.levelTiles(image, level));
  if (result.kind === "probe") {
    post({ type: "probe", uri: result.uri, headers: result.headers ?? {} });
    return;
  }
  post({ type: "plan", canvas: result.canvas, tiles: result.tiles ?? [] });
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== "string") return;
  busy = busy.then(() => handle(msg)).catch((error) => {
    post({
      type: "error",
      code: (error && error.code) || "WORKER_FAILED",
      message: (error && error.message) || String(error),
    });
  });
};

async function handle(msg) {
  switch (msg.type) {
    case "start": {
      await ensureReady();
      session = new DiscoverySession(msg.url);
      pumpNeeds();
      return;
    }
    case "provide": {
      if (!session) throw Object.assign(new Error("no discovery session"), { code: "WORKER_FAILED" });
      session.provide(msg.id, new Uint8Array(msg.bytes), msg.finalUri || "");
      pumpNeeds();
      return;
    }
    case "fail": {
      if (!session) throw Object.assign(new Error("no discovery session"), { code: "WORKER_FAILED" });
      session.provideFailure(msg.id, msg.message || "fetch failed");
      pumpNeeds();
      return;
    }
    case "plan": {
      if (!session) throw Object.assign(new Error("no discovery session"), { code: "WORKER_FAILED" });
      dispatchPlan(msg.image, msg.level);
      return;
    }
    case "probe-submit": {
      if (!session) throw Object.assign(new Error("no discovery session"), { code: "WORKER_FAILED" });
      const result = JSON.parse(
        session.probeSubmit(msg.image, msg.level, msg.ok, msg.width, msg.height),
      );
      if (result.kind === "probe") {
        post({ type: "probe", uri: result.uri, headers: result.headers ?? {} });
      } else {
        post({ type: "plan", canvas: result.canvas, tiles: result.tiles ?? [] });
      }
      return;
    }
    case "process": {
      if (!session) throw Object.assign(new Error("no discovery session"), { code: "WORKER_FAILED" });
      const processed = session.applyProcessing(msg.recipe, new Uint8Array(msg.bytes));
      post({ type: "processed", bytes: processed.buffer }, [processed.buffer]);
      return;
    }
    default:
      return;
  }
}
