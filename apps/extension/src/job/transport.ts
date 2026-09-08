import { asFetchFailure } from "../runtime/fetch.js";

/** @typedef {{ jobId: string, tabId: number, frameId: number, documentGeneration: number }} JobBinding */

/** @param {unknown} value @returns {value is JobBinding} */
export function isJobBinding(value) {
  const binding = /** @type {Partial<JobBinding>} */ (value);
  return !!binding && typeof binding.jobId === "string" && binding.jobId.startsWith("job:") &&
    Number.isInteger(binding.tabId) && Number.isInteger(binding.frameId) &&
    Number.isInteger(binding.documentGeneration) && binding.documentGeneration >= 0;
}

/** @param {unknown} value */
function responseBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return new Uint8Array(value);
  return null;
}

/**
 * Route a source-bound request through the browser-owned coordinator. The
 * requestId is mandatory: it binds a future chunk sequence to one WASM
 * effect, not merely to the current job tab.
 *
 * The coordinator is responsible for the protocol ByteChunkDto/ack sequence.
 * This small bridge accepts its final assembled reply for now, preserving the
 * request correlation until the generated chunk bindings land.
 */
export function createCoordinatorSourceTransport(deps) {
  const pending = new Map();
  return {
    /** @param {{ binding: JobBinding, requestId: string, uri: string, headers: unknown, purpose: string }} request */
    async fetchResource(request) {
      if (!isJobBinding(request.binding) || typeof request.requestId !== "string" || !request.requestId.startsWith("req:")) {
        throw Object.assign(new Error("invalid source fetch binding"), { category: "malformed" });
      }
      await deps.sendMessage({
        type: "dz.job.fetch",
        ...request.binding,
        requestId: request.requestId,
        url: request.uri,
        headers: request.headers,
        purpose: request.purpose,
      });
      return await new Promise((resolve, reject) => pending.set(request.requestId, { resolve, reject, chunks: [], finalUrl: request.uri }));
    },
    /** Receive a coordinator-routed `dz.source.fetch-*` message. */
    handleMessage(message) {
      const state = pending.get(message?.requestId);
      if (!state) return false;
      if (message.sourceType === "dz.source.fetch-chunk") {
        const bytes = responseBytes(message.bytes);
        if (!bytes) { pending.delete(message.requestId); state.reject(Object.assign(new Error("malformed source chunk"), { category: "malformed" })); return true; }
        state.chunks.push(bytes);
        return true;
      }
      if (message.sourceType === "dz.source.fetch-complete") {
        pending.delete(message.requestId);
        if (!message.ok) { state.reject(Object.assign(new Error(`source request failed with HTTP ${message.status ?? 0}`), { category: "network" })); return true; }
        const length = state.chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(length);
        let offset = 0;
        for (const chunk of state.chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        state.resolve({ bytes, finalUrl: typeof message.url === "string" ? message.url : state.finalUrl });
        return true;
      }
      return false;
    },
  };
}

/** @param {unknown} error */
export function engineFailure(error) {
  return asFetchFailure(error);
}
