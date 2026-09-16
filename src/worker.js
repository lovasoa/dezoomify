// Web worker: owns the real wasm core discovery session. Pure computation:
// the worker never fetches anything; the main thread performs every network
// request through the classified transport and feeds bytes back here.
import init, { DiscoverySession } from "../wasm/dezoomify-wasm.js";
import { discoveryFailedError, noImageFoundError } from "./discovery.ts";

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
    message: msg.userMessage || "fetch failed",
    // Retryability is decided at the failure site (an upstream 403 or our
    // own policy denial never becomes retryable downstream).
    retryable: typeof msg.retryable === "boolean" ? msg.retryable : true,
    // Structured context for the technical-details section: the full
    // request URL (rendered verbatim, on-device only), the HTTP status,
    // and the bounded server signal.
    url: typeof msg.url === "string" && msg.url !== "" ? msg.url : undefined,
    http: typeof msg.http === "number" ? msg.http : undefined,
    preview: typeof msg.preview === "string" && msg.preview !== "" ? msg.preview : undefined,
  };
}

/**
 * Decode the error a wasm call throws. wasm-bindgen rejects with the
 * serialized protocol ErrorDto as a JSON string; older hosts may throw
 * plain Error objects. Returns the decoded dto (with `.code` and
 * `.message`) or null when undecodable.
 */
function decodeEngineError(error) {
  if (typeof error === "string") {
    try {
      const parsed = JSON.parse(error);
      if (parsed && typeof parsed === "object" && typeof parsed.code === "string") return parsed;
    } catch {
      // Not JSON: fall through.
    }
    return null;
  }
  if (error && typeof error === "object" && typeof error.code === "string") return error;
  return null;
}

/**
 * Surface a discovery failure in layers: the main `code`/`message` pair is a
 * plain, actionable sentence; `detail` keeps the engine's per-format
 * diagnostic aggregate (headline-free bullet block) for the collapsible
 * technical section, and `url`/`http`/`preview` carry the structured
 * fetch context.
 */
function postDiscoveryFailure(error) {
  const engine = decodeEngineError(error);
  const engineBlock =
    (engine && typeof engine.message === "string" && engine.message) ||
    (error && error.message) ||
    String(error);
  const failure = lastFailure;
  lastFailure = null;
  if (failure) {
    post({
      type: "error",
      code: failure.code,
      message: failure.message,
      detail: engineBlock || undefined,
      retryable: failure.retryable,
      ...(failure.url ? { url: failure.url } : {}),
      ...(failure.http !== undefined ? { http: failure.http } : {}),
      ...(failure.preview ? { preview: failure.preview } : {}),
    });
    return;
  }
  if (engine && engine.code === "adapter.no-candidate") {
    post({
      type: "error",
      code: "NO_IMAGE_FOUND",
      message: noImageFoundError().message,
      detail: engineBlock,
    });
    return;
  }
  post({
    type: "error",
    code: "DISCOVERY_FAILED",
    message: discoveryFailedError().message,
    detail: engineBlock,
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
    // Prominent slot stays user-readable; the decoded engine detail (if
    // the wasm ErrorDto JSON) moves to `detail`.
    const engine = decodeEngineError(error);
    post({
      type: "error",
      code: (error && error.code) || "WORKER_FAILED",
      message: "Something went wrong in the image engine. Reload the page and try again.",
      detail: (engine && engine.message) || (error && error.message) || String(error),
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
        // Empty redirect URLs collapse to the request URI downstream; never
        // forward "" as a base for relative tile URLs (krpano regression:
        // galleria_04.tiles/* resolved against /beta/ and 404'd).
        const finalUri =
          typeof msg.finalUri === "string" && msg.finalUri !== "" ? msg.finalUri : undefined;
        session.provide(
          msg.id,
          new Uint8Array(msg.bytes),
          typeof finalUri === "string" ? finalUri : "",
        );
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
        // The engine receives the typed cause (the core wire shape
        // `{code, http?, transport, reason?}`) and groups diagnostics on
        // it; rendered text never crosses this boundary.
        session.provideFailure(msg.id, JSON.stringify(msg.cause ?? { code: msg.code || "DISCOVERY_FAILED", transport: "direct" }));
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
