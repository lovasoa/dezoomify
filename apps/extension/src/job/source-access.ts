import {
  decodeBase64Payload,
  isFetchFailure,
  isPublicHttpUrl,
  originOfUrl,
  SOURCE_FETCH_BYTE_LIMIT,
  validateEngineHeaders,
} from "@dezoomify/browser-runtime";
import type { FetchFailure, ResourceRequest } from "@dezoomify/wasm-bindings";
import type { WxtBrowser } from "wxt/browser";
import { cancelSourceFetch, collectCandidates, fetchSource } from "./source-operations.ts";

type SourceApi = Pick<WxtBrowser, "tabs" | "scripting">;
type CandidateSnapshot = Awaited<ReturnType<typeof collectCandidates>>;
type CandidateInput = CandidateSnapshot["inputs"][number];
type SourceRequest = Parameters<typeof fetchSource>[0];
type FetchResult = Awaited<ReturnType<typeof fetchSource>>;

const MAX_URL_LENGTH = 2048;
const MAX_CANDIDATES = 100;
const MAX_DOM_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil((SOURCE_FETCH_BYTE_LIMIT + 2) / 3) * 4;

export type SourceAccessErrorCode =
  | "source-document-lost"
  | "cancelled"
  | "malformed"
  | "network"
  | "http-error"
  | "limit-exceeded";

export type SourceAccessError = Error & {
  code: SourceAccessErrorCode;
  category: SourceAccessErrorCode;
  status?: number;
  sourceDefinitive?: boolean;
};

function failure(
  code: SourceAccessErrorCode,
  message: string,
  extra: Partial<Pick<SourceAccessError, "status" | "sourceDefinitive">> = {},
): SourceAccessError {
  return Object.assign(new Error(message), { code, category: code, ...extra });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function sameDocumentUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = "";
    right.hash = "";
    return left.href === right.href;
  } catch {
    return a === b;
  }
}

function validCandidate(value: unknown): value is CandidateInput {
  if (!isRecord(value) || typeof value.url !== "string") return false;
  if (value.url.length > MAX_URL_LENGTH || !isPublicHttpUrl(value.url)) return false;
  if (value.contents === undefined) return true;
  if (typeof value.contents !== "string") return false;
  return new TextEncoder().encode(value.contents).byteLength <= MAX_DOM_BYTES;
}

function validSnapshot(value: unknown, expectedUrl: string): value is CandidateSnapshot {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.documentUrl === "string" &&
    isPublicHttpUrl(value.documentUrl) &&
    sameDocumentUrl(value.documentUrl, expectedUrl) &&
    typeof value.overflow === "number" &&
    Number.isSafeInteger(value.overflow) &&
    value.overflow >= 0 &&
    Array.isArray(value.inputs) &&
    value.inputs.length <= MAX_CANDIDATES &&
    value.inputs.every(validCandidate)
  );
}

function validFetchResult(value: unknown, expectedUrl: string): value is FetchResult {
  if (!isRecord(value) || typeof value.documentUrl !== "string") return false;
  if (!sameDocumentUrl(value.documentUrl, expectedUrl)) return false;
  if (value.ok === false) return isFetchFailure(value.error);
  return (
    value.ok === true &&
    (value.contentType === undefined ||
      (typeof value.contentType === "string" && value.contentType.length <= 256)) &&
    typeof value.data === "string" &&
    value.data.length <= MAX_BASE64_CHARS &&
    typeof value.bytes === "number" &&
    Number.isSafeInteger(value.bytes) &&
    value.bytes >= 0 &&
    value.bytes <= SOURCE_FETCH_BYTE_LIMIT &&
    typeof value.status === "number" &&
    Number.isInteger(value.status) &&
    value.status >= 200 &&
    value.status < 300 &&
    typeof value.url === "string" &&
    value.url.length <= MAX_URL_LENGTH &&
    isPublicHttpUrl(value.url)
  );
}

/**
 * Direct, finite access to one source document from the privileged job page.
 * Navigation permanently invalidates this object; retries create a new scan
 * only while the same source document is still current.
 */
