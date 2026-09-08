import { engineFailure } from "./transport.js";

/**
 * Effect host for one WASM session. It never performs discovery/selection or
 * retries itself: it answers the engine's correlated effects and forwards
 * engine events to the job-tab UI.
 */
export function createJobController(deps) {
  let cancelled = false;
  /** @type {Set<string>} */
  const settled = new Set();

  function sendToEngine(message) { deps.worker.postMessage(message); }

  async function acquire(effect) {
    const request = effect.request;
    if (!request || typeof request.id !== "string" || settled.has(request.id)) return;
    settled.add(request.id);
    const useSource = request.purpose === "metadata" || request.purpose === "probe";
    try {
      const result = useSource
        ? await deps.sourceTransport.fetchResource({ binding: deps.binding(), requestId: request.id, uri: request.uri, headers: request.headers, purpose: request.purpose })
        : await deps.extensionTransport.fetchResource(request.uri, { requestId: request.id, purpose: request.purpose, headers: request.headers, userIntent: true, cancelled: () => cancelled });
      if (!cancelled) sendToEngine({ type: "engine.bytes", jobId: effect.job, requestId: request.id, bytes: result.bytes });
    } catch (error) {
      const failure = engineFailure(error);
      if (failure.blocked_reason === "access-required") {
        deps.onPermissionRequired({ hosts: error?.hosts ?? [], requestId: request.id, jobId: effect.job });
      }
      if (!cancelled) sendToEngine({ type: "engine.failure", jobId: effect.job, requestId: request.id, error: failure });
    }
  }

  /** @param {any[]} messages */
  function handleEngineMessages(messages) {
    for (const envelope of messages) {
      if (envelope?.kind === "effect") {
        if (envelope.type === "acquire-resource" || envelope.type === "acquire-tile") void acquire(envelope);
        else if (envelope.type === "cancel-work") deps.extensionTransport.cancel();
        else deps.onUnsupportedEffect(envelope);
      } else if (envelope?.kind === "event") deps.onEvent(envelope);
    }
  }

  return {
    handleEngineMessages,
    start(inputUrl) { sendToEngine({ type: "engine.start", jobId: deps.binding().jobId, inputUrl }); },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      deps.extensionTransport.cancel();
      sendToEngine({ type: "engine.command", command: { type: "cancel", job: deps.binding().jobId } });
    },
    dispose() { cancelled = true; deps.extensionTransport.cancel(); sendToEngine({ type: "engine.dispose" }); },
  };
}
