import type { AcquireEffect } from "@dezoomify/browser-runtime";
import {
  decodeBase64Payload,
  isPublicHttpUrl,
  originOfUrl,
  SOURCE_FETCH_BYTE_LIMIT,
} from "@dezoomify/browser-runtime";
import type { JobBinding, RuntimeMessage, SourceFetchReply } from "../protocol.ts";
import { SOURCE_FETCH_BASE64_CHAR_LIMIT } from "../protocol.ts";
import { asFetchFailure } from "../runtime/fetch.ts";

interface SourceReply {
  bytes: Uint8Array;
}

export function isJobBinding(value: unknown): value is JobBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    "jobId" in value &&
    typeof value.jobId === "string" &&
    value.jobId.startsWith("job:") &&
    "tabId" in value &&
    typeof value.tabId === "number" &&
    Number.isSafeInteger(value.tabId) &&
    "frameId" in value &&
    typeof value.frameId === "number" &&
    Number.isSafeInteger(value.frameId) &&
    "documentGeneration" in value &&
    typeof value.documentGeneration === "number" &&
    Number.isSafeInteger(value.documentGeneration) &&
    value.documentGeneration >= 0
  );
}

/** Fetch in the bound source tab; runtime.sendMessage correlates its reply. */
export function createCoordinatorSourceTransport(deps: {
  sendMessage(message: RuntimeMessage): Promise<unknown>;
}) {
  return {
    async fetchResource(request: {
      binding: JobBinding;
      uri: string;
      method?: string;
      headers: unknown;
      purpose: string;
    }): Promise<SourceReply> {
      if (
        !isJobBinding(request.binding) ||
        request.uri.length > 2048 ||
        !isPublicHttpUrl(request.uri)
      ) {
        throw Object.assign(new Error("invalid source fetch binding"), { category: "malformed" });
      }
      const response = await deps.sendMessage({
        type: "dz.job.fetch",
        ...request.binding,
        url: request.uri,
        method: request.method,
        headers: request.headers,
        purpose: request.purpose,
      });
      if (!isSourceFetchReply(response)) {
        throw Object.assign(new Error("malformed source response"), { category: "malformed" });
      }
      if (!response.ok) {
        throw Object.assign(new Error(`source request failed with HTTP ${response.status ?? 0}`), {
          category: "network",
          sourceDefinitive: response.code === "http-error",
        });
      }
      if (response.data.length > SOURCE_FETCH_BASE64_CHAR_LIMIT) {
        throw Object.assign(new Error("malformed source payload"), { category: "malformed" });
      }
      const bytes = decodeBase64Payload(response.data, SOURCE_FETCH_BYTE_LIMIT);
      if (!bytes) {
        throw Object.assign(new Error("malformed source payload"), { category: "malformed" });
      }
      if (
        !Number.isSafeInteger(response.bytes) ||
        response.bytes !== bytes.byteLength ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status >= 300 ||
        !isPublicHttpUrl(response.url)
      ) {
        throw Object.assign(new Error("malformed source payload"), { category: "malformed" });
      }
      return { bytes };
    },
  };
}

function isSourceFetchReply(value: unknown): value is SourceFetchReply {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok === false)
    return (
      "code" in value &&
      typeof value.code === "string" &&
      (!("status" in value && value.status !== undefined) || Number.isInteger(value.status))
    );
  return (
    value.ok === true &&
    "data" in value &&
    typeof value.data === "string" &&
    "bytes" in value &&
    typeof value.bytes === "number" &&
    "status" in value &&
    typeof value.status === "number" &&
    "url" in value &&
    typeof value.url === "string"
  );
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
  extensionTransport: {
    fetchResource(url: string, opts?: unknown): Promise<{ bytes: Uint8Array }>;
  };
  cancelled(): boolean;
  onSourceFailure?(cause: { code?: unknown; blocked_reason?: unknown }): void;
}): (effect: Pick<AcquireEffect, "request">) => Promise<{ bytes: Uint8Array }> {
  return async (effect: Pick<AcquireEffect, "request">): Promise<{ bytes: Uint8Array }> => {
    const request = effect.request;
    const site = deps.siteOrigin();
    if (request.purpose === "metadata" || (site !== "" && originOfUrl(request.uri) === site)) {
      try {
        const result = await deps.sourceTransport.fetchResource({
          binding: deps.binding(),
          uri: request.uri,
          headers: request.headers,
          purpose: request.purpose,
        });
        return { bytes: result.bytes };
      } catch (sourceError) {
        if (
          sourceError &&
          typeof sourceError === "object" &&
          (sourceError as { sourceDefinitive?: unknown }).sourceDefinitive === true
        )
          throw sourceError;
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