export function createSourceAccess(
  browserApi: SourceApi,
  reference: { tabId: number; documentUrl: string },
  options: { timeoutMs?: number } = {},
) {
  if (!Number.isSafeInteger(reference.tabId) || reference.tabId < 0)
    throw failure("malformed", "invalid source tab id");
  if (!isPublicHttpUrl(reference.documentUrl) || reference.documentUrl.length > MAX_URL_LENGTH)
    throw failure("malformed", "invalid source document URL");

  const { tabId, documentUrl } = reference;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const lifetime = new AbortController();
  let invalidated = false;
  const onUpdated = (updatedTabId: number, changeInfo: { status?: string; url?: string }) => {
    if (updatedTabId !== tabId) return;
    if (changeInfo.status === "loading") {
      invalidate();
      return;
    }
    if (typeof changeInfo.url === "string" && !sameDocumentUrl(changeInfo.url, documentUrl))
      invalidate();
  };
  const onRemoved = (removedTabId: number) => {
    if (removedTabId === tabId) invalidate();
  };
  function invalidate() {
    if (invalidated) return;
    invalidated = true;
    lifetime.abort(failure("source-document-lost", "source document changed"));
  }
  browserApi.tabs.onUpdated.addListener(onUpdated);
  browserApi.tabs.onRemoved.addListener(onRemoved);

  function assertLive() {
    if (invalidated) throw failure("source-document-lost", "source document changed");
  }

  async function injectUnchecked<Args extends unknown[], Result>(
    func: (...args: Args) => Result,
    args: Args,
    signal: AbortSignal,
  ): Promise<Awaited<Result>> {
    assertLive();
    signal.throwIfAborted();
    const tab = await browserApi.tabs.get(tabId).catch(() => null);
    signal.throwIfAborted();
    if (!tab) {
      invalidate();
      throw failure("source-document-lost", "source tab is unavailable");
    }
    if (!tab.url || !sameDocumentUrl(tab.url, documentUrl)) {
      invalidate();
      throw failure("source-document-lost", "source document changed");
    }
    assertLive();
    const results = await browserApi.scripting
      .executeScript<Args, Result>({
        target: { tabId, frameIds: [0] },
        func,
        args,
      })
      .catch((cause: unknown) => {
        assertLive();
        throw Object.assign(
          failure("network", "source operation could not run", { sourceDefinitive: false }),
          { cause },
        );
      });
    signal.throwIfAborted();
    assertLive();
    if (!Array.isArray(results) || results.length !== 1 || results[0]?.frameId !== 0)
      throw failure("malformed", "source operation returned an invalid result");
    const tabAfter = await browserApi.tabs.get(tabId).catch(() => null);
    if (!tabAfter?.url || !sameDocumentUrl(tabAfter.url, documentUrl)) {
      invalidate();
      throw failure("source-document-lost", "source document changed");
    }
    assertLive();
    const result = results[0].result;
    const resultDocumentUrl =
      isRecord(result) && typeof result.documentUrl === "string" ? result.documentUrl : null;
    if (!resultDocumentUrl || !sameDocumentUrl(resultDocumentUrl, documentUrl)) {
      invalidate();
      throw failure("source-document-lost", "source result belongs to another document");
    }
    return result as Awaited<Result>;
  }

  /** Bound the whole browser operation, including a lost executeScript reply. */
  async function inject<Args extends unknown[], Result>(
    func: (...args: Args) => Result,
    args: Args,
    signal?: AbortSignal,
    onAbort?: () => void,
  ): Promise<Awaited<Result>> {
    assertLive();
    const deadline = new AbortController();
    const timeout: FetchFailure = {
      code: "TRANSPORT_TIMEOUT",
      message: "The source operation timed out.",
      retryable: true,
      recovery: [],
      transport: "browser-session",
    };
    const timer = setTimeout(() => deadline.abort(timeout), timeoutMs);
    const combined = AbortSignal.any([
      lifetime.signal,
      deadline.signal,
      ...(signal ? [signal] : []),
    ]);
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    const abort = () => {
      onAbort?.();
      rejectAbort(
        signal?.aborted ? failure("cancelled", "source fetch cancelled") : combined.reason,
      );
    };
    combined.addEventListener("abort", abort, { once: true });
    try {
      if (combined.aborted) {
        abort();
        return await aborted;
      }
      return await Promise.race([injectUnchecked(func, args, combined), aborted]);
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
    }
  }

  async function scan(): Promise<CandidateSnapshot> {
    const snapshot = await inject(collectCandidates, []);
    if (!validSnapshot(snapshot, documentUrl))
      throw failure("malformed", "invalid source scan result");
    assertLive();
    return snapshot;
  }

  async function fetch(request: Pick<ResourceRequest, "uri" | "headers">, signal: AbortSignal) {
    assertLive();
    if (signal.aborted) throw failure("cancelled", "source fetch cancelled");
    if (
      typeof request.uri !== "string" ||
      request.uri.length > MAX_URL_LENGTH ||
      !isPublicHttpUrl(request.uri)
    )
      throw failure("malformed", "invalid source request URL");
    const headers = validateEngineHeaders(request.headers ?? []);
    if (!headers) throw failure("malformed", "invalid source request headers");

    const operationId = crypto.randomUUID();
    const sourceRequest: SourceRequest = {
      url: request.uri,
      method: "GET",
      headers,
      operationId,
      timeoutMs,
    };
    const cancel = () => {
      void browserApi.scripting
        .executeScript({
          target: { tabId, frameIds: [0] },
          func: cancelSourceFetch,
          args: [operationId],
        })
        .catch(() => undefined);
    };
    const result = await inject(fetchSource, [sourceRequest], signal, cancel);
    if (signal.aborted) throw failure("cancelled", "source fetch cancelled");
    assertLive();
    if (!validFetchResult(result, documentUrl))
      throw failure("malformed", "invalid source fetch result");
    if (result.ok === false) throw result.error;
    const bytes = decodeBase64Payload(result.data, SOURCE_FETCH_BYTE_LIMIT);
    if (!bytes || bytes.byteLength !== result.bytes)
      throw failure("malformed", "invalid source payload");
    return { bytes, finalUri: result.url, http: result.status, contentType: result.contentType };
  }

  function dispose() {
    invalidate();
    browserApi.tabs.onUpdated.removeListener(onUpdated);
    browserApi.tabs.onRemoved.removeListener(onRemoved);
  }

  return {
    scan,
    fetch,
    dispose,
    get documentUrl() {
      return documentUrl;
    },
    get origin() {
      return originOfUrl(documentUrl);
    },
  };
}
