import { isJobError, originOfUrl } from "@dezoomify/browser-runtime";
import type { DiagnosticRecorder } from "@dezoomify/shared-ui";
import type { Interaction, ResourceRead, ResourceRequest } from "@dezoomify/wasm-bindings";
import type { createSourceAccess } from "./source-access.ts";

type SourceAccess = ReturnType<typeof createSourceAccess>;

/** Prefer the source tab's session when it is still bound; otherwise use the host transport. */
export function createResourceFetcher(deps: {
  diagnostics?: DiagnosticRecorder;
  sourceAccess: SourceAccess;
  extensionTransport: {
    fetchResource(
      request: ResourceRequest,
      signal: AbortSignal,
      interaction: Interaction,
    ): Promise<ResourceRead>;
  };
}) {
  return async (
    request: ResourceRequest,
    signal: AbortSignal,
    interaction: Interaction,
  ): Promise<ResourceRead> => {
    if (
      deps.sourceAccess.handlesResource(request.uri) ||
      request.purpose === "metadata" ||
      deps.sourceAccess.hasOrigin(originOfUrl(request.uri))
    ) {
      const result = await readSource(request, signal);
      if (result) return result;
    }
    return deps.extensionTransport.fetchResource(request, signal, interaction);
  };

  async function readSource(
    request: ResourceRequest,
    signal: AbortSignal,
  ): Promise<ResourceRead | undefined> {
    const started = performance.now();
    deps.diagnostics?.count("requests");
    deps.diagnostics?.count("requests_pending");
    try {
      const result = await deps.sourceAccess.fetch(request, signal);
      deps.diagnostics?.count("requests_completed");
      deps.diagnostics?.count("bytes_fetched", result.bytes.byteLength);
      deps.diagnostics?.record(request.purpose === "metadata" ? "debug" : "trace", "request", {
        purpose: request.purpose,
        transport: "source-document",
        url: request.uri,
        final_url: result.finalUri,
        http: result.http,
        content_type: result.contentType,
        bytes: result.bytes.byteLength,
        duration_ms: performance.now() - started,
      });
      return { kind: "response", response: { bytes: result.bytes, final_uri: result.finalUri } };
    } catch (error) {
      sourceFailed(error, request, signal, started);
    } finally {
      deps.diagnostics?.count("requests_pending", -1);
    }
    return undefined;
  }

  function sourceFailed(
    error: unknown,
    request: ResourceRequest,
    signal: AbortSignal,
    started: number,
  ): void {
    deps.diagnostics?.count(signal.aborted ? "requests_cancelled" : "request_failures");
    if (!signal.aborted)
      deps.diagnostics?.record("warn", "request-failed", {
        ...(isJobError(error) ? error : {}),
        purpose: request.purpose,
        transport: "source-document",
        url: request.uri,
        duration_ms: performance.now() - started,
      });
    if (
      signal.aborted ||
      deps.sourceAccess.handlesResource(request.uri) ||
      (isJobError(error) && (error.kind === "http-error" || error.kind === "timeout"))
    )
      throw error;
    deps.diagnostics?.record("warn", "source-fetch-fallback", {
      ...(isJobError(error) ? error : {}),
      purpose: request.purpose,
      transport: "source-document",
      url: request.uri,
      duration_ms: performance.now() - started,
      error,
    });
  }
}
