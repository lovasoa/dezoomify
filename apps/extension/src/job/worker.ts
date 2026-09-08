/**
 * Dedicated job-worker entrypoint. It is intentionally a thin host around
 * the Rust/WASM Session: commands and effects remain protocol envelopes, so
 * this file cannot grow a second JavaScript state machine.
 */

const encoder = new TextEncoder();

/** @param {unknown} value */
function object(value) {
  return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : {};
}

/** @param {Record<string, unknown>} command */
function commandBytes(command) {
  return encoder.encode(`${JSON.stringify({ protocol: "1.0", kind: "command", ...command })}\n`);
}

/** @param {{ postMessage: (message: unknown) => void, wasm: () => Promise<any> }} deps */
export function createJobWorkerHost(deps) {
  /** @type {any | null} */
  let session = null;
  let disposed = false;

  function flush() {
    if (!session) return;
    let messages;
    try { messages = JSON.parse(session.drainMessages()); } catch (error) {
      deps.postMessage({ type: "engine.error", error: { code: "malformed", message: String(error) } });
      return;
    }
    if (Array.isArray(messages) && messages.length) deps.postMessage({ type: "engine.messages", messages });
  }

  function dispatch(command) {
    if (!session || disposed) return;
    session.dispatch(commandBytes(command));
    flush();
  }

  async function start(message) {
    const wasm = await deps.wasm();
    if (disposed) return;
    await wasm.default?.();
    session = new wasm.Session("1.0", JSON.stringify(message.quotas ?? {}));
    dispatch({ type: "start", job: message.jobId, input_url: message.inputUrl });
  }

  /** @param {any} message */
  function provideBytes(message) {
    if (!session || disposed || !(message.bytes instanceof Uint8Array)) return;
    const handle = JSON.parse(session.allocateBuffer(message.bytes.byteLength));
    const handleJson = JSON.stringify(handle);
    session.writeBuffer(handleJson, 0, message.bytes);
    session.commitBuffer(handleJson, message.bytes.byteLength);
    dispatch({ type: "provide-resource", job: message.jobId, request: message.requestId, buffer: handle });
  }

  return {
    /** @param {any} message */
    async onMessage(message) {
      if (!message || typeof message !== "object" || disposed) return;
      try {
        if (message.type === "engine.start") await start(message);
        else if (message.type === "engine.bytes") provideBytes(message);
        else if (message.type === "engine.failure") dispatch({ type: "provide-fetch-failure", job: message.jobId, request: message.requestId, error: message.error });
        else if (message.type === "engine.command") dispatch(object(message.command));
        else if (message.type === "engine.dispose") {
          disposed = true;
          try { session?.dispose(); } finally { session = null; }
        }
      } catch (error) {
        deps.postMessage({ type: "engine.error", error: { code: "malformed", message: error instanceof Error ? error.message : String(error) } });
      }
    },
  };
}

// Build output invokes this module as a classic dedicated worker. Dynamic
// import leaves the generated wasm glue as a build-time dependency instead of
// hand-vendoring it into the UI entrypoint.
if (typeof self !== "undefined" && "postMessage" in self && typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope) {
  const host = createJobWorkerHost({
    postMessage: (message) => self.postMessage(message),
    wasm: () => import("../wasm/dezoomify-wasm.js"),
  });
  self.addEventListener("message", (event) => { void host.onMessage(event.data); });
}
