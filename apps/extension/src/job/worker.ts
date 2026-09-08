/**
 * Dedicated job-worker entrypoint. It is intentionally a thin host around
 * the Rust/WASM Session: commands and effects remain protocol envelopes, so
 * this file cannot grow a second JavaScript state machine.
 */

const encoder = new TextEncoder();

/** @param {unknown} value */
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** @param {unknown} error */
function engineError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  let parsed = error;
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); } catch { /* legacy string error */ }
  }
  const candidate = object(parsed);
  const code = typeof candidate.code === "string" ? candidate.code : "adapter.malformed";
  const message = typeof candidate.message === "string" ? candidate.message : raw;
  return {
    code,
    phase: typeof candidate.phase === "string" ? candidate.phase : "validation",
    retryable: candidate.retryable === true,
    message,
    detail: `${code}: ${message}`,
    transport: "browser-session",
  };
}

/** @param {Record<string, unknown>} command */
function commandBytes(command: Record<string, unknown>): Uint8Array {
  return encoder.encode(`${JSON.stringify({ protocol: "1.0", kind: "command", ...command })}\n`);
}

/** @param {{ postMessage: (message: unknown) => void, wasm: () => Promise<any> }} deps */
interface WasmSession {
  drainMessages(): string; dispatch(command: Uint8Array): void; allocateBuffer(length: number): string;
  writeBuffer(handle: string, offset: number, bytes: Uint8Array): void; commitBuffer(handle: string, length: number): void;
  protocolHandle(handle: string): string; dispose(): void;
}
interface WasmModule { default?: () => Promise<void>; Session: new (protocol: string, quotas: string) => WasmSession; rankCandidates?: (urls: string) => string }
type WorkerMessage = Record<string, unknown> & { type?: string; jobId?: string; inputUrl?: string; requestId?: string; urls?: unknown; bytes?: unknown; command?: unknown; error?: unknown; quotas?: unknown };

export function createJobWorkerHost(deps: { postMessage(message: unknown): void; wasm(): Promise<WasmModule> }) {
  /** @type {any | null} */
  let session: WasmSession | null = null;
  let disposed = false;

  function flush() {
    if (!session) return;
    let messages: unknown;
    try { messages = JSON.parse(session.drainMessages()); } catch (error) {
      deps.postMessage({ type: "engine.error", error: engineError(error) });
      return;
    }
    if (Array.isArray(messages) && messages.length) deps.postMessage({ type: "engine.messages", messages });
  }

  function dispatch(command: Record<string, unknown>) {
    if (!session || disposed) return;
    session.dispatch(commandBytes(command));
    flush();
  }

  async function start(message: WorkerMessage) {
    const wasm = await deps.wasm();
    if (disposed) return;
    await wasm.default?.();
    session = new wasm.Session("1.0", JSON.stringify(message.quotas ?? {}));
    dispatch({ type: "start", job: message.jobId, input_url: message.inputUrl });
  }

  /**
   * Rank candidate URLs with the core preference order. Runs before any
   * session exists; the wasm module load is shared with engine.start.
   * Unknown or failing rank calls fall back to the caller-supplied order.
   */
  async function rank(message: WorkerMessage) {
    const urls = Array.isArray(message.urls) ? message.urls.filter((url): url is string => typeof url === "string") : [];
    let ranked: string[] = [];
    try {
      const wasm = await deps.wasm();
      // The glue must be initialized before any binding call, exactly like
      // engine.start: an uninitialized call throws and would silently fall
      // back to the unranked input order.
      await wasm.default?.();
      if (!disposed && typeof wasm.rankCandidates === "function") {
        const parsed = JSON.parse(wasm.rankCandidates(JSON.stringify(urls)));
        if (Array.isArray(parsed)) ranked = parsed.map((entry: unknown) => object(entry).url).filter((url): url is string => typeof url === "string");
      }
    } catch {
      ranked = [];
    }
    deps.postMessage({ type: "engine.ranked", requestId: message.requestId, urls: ranked.length ? ranked : urls });
  }

  /** @param {any} message */
  function provideBytes(message: WorkerMessage) {
    if (!session || disposed || !(message.bytes instanceof Uint8Array)) return;
    const handle = JSON.parse(session.allocateBuffer(message.bytes.byteLength));
    const handleJson = JSON.stringify(handle);
    session.writeBuffer(handleJson, 0, message.bytes);
    session.commitBuffer(handleJson, message.bytes.byteLength);
    // The command envelope carries the canonical protocol reference, not the
    // arena form allocateBuffer returns.
    const buffer = JSON.parse(session.protocolHandle(handleJson));
    dispatch({ type: "provide-resource", job: message.jobId, request: message.requestId, buffer });
  }

  return {
    /** @param {any} message */
    async onMessage(message: unknown) {
      if (!message || typeof message !== "object" || disposed) return;
      const envelope = message as WorkerMessage;
      try {
        if (envelope.type === "engine.start") await start(envelope);
        else if (envelope.type === "engine.rank") await rank(envelope);
        else if (envelope.type === "engine.bytes") provideBytes(envelope);
        else if (envelope.type === "engine.failure") dispatch({ type: "provide-fetch-failure", job: envelope.jobId, request: envelope.requestId, error: envelope.error });
        else if (envelope.type === "engine.command") dispatch(object(envelope.command));
        else if (envelope.type === "engine.dispose") {
          disposed = true;
          try { session?.dispose(); } finally { session = null; }
        }
      } catch (error) {
        deps.postMessage({ type: "engine.error", error: engineError(error) });
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
