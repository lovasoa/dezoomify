import { asFetchFailure, originOf } from "../runtime/fetch.ts";
import type { AcquireEffect } from "@dezoomify/browser-runtime";

/** @typedef {{ jobId: string, tabId: number, frameId: number, documentGeneration: number }} JobBinding */

/** @param {unknown} value @returns {value is JobBinding} */
export interface JobBinding { jobId: string; tabId: number; frameId: number; documentGeneration: number }
interface SourceReply { bytes: Uint8Array }
interface PendingSource { resolve(value: SourceReply): void; reject(reason: unknown): void }

export function isJobBinding(value: unknown): value is JobBinding {
  const binding = value as Partial<JobBinding> | null;
  return !!binding && typeof binding.jobId === "string" && binding.jobId.startsWith("job:") &&
    Number.isInteger(binding.tabId) && Number.isInteger(binding.frameId) &&
    typeof binding.documentGeneration === "number" && Number.isInteger(binding.documentGeneration) && binding.documentGeneration >= 0;
}

/**
 * Decode one base64 source payload. The coordinator already validated the
 * length and byte count; this is a shape guard so a malformed bridge message
 * fails typed instead of crashing the fetch.
 * @param {unknown} value
 */
function decodeSourceData(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch { return null; }
}

/**
 * Route a source-bound request through the browser-owned coordinator. The
 * engine's numeric request sequence is mandatory: it binds one reply to one
 * WASM effect, not merely to the current job tab. The coordinator bus speaks
 * its own `req:*` string tokens, so this adapter names the sequence once on
 * the way out and matches the echoed token back to the pending engine
 * request. The reply carries one base64 payload; the coordinator owns the
 * request lifecycle.
 */
export function createCoordinatorSourceTransport(deps: { sendMessage(message: unknown): Promise<unknown> }) {
  const pending = new Map<string, PendingSource>();
  return {
    /** @param {{ binding: JobBinding, requestId: number, uri: string, method?: string, headers: unknown, purpose: string }} request */
    async fetchResource(request: { binding: JobBinding; requestId: number; uri: string; method?: string; headers: unknown; purpose: string }): Promise<SourceReply> {
      if (!isJobBinding(request.binding) || !Number.isSafeInteger(request.requestId) || request.requestId < 0) {
        throw Object.assign(new Error("invalid source fetch binding"), { category: "malformed" });
      }
      const token = `req:${request.requestId}`;
      await deps.sendMessage({
        type: "dz.job.fetch",
        ...request.binding,
        requestId: token,
        url: request.uri,
        method: request.method,
        headers: request.headers,
        purpose: request.purpose,
      });
      return await new Promise<SourceReply>((resolve, reject) => pending.set(token, { resolve, reject }));
    },
    /** Receive a coordinator-routed `dz.source.fetch-complete` message. */
    handleMessage(message: { requestId?: string; sourceType?: string; ok?: boolean; code?: string; status?: number; data?: unknown }): boolean {
      if (typeof message?.requestId !== "string") return false;
      const state = pending.get(message?.requestId);
      if (!state || message.sourceType !== "dz.source.fetch-complete") return false;
      pending.delete(message.requestId);
      if (!message.ok) {
        state.reject(Object.assign(new Error(`source request failed with HTTP ${message.status ?? 0}`), {
          category: "network",
          sourceDefinitive: message.code === "http-error",
        }));
        return true;
      }
      const bytes = decodeSourceData(message.data);
      if (!bytes) {
        state.reject(Object.assign(new Error("malformed source payload"), { category: "malformed" }));
        return true;
      }
      state.resolve({ bytes });
      return true;
    },
  };
}

/** @param {unknown} error */
export function engineFailure(error: unknown) {
  return asFetchFailure(error);
}

/** @param {unknown} uri */
function requestOrigin(uri: unknown): string {
  try { return typeof uri === "string" ? originOf(uri) : ""; } catch { return ""; }
}

/**
 * Route one engine effect fetch for the extension. Metadata and requests for
 * the bound source document's own origin prefer the monitored tab's origin
 * context (which carries the page's Referer and same-origin session) and
 * fall back to the granted extension-origin session. Cross-origin tiles
 * always use the extension origin. A source-context failure must not fail
 * the job while the extension-origin transport can still answer it.
 */
export function createEngineResourceFetcher(deps: {
  binding(): JobBinding;
  siteOrigin(): string;
  sourceTransport: { fetchResource(request: unknown): Promise<{ bytes: Uint8Array }> };
  extensionTransport: { fetchResource(url: string, opts?: unknown): Promise<{ bytes: Uint8Array }> };
  cancelled(): boolean;
  onSourceFailure?(cause: { code?: unknown; blocked_reason?: unknown }): void;
}): (effect: Pick<AcquireEffect, "request">) => Promise<{ bytes: Uint8Array }> {
  return async (effect: Pick<AcquireEffect, "request">): Promise<{ bytes: Uint8Array }> => {
    const request = effect.request;
    const site = deps.siteOrigin();
    if (request.purpose === "metadata" || (site !== "" && requestOrigin(request.uri) === site)) {
      try {
        const result = await deps.sourceTransport.fetchResource({
          binding: deps.binding(),
          requestId: request.id,
          uri: request.uri,
          headers: request.headers,
          purpose: request.purpose,
        });
        return { bytes: result.bytes };
      } catch (sourceError) {
        if (sourceError && typeof sourceError === "object" && (sourceError as { sourceDefinitive?: unknown }).sourceDefinitive === true) throw sourceError;
        deps.onSourceFailure?.(asFetchFailure(sourceError));
      }
    }
    return deps.extensionTransport.fetchResource(request.uri, {
      requestId: request.id,
      purpose: request.purpose,
      headers: request.headers,
      userIntent: true,
      cancelled: deps.cancelled,
    });
  };
}
