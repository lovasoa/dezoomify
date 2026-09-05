// Web worker: owns the real wasm core discovery session. Pure computation:
// the worker never fetches anything; the main thread performs every network
// request through the classified transport and feeds bytes back here.
import init, { DiscoverySession } from "../wasm/dezoomify-wasm.js";
import { discoveryFailedError, noImageFoundError } from "./discovery.js";

let ready = null;
let session = null;
let busy = Promise.resolve();
// Most recent structured transport failure reported by the main thread.
// When discovery ultimately fails, this, not the core's per-format
// diagnostic aggregate, is the outcome the user sees; the aggregate moves
// to the technical `detail` field.
let lastFailure = null;

function post(message, transfer) {
  self.postMessage(message, transfer ?? []);
}

function noteFailure(msg) {
  lastFailure = {
    code: msg.code || "DISCOVERY_FAILED",
    // Hand-holding sentence for the prominent UI slot.
    message: msg.userMessage || msg.message || "fetch failed",
    // Dense technical diagnostics (HTTP status, transport) for the engine
    // and the technical-details section.
    technical: msg.message || "fetch failed",
  };
}

/**
 * Surface a discovery failure in layers: the main `code`/`message` pair is a
 * plain, actionable sentence; `detail` keeps the dense technical chain (the
 * last transport failure with HTTP status/transport, then the engine's
 * per-format diagnostic aggregate) for the collapsible technical section.
 */
function postDiscoveryFailure(error) {
  const engineDetail = (error && error.message) || String(error);
  const failure = lastFailure;
  lastFailure = null;
  if (failure) {
    const detail = [failure.technical, engineDetail].filter(Boolean).join("\n\n");
    post({ type: "error", code: failure.code, message: failure.message, detail });
    return;
  }
  if (detail.includes("no discovery candidate accepted")) {
    post({
      type: "error",
      code: "NO_IMAGE_FOUND",
      message: noImageFoundError().message,
      detail,
    });
    return;
  }
  post({
    type: "error",
    code: "DISCOVERY_FAILED",
    message: discoveryFailedError().message,
    detail,
  });
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
  let catalog;
  try {
    // Throws the engine's diagnostic aggregate when no candidate accepted.
    catalog = JSON.parse(session.finish());
  } catch (error) {
    postDiscoveryFailure(error);
    return true;
  }
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
    // Prominent slot stays user-readable; the wasm text moves to `detail`.
    post({
      type: "error",
      code: (error && error.code) || "WORKER_FAILED",
      message: "Something went wrong in the image engine. Reload the page and try again.",
      detail: (error && error.message) || String(error),
    });
  });
};

async function handle(msg) {
  switch (msg.type) {
    case "start": {
      await ensureReady();
      session = new DiscoverySession(msg.url);
      lastFailure = null;
      try {
        pumpNeeds();
      } catch (error) {
        postDiscoveryFailure(error);
      }
      return;
    }
    case "provide": {
      if (!session) throw Object.assign(new Error("no discovery session"), { code: "WORKER_FAILED" });
      try {
        session.provide(msg.id, new Uint8Array(msg.bytes), msg.finalUri || "");
        lastFailure = null;
      } catch (error) {
        postDiscoveryFailure(error);
        return;
      }
      pumpNeeds();
      return;
    }
    case "fail": {
      if (!session) throw Object.assign(new Error("no discovery session"), { code: "WORKER_FAILED" });
      noteFailure(msg);
      try {
        session.provideFailure(msg.id, msg.message || "fetch failed");
      } catch (error) {
        postDiscoveryFailure(error);
        return;
      }
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
