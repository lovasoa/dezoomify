import type { AcquireEffect } from "@dezoomify/browser-runtime";
import { originOfUrl } from "@dezoomify/browser-runtime";
import type { createExtensionFetcher } from "../runtime/fetch.ts";
import { asFetchFailure } from "../runtime/fetch.ts";
import type { createSourceAccess } from "./source-access.ts";

type SourceAccess = ReturnType<typeof createSourceAccess>;
type Fetcher = ReturnType<typeof createExtensionFetcher>;
type EngineRequest = AcquireEffect["request"];
type EngineFetchOptions = Parameters<Fetcher["fetchResource"]>[1];

/** Prefer the source tab's session when it is still bound; otherwise use the host transport. */
export function createEngineResourceFetcher(deps: {
  sourceAccess: SourceAccess;
  extensionTransport: {
    fetchResource(url: string, options?: EngineFetchOptions): Promise<{ bytes: Uint8Array }>;
  };
  onSourceFailure?(failure: ReturnType<typeof asFetchFailure>): void;
}) {
  return async (
    effect: Pick<AcquireEffect, "request">,
    signal: AbortSignal,
  ): Promise<{ bytes: Uint8Array }> => {
    const request: EngineRequest = effect.request;
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
    return deps.extensionTransport.fetchResource(request.uri, {
      requestId: request.id,
      purpose: request.purpose,
      headers: request.headers,
      userIntent: true,
      cancelled: () => signal.aborted,
    });
  };
}
