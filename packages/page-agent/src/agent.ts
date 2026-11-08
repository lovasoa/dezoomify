/** The service a host installs into one inspected document.
 *
 * A host injects `installPageAgent` once per document and then drives every
 * operation through `callPageAgent`, which is self-contained so a host can
 * serialize it into the page. That agent and the viewer handle registry in
 * `viewers/session.ts` are the only page globals this package adds; see
 * `messages.ts` for the contract they speak.
 *
 * Installing replaces the agent but not its state: viewer handles registered by
 * an earlier injection stay valid until their host retires them. */

import { errorPayload, InternalError, isJobError, unknownDetail } from "@dezoomify/browser-runtime";
import { findImageDownloadLink, findLoadedImage } from "./loaded-image.ts";
import type { PageAgent, PageRequest, PageResponse, ScanResult } from "./messages.ts";
import { ScanState } from "./viewers/scan-state.ts";
import { readViewerTile, releaseViewerTiles } from "./viewers/session.ts";
import { PageTraversal } from "./viewers/traversal.ts";

/** Install this document's page agent and report the document it runs in.
 *
 * Replaces the agent a previous injection left behind; viewer handles stay
 * valid because their registry is separate and outlives the agent. The returned
 * document URL answers the same check every page operation answers, so a host
 * learns immediately that it injected into a document it did not expect. */
export function installPageAgent(): { documentUrl: string } {
  const globals = globalThis as { __dezoomify_page_agent__?: PageAgent };
  globals.__dezoomify_page_agent__ = { handle };
  return { documentUrl: location.href };
}

/** Dispatch one request into the installed agent.
 *
 * A host passes this function to `scripting.executeScript`, so the body must
 * stay self-contained: the agent's global name is spelled out here as well as
 * at install rather than read from module scope. A document whose agent is gone
 * reports the source as lost instead of throwing, because an exception crossing
 * a host boundary loses the structured `Error` facts. */
export function callPageAgent(request: PageRequest): Promise<PageResponse> | PageResponse {
  const agent = (globalThis as { __dezoomify_page_agent__?: PageAgent }).__dezoomify_page_agent__;
  return agent
    ? agent.handle(request)
    : {
        method: request.method,
        documentUrl: location.href,
        ok: false,
        error: {
          kind: "policy-denied",
          blocked_reason: "source-document-lost",
          transport: "browser-session",
        },
      };
}

async function handle(request: PageRequest): Promise<PageResponse> {
  const documentUrl = location.href;
  try {
    switch (request.method) {
      case "scan":
        return { method: "scan", documentUrl, ok: true, result: await scan() };
      case "read-tile":
        return {
          method: "read-tile",
          documentUrl,
          ok: true,
          result: await readViewerTile(request.request, request.extent),
        };
      case "release-tiles":
        releaseViewerTiles(request.handles);
        return { method: "release-tiles", documentUrl, ok: true, result: undefined };
      case "find-loaded-image":
        return {
          method: "find-loaded-image",
          documentUrl,
          ok: true,
          result: findLoadedImage(request.images),
        };
      case "find-image-link":
        return {
          method: "find-image-link",
          documentUrl,
          ok: true,
          result: findImageDownloadLink(),
        };
    }
  } catch (cause) {
    return {
      method: request.method,
      documentUrl,
      ok: false,
      error: errorPayload(
        isJobError(cause)
          ? cause
          : new InternalError(
              `Unexpected exception while ${request.method}: ${unknownDetail(cause)}`,
              { cause },
            ),
      ),
    };
  }
}

/** One finite traversal. Work limits bound it independently of scheduling, so a
 * truncated scan still reports everything it found before stopping. */
async function scan(): Promise<ScanResult> {
  const state = new ScanState(location.href);
  try {
    await new PageTraversal(state).scan(window);
  } catch {
    state.diagnostics.rejected++;
  }
  return state.result();
}
