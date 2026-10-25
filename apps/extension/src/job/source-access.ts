import {
  decodeBase64Payload,
  isJobError,
  isPublicHttpUrl,
  originOfUrl,
  requestedByteRange,
  SOURCE_FETCH_BYTE_LIMIT,
  validateByteRangeLength,
  validateByteRangeResponse,
  validateRequestHeaders,
} from "@dezoomify/browser-runtime";
import type { Interaction, Error as JobError, ResourceRequest } from "@dezoomify/wasm-bindings";
import type { PublicPath, WxtBrowser } from "wxt/browser";
import { transportError } from "../runtime/fetch.ts";
import { findImageDownloadLink, findLoadedImage } from "./loaded-image.ts";
import {
  cancelSourceFetch,
  collectCandidates,
  fetchSource,
  inspectSourceDocument,
} from "./source-operations.ts";
import {
  isViewerTile,
  readViewerTile,
  releaseViewerTiles,
  tileResourceBase,
} from "./viewers/session.ts";

type SourceApi = Pick<WxtBrowser, "tabs" | "scripting">;
type SourceFrame = { frameId: number; documentUrl: string; token?: string; documentId?: string };
type CandidateSnapshot = Awaited<ReturnType<typeof collectCandidates>> & {
  memory?: Record<string, number | boolean | string | string[]>;
};
type CandidateInput = CandidateSnapshot["inputs"][number];
type SourceRequest = Parameters<typeof fetchSource>[0];
type InspectionReply = {
  frameId: number;
  documentId?: string;
  result?: ReturnType<typeof inspectSourceDocument>;
};
type FetchResult = Awaited<ReturnType<typeof fetchSource>>;
type SourceScript<Args extends unknown[], Result> =
  | {
      func: (...args: Args) => Result;
      args: Args | ((token: string) => Args);
      world?: "ISOLATED" | "MAIN";
    }
  | { files: Extract<PublicPath, `${string}.js`>[]; world: "MAIN" };

const MAX_URL_LENGTH = 2048;
const MAX_CANDIDATES = 100;
const MAX_DOM_BYTES = 8 * 1024 * 1024;
const MAX_BASE64_CHARS = Math.ceil((SOURCE_FETCH_BYTE_LIMIT + 2) / 3) * 4;

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
  if (
    value.kind !== undefined &&
    value.kind !== "source" &&
    value.kind !== "observed-document" &&
    value.kind !== "observed-resource" &&
    value.kind !== "observed-metadata"
  )
    return false;
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

function validImage(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) &&
      typeof value.url === "string" &&
      ((value.url.length <= MAX_URL_LENGTH && isPublicHttpUrl(value.url)) ||
        (value.url.length <= MAX_DOM_BYTES && /^data:image\/[^;,]+;base64,/.test(value.url))) &&
      typeof value.width === "number" &&
      Number.isSafeInteger(value.width) &&
      value.width > 0 &&
      typeof value.height === "number" &&
      Number.isSafeInteger(value.height) &&
      value.height > 0)
  );
}

