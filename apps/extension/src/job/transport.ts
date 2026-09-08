import { asFetchFailure } from "../runtime/fetch.js";

/** @typedef {{ jobId: string, tabId: number, frameId: number, documentGeneration: number }} JobBinding */

/** @param {unknown} value @returns {value is JobBinding} */
export interface JobBinding { jobId: string; tabId: number; frameId: number; documentGeneration: number }
interface SourceReply { bytes: Uint8Array; finalUrl: string }
interface PendingSource { resolve(value: SourceReply): void; reject(reason: unknown): void; chunks: Uint8Array[]; finalUrl: string }

export function isJobBinding(value: unknown): value is JobBinding {
  const binding = value as Partial<JobBinding> | null;
  return !!binding && typeof binding.jobId === "string" && binding.jobId.startsWith("job:") &&
    Number.isInteger(binding.tabId) && Number.isInteger(binding.frameId) &&
    typeof binding.documentGeneration === "number" && Number.isInteger(binding.documentGeneration) && binding.documentGeneration >= 0;
}

/** @param {unknown} value */
function responseBytes(value: unknown): Uint8Array | null {
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
export function createCoordinatorSourceTransport(deps: { sendMessage(message: unknown): Promise<unknown> }) {
  const pending = new Map<string, PendingSource>();
  return {
    /** @param {{ binding: JobBinding, requestId: string, uri: string, method?: string, headers: unknown, purpose: string }} request */
    async fetchResource(request: { binding: JobBinding; requestId: string; uri: string; method?: string; headers: unknown; purpose: string }): Promise<SourceReply> {
      if (!isJobBinding(request.binding) || typeof request.requestId !== "string" || !request.requestId.startsWith("req:")) {
        throw Object.assign(new Error("invalid source fetch binding"), { category: "malformed" });
      }
      await deps.sendMessage({
        type: "dz.job.fetch",
        ...request.binding,
        requestId: request.requestId,
        url: request.uri,
        method: request.method,
        headers: request.headers,
        purpose: request.purpose,
      });
      return await new Promise<SourceReply>((resolve, reject) => pending.set(request.requestId, { resolve, reject, chunks: [], finalUrl: request.uri }));
    },
    /** Receive a coordinator-routed `dz.source.fetch-*` message. */
    handleMessage(message: { requestId?: string; sourceType?: string; bytes?: unknown; ok?: boolean; status?: number; url?: string }): boolean {
      if (typeof message?.requestId !== "string") return false;
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
export function engineFailure(error: unknown) {
  return asFetchFailure(error);
}
