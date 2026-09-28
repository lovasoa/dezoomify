import type { DiagnosticRecorder } from "@dezoomify/app-model";
import { isFetchFailure, originOfUrl } from "@dezoomify/browser-runtime";
import type { ResourceRequest } from "@dezoomify/wasm-bindings";
import { asFetchFailure } from "../runtime/fetch.ts";
import type { createSourceAccess } from "./source-access.ts";

type SourceAccess = ReturnType<typeof createSourceAccess>;

/** Prefer the source tab's session when it is still bound; otherwise use the host transport. */
export function createEngineResourceFetcher(deps: {
  diagnostics?: DiagnosticRecorder;
  sourceAccess: SourceAccess;
  extensionTransport: {
    fetchResource(
      request: ResourceRequest,
      signal: AbortSignal,
    ): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  };
}) {
  return async (
    request: ResourceRequest,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array; finalUri?: string }> => {
    const sourceOrigin = deps.sourceAccess.origin;
    if (
      request.purpose === "metadata" ||
      (sourceOrigin !== "" && originOfUrl(request.uri) === sourceOrigin)
    ) {
      const started = performance.now();
      deps.diagnostics?.count("requests");
      try {
        const result = await deps.sourceAccess.fetch(request, signal);
        deps.diagnostics?.count("bytes_fetched", result.bytes.byteLength);
        deps.diagnostics?.record(request.purpose === "metadata" ? "debug" : "trace", "request", {
          request: request.id,
          purpose: request.purpose,
          transport: "source-document",
          url: request.uri,
          final_url: result.finalUri,
          http: result.http,
          content_type: result.contentType,
          bytes: result.bytes.byteLength,
          duration_ms: performance.now() - started,
        });
        return result;
      } catch (error) {
        if (!signal.aborted) deps.diagnostics?.count("request_failures");
        if (signal.aborted || (isFetchFailure(error) && error.http !== undefined)) throw error;
        deps.diagnostics?.record("warn", "source-fetch-fallback", {
          ...asFetchFailure(error),
          request: request.id,
          purpose: request.purpose,
          transport: "source-document",
          url: request.uri,
          duration_ms: performance.now() - started,
          error,
        });
      }
    }
    return deps.extensionTransport.fetchResource(request, signal);
  };
}
