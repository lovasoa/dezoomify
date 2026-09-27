import { originOfUrl } from "@dezoomify/browser-runtime";
import type { ResourceRequest } from "@dezoomify/wasm-bindings";
import { asFetchFailure } from "../runtime/fetch.ts";
import type { createSourceAccess } from "./source-access.ts";

type SourceAccess = ReturnType<typeof createSourceAccess>;

/** Prefer the source tab's session when it is still bound; otherwise use the host transport. */
export function createEngineResourceFetcher(deps: {
  sourceAccess: SourceAccess;
  extensionTransport: {
    fetchResource(
      request: ResourceRequest,
      signal: AbortSignal,
    ): Promise<{ bytes: Uint8Array; finalUri?: string }>;
  };
  onSourceFailure?(failure: ReturnType<typeof asFetchFailure>): void;
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
      try {
        return await deps.sourceAccess.fetch(request, signal);
      } catch (error) {
        if (
          signal.aborted ||
          (error &&
            typeof error === "object" &&
            "sourceDefinitive" in error &&
            error.sourceDefinitive === true)
        )
          throw error;
        deps.onSourceFailure?.(asFetchFailure(error));
      }
    }
    return deps.extensionTransport.fetchResource(request, signal);
  };
}
