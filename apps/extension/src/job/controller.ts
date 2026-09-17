/**
 * Effect host for one WASM session. It never performs discovery/selection or
 * retries itself: it answers the engine's correlated effects and forwards
 * engine events to the job-tab UI. The module is import-free (every host
 * capability, including the fetch-failure classifier, is injected) so it
 * stays directly unit-testable.
 *
 * Two execution lanes, matching the engine's own scheduling:
 * - `acquire-resource`/`acquire-tile` run concurrently (the engine already
 *   caps in-flight tiles); tile bytes are decoded during acquisition (the
 *   native model), so a tile that cannot decode fails its acquisition
 *   outcome and flows through the engine's retry/partial policy.
 * - every other effect runs through one strictly ordered chain, because the
 *   engine emits the decode/encode/publish/release sequence as an ordered
 *   batch whose events must not overtake the work they describe.
 */

/**
 * @typedef {Object} AssemblyLike
 * @property {(tile: number, placement: unknown, bytes: ArrayBuffer) => Promise<void>} acquireTile
 * @property {(tile: number) => void} decodePixels
 * @property {(format: string, canvas?: { width: number, height: number } | null) => void} openEncoder
 * @property {() => Promise<void>} finalizeEncoder
 * @property {() => void} publishOutput
 * @property {() => void} release
 */

/**
 * @param {{
 *   worker: { postMessage: (message: unknown) => void },
 *   binding: () => { jobId: string, tabId: number, frameId: number, documentGeneration: number },
 *   sourceTransport: { fetchResource: (request: unknown) => Promise<{ bytes: Uint8Array, finalUrl?: string }> },
 *   extensionTransport: { fetchResource: (url: string, opts?: unknown) => Promise<{ bytes: Uint8Array }>, cancel: () => void },
 *   assembly: AssemblyLike,
 *   classifyFailure: (error: unknown) => { blocked_reason?: string, [key: string]: unknown },
 *   onPermissionRequired: (detail: { hosts: string[], requestId: number, jobId: string }) => void,
 *   onPartialDecision: (recovery: string) => void,
 *   onHostFailure: (error: unknown) => void,
 *   onEvent: (event: any) => void,
 *   onUnsupportedEffect: (envelope: unknown) => void,
 * }} deps
 */
interface AssemblyLike {
  acquireTile(tile: number, placement: unknown, bytes: ArrayBuffer): Promise<void>;
  decodePixels(tile: number): void;
  openEncoder(format: string, canvas?: { width: number; height: number } | null): void;
  finalizeEncoder(): Promise<void>;
  publishOutput(): void;
  release(): void;
}
interface JobControllerDeps {
  worker: { postMessage(message: unknown): void };
  binding(): { jobId: string; tabId: number; frameId: number; documentGeneration: number };
  sourceTransport: { fetchResource(request: unknown): Promise<{ bytes: Uint8Array; finalUrl?: string }> };
  extensionTransport: { fetchResource(url: string, opts?: unknown): Promise<{ bytes: Uint8Array }>; cancel(): void };
  assembly: AssemblyLike;
  classifyFailure(error: unknown): { blocked_reason?: string; [key: string]: unknown };
  onPermissionRequired(detail: { hosts: string[]; requestId: number; jobId: string }): void;
  onPartialDecision(generation: number): void;
  onHostFailure(error: unknown): void;
  onEvent(event: unknown): void;
  onUnsupportedEffect(envelope: unknown): void;
  log?(level: "debug" | "info" | "warn" | "error", code: string, detail?: unknown): void;
}
type EngineEnvelope = { kind: "effect" | "event"; type: string; request?: { id: number; purpose: string; uri: string; method?: string; headers?: Record<string, string> }; tile?: number; placement?: unknown; format?: string; canvas?: { width: number; height: number } | null; generation?: number; [key: string]: unknown };