function validFetchResult(value: unknown, expectedUrl: string): value is FetchResult {
  if (!isRecord(value) || typeof value.documentUrl !== "string") return false;
  if (!sameDocumentUrl(value.documentUrl, expectedUrl)) return false;
  if (value.ok === false) return isJobError(value.error);
  return (
    value.ok === true &&
    (value.contentType === undefined ||
      (typeof value.contentType === "string" && value.contentType.length <= 256)) &&
    (value.contentRange === undefined ||
      (typeof value.contentRange === "string" && value.contentRange.length <= 256)) &&
    (value.contentLength === undefined ||
      (typeof value.contentLength === "string" && value.contentLength.length <= 256)) &&
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

function readSourcePayload(
  result: unknown,
  expectedUrl: string,
  range: ReturnType<typeof requestedByteRange>,
) {
  if (!validFetchResult(result, expectedUrl))
    throw transportError("bad-url", "invalid source fetch result");
  if (!result.ok) throw result.error;
  if (range) {
    validateByteRangeResponse(range, result.status, result.contentRange, result.contentLength);
    validateByteRangeLength(range, result.bytes);
  }
  const bytes = decodeBase64Payload(result.data, SOURCE_FETCH_BYTE_LIMIT);
  if (!bytes || bytes.byteLength !== result.bytes)
    throw transportError("bad-url", "invalid source payload");
  return { bytes, finalUri: result.url, http: result.status, contentType: result.contentType };
}

function observedMetadata(inputs: unknown[]): CandidateInput[] {
  let bytes = 0;
  const observed: CandidateInput[] = [];
  for (const input of inputs) {
    if (!validCandidate(input)) continue;
    if (input.kind !== "observed-metadata" || typeof input.contents !== "string") continue;
    const candidate: CandidateInput = {
      url: input.url,
      kind: "observed-metadata",
      contents: input.contents,
    };
    bytes += new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
    if (bytes <= 1024 * 1024) observed.push(candidate);
  }
  return observed;
}

function validMemoryValue(value: unknown): value is number | boolean | string | string[] {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 1024;
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((item) => typeof item === "string" && item.length <= 2048)
  );
}

function memoryDiagnostics(value: unknown): CandidateSnapshot["memory"] {
  if (!isRecord(value)) return undefined;
  const memory: NonNullable<CandidateSnapshot["memory"]> = {};
  for (const key of [
    "documents",
    "nodes",
    "references",
    "viewers",
    "probes",
    "rejected",
    "bytes",
    "truncated",
    "elapsedMs",
    "versions",
    "stopped",
    "frames",
  ]) {
    const field = value[key];
    if (validMemoryValue(field)) memory[key] = field;
  }
  return memory;
}

function memoryScanReply(reply: unknown): {
  observed: CandidateInput[];
  memory?: CandidateSnapshot["memory"];
} {
  if (!isRecord(reply) || !Array.isArray(reply.inputs) || reply.inputs.length > 100)
    return { observed: [] };
  return { observed: observedMetadata(reply.inputs), memory: memoryDiagnostics(reply.diagnostics) };
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
    throw transportError("bad-url", "invalid source tab id");
  if (!isPublicHttpUrl(reference.documentUrl) || reference.documentUrl.length > MAX_URL_LENGTH)
    throw transportError("bad-url", "invalid source document URL");

  const { tabId, documentUrl } = reference;
  const sourceOrigin = originOfUrl(documentUrl);
  const rootFrame: SourceFrame = { frameId: 0, documentUrl };
  const sessionFrames = new Map<string, SourceFrame>([[sourceOrigin, rootFrame]]);
  const tileFrames = new Map<string, SourceFrame>();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const lifetime = new AbortController();
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
    lifetime.abort(transportError("source-lost", "source document changed"));
  }
  browserApi.tabs.onUpdated.addListener(onUpdated);
  browserApi.tabs.onRemoved.addListener(onRemoved);

  function assertLive() {
    lifetime.signal.throwIfAborted();
  }

  async function checkSourceTab(signal: AbortSignal) {
    const tab = await browserApi.tabs.get(tabId).catch(() => null);
    signal.throwIfAborted();
    assertLive();
    if (!tab?.url || !sameDocumentUrl(tab.url, documentUrl)) {
      invalidate();
      throw transportError(
        "source-lost",
        tab ? "source document changed" : "source tab is unavailable",
      );
    }
  }

  function target(frame: SourceFrame) {
    return frame.documentId
      ? { tabId, documentIds: [frame.documentId] }
      : { tabId, frameIds: [frame.frameId] };
  }

  function lostFrame(frame: SourceFrame) {
    if (frame.frameId === 0) invalidate();
    return transportError("source-lost", "source operation belongs to another document");
  }

  async function inspect(frame: SourceFrame, signal: AbortSignal) {
    const replies = await browserApi.scripting
      .executeScript({
        target: target(frame),
        func: inspectSourceDocument,
        args: [],
      })
      .catch((cause: unknown) => {
        throw transportError(
          "network-failure",
          cause instanceof Error ? cause.message : String(cause),
        );
      });
    signal.throwIfAborted();
    assertLive();
    const reply = replies[0];
    const value = reply?.result;
    if (
      replies.length !== 1 ||
      reply?.frameId !== frame.frameId ||
      !value ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      value.token.length > 128 ||
      !sameDocumentUrl(value.documentUrl, frame.documentUrl) ||
      (frame.token !== undefined && frame.token !== value.token)
    )
      throw lostFrame(frame);
    frame.token = value.token;
    if (reply.documentId) frame.documentId = reply.documentId;
  }

  async function injectUnchecked<Args extends unknown[], Result>(
    script: SourceScript<Args, Result>,
    signal: AbortSignal,
    onLaunch?: () => void,
    frame = rootFrame,
  ): Promise<Awaited<Result>> {
    assertLive();
    signal.throwIfAborted();
    await checkSourceTab(signal);
    // Native document targets reject replacement documents atomically. Older
    // Firefox uses isolated-world tokens, checked again before accepting data.
    if (!frame.documentId) await inspect(frame, signal);
    signal.throwIfAborted();
    onLaunch?.();
    const executable =
      "files" in script
        ? script
        : {
            ...script,
            args: typeof script.args === "function" ? script.args(frame.token ?? "") : script.args,
          };
    const results = await browserApi.scripting
      .executeScript<Args, Result>({
        target: target(frame),
        ...executable,
      })
      .catch((cause: unknown) => {
        assertLive();
        throw {
          ...transportError("network-failure", "source operation could not run"),
          detail: cause instanceof Error ? cause.message : String(cause),
        };
      });
    signal.throwIfAborted();
    assertLive();
    if (!Array.isArray(results) || results.length !== 1 || results[0]?.frameId !== frame.frameId)
      throw transportError("bad-url", "source operation returned an invalid result");
    const result = results[0].result;
    await checkInjectionDocument(result, results[0].documentId, frame, signal);
    return result as Awaited<Result>;
  }

  /** Bound the whole browser operation, including a lost executeScript reply. */
  async function bounded<Result>(
    run: (signal: AbortSignal, onLaunch: () => void) => Promise<Result>,
    signal?: AbortSignal,
    onAbort?: () => Promise<void>,
    deadlineAt = Date.now() + timeoutMs,
  ): Promise<Result> {
    assertLive();
    const deadline = new AbortController();
    const timeout: JobError = {
      kind: "timeout",
      transport: "browser-session",
      detail: "the source operation timed out",
    };
    if (Date.now() >= deadlineAt) throw timeout;
    let reachDeadline = () => {};
    const deadlineReached = new Promise<void>((resolve) => {
      reachDeadline = resolve;
    });
    const timer = setTimeout(
      () => {
        deadline.abort(timeout);
        reachDeadline();
      },
      Math.max(0, deadlineAt - Date.now()),
    );
    const combined = AbortSignal.any([
      lifetime.signal,
      deadline.signal,
      ...(signal ? [signal] : []),
    ]);
    let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => {
      rejectAbort = reject;
    });
    let launched = false;
    let operationDone = Promise.resolve();
    const abort = () => {
      const reason = signal?.aborted
        ? transportError("cancelled", "source fetch cancelled")
        : combined.reason;
      if (onAbort && launched) {
        const cleanup = Promise.resolve()
          .then(onAbort)
          .catch(() => operationDone);
        void Promise.race([cleanup, operationDone, deadlineReached]).then(() =>
          rejectAbort(reason),
        );
      } else rejectAbort(reason);
    };
    combined.addEventListener("abort", abort, { once: true });
    try {
      if (combined.aborted) {
        void abort();
        return await aborted;
      }
      const operation = run(combined, () => {
        launched = true;
      });
      operationDone = operation.then(
        () => {},
        () => {},
      );
      return await Promise.race([operation, aborted]);
    } catch (error) {
      if (combined.aborted) return await aborted;
      throw error;
    } finally {
      clearTimeout(timer);
      combined.removeEventListener("abort", abort);
    }
  }

  function inject<Args extends unknown[] = [], Result = unknown>(
    script: SourceScript<Args, Result>,
    signal?: AbortSignal,
    onAbort?: () => Promise<void>,
    deadlineAt = Date.now() + timeoutMs,
    frame = rootFrame,
  ) {
    return bounded(
      (owned, launched) => injectUnchecked(script, owned, launched, frame),
      signal,
      onAbort,
      deadlineAt,
    );
  }

  async function scan(signal?: AbortSignal, frame = rootFrame): Promise<CandidateSnapshot> {
    const scanDeadline = Date.now() + timeoutMs;
    let observed: CandidateInput[] = [];
    let memory: CandidateSnapshot["memory"];
    try {
      const deadlineAt = Math.min(scanDeadline, Date.now() + 1500);
      const reply = await inject(
        { files: ["/viewer-scanner.js"], world: "MAIN" },
        signal,
        undefined,
        deadlineAt,
        frame,
      );
      ({ observed, memory } = memoryScanReply(reply));
      rememberTileFrames(isRecord(reply) ? reply.resources : undefined, frame);
    } catch (error) {
      // A memory scan is optional evidence; source loss/cancellation still
      // fails the following normal scan through the same lifetime guard.
      assertLive();
      signal?.throwIfAborted();
      memory = {
        unavailable: true,
        detail: String(
          isRecord(error) ? (error.detail ?? error.kind ?? "memory scan failed") : error,
        ).slice(0, 2048),
      };
    }
    const snapshot = await inject(
      { func: collectCandidates, args: [] },
      signal,
      undefined,
      scanDeadline,
      frame,
    );
    if (!validSnapshot(snapshot, frame.documentUrl))
      throw transportError("bad-url", "invalid source scan result");
    assertLive();
    return {
      ...snapshot,
      inputs: [...snapshot.inputs, ...observed].map((input) =>
        frame.frameId !== 0 && input.kind === "source"
          ? { ...input, kind: "observed-document" as const }
          : input,
      ),
      ...(memory ? { memory } : {}),
    };
  }

  async function checkInjectionDocument(
    result: unknown,
    resultDocumentId: string | undefined,
    frame: SourceFrame,
    signal: AbortSignal,
  ): Promise<void> {
    if (frame.documentId && resultDocumentId !== frame.documentId) throw lostFrame(frame);
    if (!frame.documentId) await inspect(frame, signal);
    await checkSourceTab(signal);
    const resultDocumentUrl =
      isRecord(result) && typeof result.documentUrl === "string" ? result.documentUrl : null;
    if (!resultDocumentUrl || !sameDocumentUrl(resultDocumentUrl, frame.documentUrl)) {
      throw lostFrame(frame);
    }
  }

  function rememberTileFrames(resources: unknown, frame: SourceFrame) {
    if (!Array.isArray(resources) || resources.length > 100) return;
    for (const base of resources) {
      if (
        typeof base === "string" &&
        base.length <= MAX_URL_LENGTH &&
        isPublicHttpUrl(base) &&
        tileResourceBase(`${base}/0/0/0/1/1.png`) === base &&
        sameDocumentUrl(base, frame.documentUrl)
      )
        tileFrames.set(base, frame);
    }
  }

  function inventoryFrame(reply: InspectionReply): SourceFrame | undefined {
    const value = reply.result;
    if (
      !Number.isSafeInteger(reply.frameId) ||
      reply.frameId < 0 ||
      !value ||
      typeof value.documentUrl !== "string" ||
      value.documentUrl.length > MAX_URL_LENGTH ||
      !isPublicHttpUrl(value.documentUrl) ||
      typeof value.token !== "string" ||
      value.token.length === 0 ||
      value.token.length > 128 ||
      !Array.isArray(value.frames) ||
      value.frames.length > 16
    )
      return undefined;
    return {
      frameId: reply.frameId,
      documentUrl: value.documentUrl,
      token: value.token,
      ...(reply.documentId ? { documentId: reply.documentId } : {}),
    };
  }

  function collectOrigins(
    value: ReturnType<typeof inspectSourceDocument> | undefined,
    origins: Set<string>,
  ): void {
    if (!value) return;
    for (const url of [value.documentUrl, ...value.frames]) {
      if (
        origins.size < 16 &&
        typeof url === "string" &&
        url.length <= MAX_URL_LENGTH &&
        isPublicHttpUrl(url)
      )
        origins.add(originOfUrl(url));
    }
  }

  function inventoryReplies(replies: InspectionReply[]) {
    const frames: SourceFrame[] = [];
    const origins = new Set<string>();
    for (const reply of replies) {
      const value = reply.result;
      if (frames.length >= 16) break;
      const frame = inventoryFrame(reply);
      if (!frame) continue;
      frames.push(frame);
      collectOrigins(value, origins);
    }
    return { frames, origins };
  }

  function validSourceRequestUrl(uri: unknown): uri is string {
    return typeof uri === "string" && uri.length <= MAX_URL_LENGTH && isPublicHttpUrl(uri);
  }

  function inventory(signal: AbortSignal) {
    return bounded(async (owned) => {
      if (!rootFrame.token) await inspect(rootFrame, owned);
      const replies = await browserApi.scripting
        .executeScript({
          target: { tabId, allFrames: true },
          func: inspectSourceDocument,
          args: [true],
        })
        .catch((cause: unknown) => {
          throw transportError(
            "network-failure",
            cause instanceof Error ? cause.message : String(cause),
          );
        });
      owned.throwIfAborted();
      assertLive();
      const root = replies.find((reply) => reply.frameId === 0);
      if (
        !root?.result ||
        root.result.token !== rootFrame.token ||
        !sameDocumentUrl(root.result.documentUrl, documentUrl)
      )
        throw lostFrame(rootFrame);
      await checkSourceTab(owned);
      return inventoryReplies(replies);
    }, signal);
  }

  /** One lazy traversal per Rust invocation; grants refresh the accessible inventory. */
  function observations(access: {
    hasPermission(origin: string): Promise<boolean>;
    ensurePermission(origin: string, signal: AbortSignal): Promise<void>;
    scanned(snapshot: CandidateSnapshot): void;
    failed(frame: SourceFrame, error: unknown): void;
  }) {
    const seen = new Set<string>();
    const requested = new Set<string>();
    async function scanAvailable(
      frames: SourceFrame[],
      signal: AbortSignal,
    ): Promise<CandidateSnapshot | undefined> {
      for (const frame of frames) {
        const snapshot = await scanObservedFrame(frame, signal);
        if (snapshot) return snapshot;
      }
      return undefined;
    }

    async function scanObservedFrame(
      frame: SourceFrame,
      signal: AbortSignal,
    ): Promise<CandidateSnapshot | undefined> {
      const key = `${frame.frameId}:${frame.token}`;
      if (frame.frameId === 0 || seen.has(key) || seen.size >= 16) return undefined;
      const origin = originOfUrl(frame.documentUrl);
      // A successful isolated-world probe is the browser's access check.
      // Rechecking a match pattern can disagree with activeTab or older
      // Firefox's handling of explicit ports.
      signal.throwIfAborted();
      seen.add(key);
      try {
        const snapshot = await scan(signal, frame);
        if (origin !== sourceOrigin) sessionFrames.set(origin, frame);
        access.scanned(snapshot);
        return snapshot;
      } catch (error) {
        assertLive();
        signal.throwIfAborted();
        access.failed(frame, error);
      }
      return undefined;
    }

    async function nextOrigin(
      available: ReturnType<typeof inventoryReplies>,
    ): Promise<string | undefined> {
      for (const origin of available.origins) {
        if (
          origin !== sourceOrigin &&
          !requested.has(origin) &&
          !available.frames.some((frame) => originOfUrl(frame.documentUrl) === origin) &&
          !(await access.hasPermission(origin))
        ) {
          return origin;
        }
      }
      return undefined;
    }

    async function grantNextOrigin(
      available: ReturnType<typeof inventoryReplies>,
      interaction: Interaction,
      signal: AbortSignal,
    ): Promise<boolean> {
      if (interaction === "forbidden" || requested.size >= 16) return false;
      const next = await nextOrigin(available);
      signal.throwIfAborted();
      if (!next) return false;
      requested.add(next);
      await access.ensurePermission(next, signal);
      return true;
    }

    return async (interaction: Interaction, signal: AbortSignal): Promise<CandidateInput[]> => {
      signal = AbortSignal.any([signal, lifetime.signal]);
      assertLive();
      signal.throwIfAborted();
      // A metadata fetch may have acquired access since the previous batch.
      // Re-probe live frames without repeating already-scanned documents.
      let available = await inventory(signal);
      while (seen.size < 16) {
        const snapshot = await scanAvailable(available.frames, signal);
        if (snapshot) return snapshot.inputs;
        if (!(await grantNextOrigin(available, interaction, signal))) return [];
        available = await inventory(signal);
      }
      return [];
    };
  }

  async function fetch(request: Pick<ResourceRequest, "uri" | "headers">, signal: AbortSignal) {
    assertLive();
    if (signal.aborted) throw transportError("cancelled", "source fetch cancelled");
    if (!validSourceRequestUrl(request.uri))
      throw transportError("bad-url", "invalid source request URL");
    return isViewerTile(request.uri) ? fetchTile(request.uri, signal) : fetchHttp(request, signal);
  }

  async function fetchHttp(request: Pick<ResourceRequest, "uri" | "headers">, signal: AbortSignal) {
    const headers = validateRequestHeaders(request.headers ?? []);
    if (!headers) throw transportError("bad-url", "invalid source request headers");
    const range = requestedByteRange(headers);
    if (range && range.length > SOURCE_FETCH_BYTE_LIMIT)
      throw { kind: "size-limit", max_bytes: SOURCE_FETCH_BYTE_LIMIT } satisfies JobError;

    const operationId = crypto.randomUUID();
    const frame = sessionFrames.get(originOfUrl(request.uri)) ?? rootFrame;
    const deadlineAt = Date.now() + timeoutMs;
    const sourceRequest = {
      url: request.uri,
      headers,
      operationId,
      deadlineAt,
      ...(range ? { rangeBytes: range.length } : {}),
    };
    const cancel = () => {
      return browserApi.scripting
        .executeScript({
          target: target(frame),
          func: cancelSourceFetch,
          args: [operationId, deadlineAt, frame.token ?? ""],
        })
        .then(() => undefined);
    };
    const result = await inject(
      {
        func: fetchSource,
        args: (documentToken): [SourceRequest] => [{ ...sourceRequest, documentToken }],
      },
      signal,
      cancel,
      deadlineAt,
      frame,
    );
    if (signal.aborted) throw transportError("cancelled", "source fetch cancelled");
    assertLive();
    return readSourcePayload(result, frame.documentUrl, range);
  }

  async function fetchTile(url: string, signal: AbortSignal) {
    const base = tileResourceBase(url);
    const frame = base && tileFrames.get(base);
    if (!base || !frame)
      throw transportError("source-lost", "viewer source is no longer available");
    const result = await inject(
      {
        func: readViewerTile,
        args: [url, base],
        world: "MAIN",
      },
      signal,
      undefined,
      Date.now() + timeoutMs,
      frame,
    );
    return readSourcePayload(result, frame.documentUrl, undefined);
  }

  function dispose() {
    releaseTiles();
    invalidate();
    browserApi.tabs.onUpdated.removeListener(onUpdated);
    browserApi.tabs.onRemoved.removeListener(onRemoved);
  }

  function releaseTiles() {
    const frames = new Map<SourceFrame, string[]>();
    for (const [base, frame] of tileFrames) {
      const bases = frames.get(frame) ?? [];
      bases.push(base);
      frames.set(frame, bases);
    }
    tileFrames.clear();
    for (const [frame, bases] of frames) {
      void browserApi.scripting
        .executeScript({
          target: target(frame),
          func: releaseViewerTiles,
          args: [bases],
          world: "MAIN",
        })
        .catch(() => {});
    }
  }

  return {
    scan,
    async loadedImage(signal: AbortSignal) {
      const reply = await inject({ func: findLoadedImage, args: [] }, signal);
      if (!validImage(reply.image)) throw transportError("bad-url", "invalid loaded image result");
      return reply.image;
    },
    async imageDownloadLink(signal: AbortSignal) {
      const reply = await inject({ func: findImageDownloadLink, args: [] }, signal);
      if (
        reply.url !== undefined &&
        (typeof reply.url !== "string" ||
          reply.url.length > MAX_URL_LENGTH ||
          !isPublicHttpUrl(reply.url))
      )
        throw transportError("bad-url", "invalid image download link");
      return reply.url;
    },
    observations,
    fetch,
    handlesResource: isViewerTile,
    releaseTiles,
    hasOrigin(origin: string) {
      return sessionFrames.has(origin);
    },
    dispose,
    get documentUrl() {
      return documentUrl;
    },
    get origin() {
      return sourceOrigin;
    },
  };
}