export function createJobController(deps: JobControllerDeps) {
  const log: NonNullable<JobControllerDeps["log"]> = deps.log ?? (() => {});
  let cancelled = false;
  let disposed = false;
  /** @type {Set<number>} */
  const settled = new Set();
  /** Requests paused while the visible job tab asks for an optional host grant. */
  const waitingForPermission = new Map<number, { effect: EngineEnvelope; failure: { blocked_reason?: string; [key: string]: unknown } }>();
  let chain = Promise.resolve();

  function sendToEngine(message: unknown) { deps.worker.postMessage(message); }

  /** @param {Uint8Array} view */
  function asArrayBuffer(view: Uint8Array): ArrayBuffer {
    return new Uint8Array(view).slice().buffer;
  }

  async function acquire(effect: EngineEnvelope) {
    const request = effect.request;
    if (!request || !Number.isSafeInteger(request.id) || request.id < 0 || settled.has(request.id)) return;
    settled.add(request.id);
    const useSource = request.purpose === "metadata" || request.purpose === "probe";
    log("debug", "effect-fetch", `type=${effect.type} request=${request.id} purpose=${request.purpose} route=${useSource ? "source" : "extension"}`);
    const extensionFetch = () => deps.extensionTransport.fetchResource(request.uri, { requestId: request.id, purpose: request.purpose, headers: request.headers, userIntent: true, cancelled: () => cancelled });
    try {
      let result: { bytes: Uint8Array; finalUrl?: string };
      if (useSource) {
        try {
          result = await deps.sourceTransport.fetchResource({ binding: deps.binding(), requestId: request.id, uri: request.uri, method: request.method, headers: request.headers, purpose: request.purpose });
        } catch (sourceError) {
          // The source-tab fetch is CORS-bound and only credential-safe
          // same-origin. A source-context failure falls back to the
          // independent extension-origin transport, which uses the session
          // under an optional host grant (and pauses for that grant).
          const cause = deps.classifyFailure(sourceError);
          log("warn", "source-fetch-failed", `type=${effect.type} request=${request.id} code=${String(cause.code ?? cause.blocked_reason ?? "network")} retrying=extension-origin`);
          result = await extensionFetch();
        }
      } else {
        result = await extensionFetch();
      }
      if (cancelled) return;
      log("debug", "effect-outcome", `type=${effect.type} request=${request.id} bytes=${result.bytes.byteLength}`);
      if (effect.type === "acquire-tile" && typeof effect.tile === "number" && effect.placement) {
        // Decode-at-acquisition: the placement is recorded and the bitmap is
        // held before the outcome settles, so assembly never depends on a
        // later bytes hand-off and decode failures retry honestly.
        await deps.assembly.acquireTile(effect.tile, effect.placement, asArrayBuffer(result.bytes));
      }
      if (!cancelled) sendToEngine({ type: "engine.bytes", requestId: request.id, bytes: result.bytes });
    } catch (error) {
      const failure = deps.classifyFailure(error);
      log("warn", "effect-failed", `type=${effect.type} request=${request.id} code=${String(failure.code ?? failure.blocked_reason ?? "unknown")} retryable=${failure.retryable === true}`);
      // Only a missing host grant pauses for a visible permission action.
      // Upstream refusals (granted-origin 401/403) and programming errors
      // (missing user intent) fail directly; re-prompting cannot fix them.
      const grantable = failure.blocked_reason === "access-required"
        && error !== null && typeof error === "object"
        && (error as { code?: unknown }).code === "permission-denied";
      if (grantable) {
        const hosts = error && typeof error === "object" && "hosts" in error && Array.isArray(error.hosts) ? error.hosts.filter((host): host is string => typeof host === "string") : [];
        // A visible, explicit user action may grant this host. Keep the
        // effect pending so the same acquisition can resume after a grant.
        waitingForPermission.set(request.id, { effect, failure });
        deps.onPermissionRequired({ hosts, requestId: request.id, jobId: deps.binding().jobId });
        return;
      }
      if (!cancelled) sendToEngine({ type: "engine.failure", requestId: request.id, error: failure });
    }
  }

  /**
   * Ordered lifecycle effects. Any executor failure is terminal for this
   * host: the failure is rendered and the engine job is cancelled so no
   * effect is silently skipped or faked.
   * @param {any} envelope
   */
  async function runLifecycle(envelope: EngineEnvelope) {
    switch (envelope.type) {
      case "finalize-output":
        try {
          deps.assembly.openEncoder(String(envelope.format), envelope.canvas);
          await deps.assembly.finalizeEncoder();
          deps.assembly.publishOutput();
          deps.assembly.release();
          sendToEngine({ type: "engine.command", command: { type: "finalization-succeeded" } });
        } catch (error) {
          const failure = deps.classifyFailure(error);
          deps.onHostFailure(error);
          sendToEngine({ type: "engine.command", command: { type: "finalization-failed", error: {
            code: typeof failure.code === "string" ? failure.code : "output.failed",
            phase: "output",
            retryable: false,
            message: typeof failure.message === "string" ? failure.message : "output finalization failed",
          } } });
        }
        return;
      case "request-decision":
        deps.onPartialDecision(Number(envelope.generation));
        return;
      default:
        log("warn", "unsupported-effect", `type=${envelope.type}`);
        deps.onUnsupportedEffect(envelope);
        return;
    }
  }

  /** @param {() => Promise<void> | void} step */
  function enqueue(step: () => Promise<void> | void) {
    chain = chain
      .then(() => { if (!cancelled) return step(); })
      .catch((error) => {
        if (cancelled) return;
        cancelled = true;
        deps.extensionTransport.cancel();
        deps.onHostFailure(error);
        sendToEngine({ type: "engine.command", command: { type: "cancel" } });
      });
  }

  /** @param {any[]} messages */
  function handleEngineMessages(messages: unknown[]) {
    for (const envelope of messages) {
      if (!envelope || typeof envelope !== "object") continue;
      const message = envelope as EngineEnvelope;
      if (message.kind !== "effect" && message.kind !== "event") continue;
      if (message.kind === "effect") {
        log("debug", "effect-received", `type=${message.type}${message.tile !== undefined ? ` tile=${message.tile}` : ""}`);
        if (message.type === "acquire-resource" || message.type === "acquire-tile") void acquire(message);
        else if (message.type === "cancel-work") {
          deps.extensionTransport.cancel();
          deps.assembly.release();
        }
        else enqueue(() => runLifecycle(message));
      } else {
        // Events pass through the same chain so terminal events never
        // overtake the lifecycle work they describe.
        const event = message;
        log("debug", "event-received", `type=${event.type}`);
        enqueue(() => { deps.onEvent(event); });
      }
    }
  }

  return {
    handleEngineMessages,
    start(inputUrl: string) { sendToEngine({ type: "engine.start", jobId: deps.binding().jobId, inputUrl }); },
    selectImage(image: number) { sendToEngine({ type: "engine.command", command: { type: "select-image", image } }); },
    selectLevel(level: number) { sendToEngine({ type: "engine.command", command: { type: "select-level", level } }); },
    choosePartial(generation: number, keepPartial: boolean) { sendToEngine({ type: "engine.command", command: { type: "recovery-choice", generation, choice: keepPartial ? "keep" : "discard" } }); },
    resolvePermission(granted: boolean) {
      const pending = [...waitingForPermission.entries()];
      waitingForPermission.clear();
      for (const [id, { effect, failure }] of pending) {
        if (cancelled) return;
        if (!granted) {
          sendToEngine({ type: "engine.failure", requestId: id, error: failure });
          continue;
        }
        settled.delete(id);
        void acquire(effect);
      }
    },
    cancel() {
      if (cancelled) return;
      log("debug", "controller-cancel", "");
      cancelled = true;
      deps.extensionTransport.cancel();
      sendToEngine({ type: "engine.command", command: { type: "cancel" } });
    },
    dispose() {
      if (disposed) return;
      log("debug", "controller-dispose", "");
      disposed = true;
      cancelled = true;
      deps.extensionTransport.cancel();
      deps.assembly?.release();
      sendToEngine({ type: "engine.dispose" });
    },
  };
}
