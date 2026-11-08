import {
  decodeBase64Payload,
  errorFromPayload,
  InternalError,
  isJobError,
  isPublicHttpUrl,
  originOfUrl,
  requestedByteRange,
  SizeLimitError,
  SOURCE_FETCH_BYTE_LIMIT,
  TimeoutError,
  validateByteRangeLength,
  validateByteRangeResponse,
  validateRequestHeaders,
} from "@dezoomify/browser-runtime";
import {
  callPageAgent,
  type LoadedImage,
  type PageRequest,
  type PageResponse,
  type PageResults,
} from "@dezoomify/page-agent";
import type {
  Interaction,
  JobInput,
  ObservedInput,
  ResourceRequest,
  Size,
  ViewerTileRequest,
} from "@dezoomify/wasm-bindings";
import type { PublicPath, WxtBrowser } from "wxt/browser";
import { transportError } from "../runtime/fetch.ts";
import { cancelSourceFetch, fetchSource, inspectSourceDocument } from "./source-operations.ts";
import { collectCandidates, type SourceSnapshot, sourceSnapshotLimits } from "./source-snapshot.ts";

type SourceApi = Pick<WxtBrowser, "tabs" | "scripting">;
type SourceFrame = { frameId: number; documentUrl: string; token?: string; documentId?: string };
type DiagnosticValue = number | boolean | string | string[];
type MemoryDiagnostics = Record<string, DiagnosticValue>;
interface CandidateSnapshot extends SourceSnapshot {
  memory?: MemoryDiagnostics;
}
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

const MAX_URL_LENGTH = sourceSnapshotLimits.urlLength;
const MAX_DOM_BYTES = sourceSnapshotLimits.documentBytes;
const MAX_BASE64_CHARS = Math.ceil((SOURCE_FETCH_BYTE_LIMIT + 2) / 3) * 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Page replies may name only an ordinary image GET. Credentials and arbitrary
 * headers stay with page loaders; transports still enforce origin permissions. */
function viewerResource(uri: unknown): ResourceRequest {
  if (typeof uri !== "string" || uri.length > MAX_URL_LENGTH || !isPublicHttpUrl(uri))
    throw new InternalError("Invalid viewer tile URL");
  const url = new URL(uri);
  if (url.username || url.password) throw new InternalError("Viewer tile URL contains credentials");
  return { uri, headers: [], purpose: "tile" };
}

function viewerBytes(result: unknown): ArrayBuffer {
  if (
    !isRecord(result) ||
    typeof result.data !== "string" ||
    result.data.length > MAX_BASE64_CHARS ||
    typeof result.bytes !== "number" ||
    !Number.isSafeInteger(result.bytes) ||
    result.bytes < 0 ||
    result.bytes > SOURCE_FETCH_BYTE_LIMIT
  )
    throw new InternalError("Invalid viewer tile byte payload");
  const bytes = decodeBase64Payload(result.data, SOURCE_FETCH_BYTE_LIMIT);
  if (!bytes || bytes.byteLength !== result.bytes)
    throw new InternalError("Invalid viewer tile byte count");
  return bytes.buffer as ArrayBuffer;
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

function validCandidate(value: unknown): value is JobInput {
  if (!isRecord(value) || typeof value.url !== "string") return false;
  if (
    value.kind !== undefined &&
    value.kind !== "source" &&
    value.kind !== "observed-document" &&
    value.kind !== "observed-resource" &&
    value.kind !== "observed-metadata" &&
    value.kind !== "observed-viewer"
  )
    return false;
  if (value.url.length > MAX_URL_LENGTH || !isPublicHttpUrl(value.url)) return false;
  if (value.contents === undefined) return true;
  if (typeof value.contents !== "string") return false;
  return new TextEncoder().encode(value.contents).byteLength <= MAX_DOM_BYTES;
}

function validSnapshotInputs(inputs: unknown[]): boolean {
  for (const [index, input] of inputs.entries()) {
    if (!validCandidate(input)) return false;
    if (index === 0) continue;
    // Only the document carries contents. Memory observations are validated
    // separately; resource inventory replies cannot multiply document payloads.
    if (input.contents !== undefined || input.kind !== "observed-resource") return false;
  }
  return true;
}

function validSnapshot(value: unknown, expectedUrl: string): value is CandidateSnapshot {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.documentUrl === "string" &&
    isPublicHttpUrl(value.documentUrl) &&
    sameDocumentUrl(value.documentUrl, expectedUrl) &&
    Array.isArray(value.inputs) &&
    validSnapshotInputs(value.inputs)
  );
}

function validImage(value: unknown): value is LoadedImage | undefined {
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

/** Validate an untrusted page reply envelope before its result is read. Payload
 * fields stay untrusted; each caller checks the values it takes from `result`. */
function isPageReply<R extends PageRequest>(
  value: unknown,
  request: R,
  expectedUrl: string,
): value is PageResponse<R["method"]> {
  return (
    isRecord(value) &&
    value.method === request.method &&
    typeof value.documentUrl === "string" &&
    sameDocumentUrl(value.documentUrl, expectedUrl) &&
    (value.ok === true || (value.ok === false && isJobError(value.error)))
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
  if (!result.ok) throw errorFromPayload(result.error);
  if (range) {
    validateByteRangeResponse(range, result.status, result.contentRange, result.contentLength);
    validateByteRangeLength(range, result.bytes);
  }
  const bytes = decodeBase64Payload(result.data, SOURCE_FETCH_BYTE_LIMIT);
  if (!bytes || bytes.byteLength !== result.bytes)
    throw transportError("bad-url", "invalid source payload");
  return { bytes, finalUri: result.url, http: result.status, contentType: result.contentType };
}

function observedInputs(inputs: unknown[]): ObservedInput[] {
  let bytes = 0;
  const observed: ObservedInput[] = [];
  for (const input of inputs) {
    if (!validCandidate(input)) continue;
    if (
      (input.kind !== "observed-metadata" && input.kind !== "observed-viewer") ||
      typeof input.contents !== "string"
    )
      continue;
    const candidate: ObservedInput = {
      url: input.url,
      kind: input.kind,
      contents: input.contents,
    };
    bytes += new TextEncoder().encode(JSON.stringify(candidate)).byteLength;
    if (bytes <= 1024 * 1024) observed.push(candidate);
  }
  return observed;
}

function validMemoryValue(value: unknown): value is DiagnosticValue {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0;
  if (typeof value === "boolean") return true;
  if (typeof value === "string") return value.length <= 1024;
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every((item) => typeof item === "string" && item.length <= 2048)
  );
}

function memoryDiagnostics(value: unknown): MemoryDiagnostics | undefined {
  if (!isRecord(value)) return undefined;
  const memory: MemoryDiagnostics = {};
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

function memoryScanReply(result: unknown): {
  observed: ObservedInput[];
  images: LoadedImage[];
  memory?: MemoryDiagnostics;
} {
  if (!isRecord(result) || !Array.isArray(result.inputs) || result.inputs.length > 100)
    return { observed: [], images: [] };
  const images =
    Array.isArray(result.images) && result.images.length <= 100
      ? result.images
          .filter(
            (image): image is LoadedImage =>
              validImage(image) &&
              image !== undefined &&
              image.url.length <= MAX_URL_LENGTH &&
              isPublicHttpUrl(image.url),
          )
          .map(({ url, width, height }) => ({ url, width, height }))
      : [];
  return {
    observed: observedInputs(result.inputs),
    images,
    memory: memoryDiagnostics(result.diagnostics),
  };
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
  const singleImageFrames = new Map<SourceFrame, LoadedImage[]>();
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
        throw transportError(
          "network-failure",
          cause instanceof Error ? cause.message : String(cause),
        );
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
    const timeout = new TimeoutError("the source operation timed out", {
      transport: "browser-session",
    });
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

  /** Dispatch one page operation into a frame's main world under an existing
   * bound and return its result. The reply envelope is checked here and the
   * agent's typed failure is thrown; the result itself stays untrusted and each
   * caller validates the values it reads. */
  async function pageCall<R extends PageRequest>(
    frame: SourceFrame,
    request: R,
    owned: AbortSignal,
  ): Promise<PageResults[R["method"]]> {
    const reply = await injectUnchecked(
      { func: callPageAgent, args: [request], world: "MAIN" },
      owned,
      undefined,
      frame,
    );
    if (!isPageReply<R>(reply, request, frame.documentUrl))
      throw new InternalError("Invalid page agent response");
    if (!reply.ok) throw errorFromPayload(reply.error);
    return reply.result;
  }

  /** `pageCall` bounded on its own, for a caller with no outer bound. */
  function pageOperation<R extends PageRequest>(
    frame: SourceFrame,
    request: R,
    signal?: AbortSignal,
    deadlineAt = Date.now() + timeoutMs,
  ): Promise<PageResults[R["method"]]> {
    return bounded((owned) => pageCall(frame, request, owned), signal, undefined, deadlineAt);
  }

  async function scan(signal?: AbortSignal, frame = rootFrame): Promise<CandidateSnapshot> {
    const scanDeadline = Date.now() + timeoutMs;
    let observed: ObservedInput[] = [];
    let images: LoadedImage[] = [];
    let memory: MemoryDiagnostics | undefined;
    try {
      // Evaluating the agent bundle installs the entry point every later page
      // call reaches. Re-injection is idempotent: handles an earlier injection
      // registered stay valid until their own job retires them.
      const result = await bounded(
        async (owned) => {
          await injectUnchecked(
            { files: ["/page-agent.js"], world: "MAIN" },
            owned,
            undefined,
            frame,
          );
          return pageCall(frame, { method: "scan" }, owned);
        },
        signal,
        undefined,
        scanDeadline,
      );
      ({ observed, images, memory } = memoryScanReply(result));
      rememberTileFrames(result.handles, frame);
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
      { func: collectCandidates, args: [sourceSnapshotLimits] },
      signal,
      undefined,
      scanDeadline,
      frame,
    );
    if (!validSnapshot(snapshot, frame.documentUrl))
      throw transportError("bad-url", "invalid source scan result");
    assertLive();
    singleImageFrames.set(frame, images);
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

  function rememberTileFrames(handles: unknown, frame: SourceFrame) {
    if (!Array.isArray(handles) || handles.length > 100) return;
    for (const handle of handles) {
      if (typeof handle === "string" && /^[\w-]{1,128}$/.test(handle))
        tileFrames.set(handle, frame);
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

  /** One lazy traversal per Rust invocation. Batch accessible frames together so
   * discovery can offer sibling viewers before requesting more permissions. */
  function observations(access: {
    hasPermission(origin: string): Promise<boolean>;
    ensurePermission(origin: string, signal: AbortSignal): Promise<void>;
    scanned(snapshot: CandidateSnapshot): void;
    failed(frame: SourceFrame, error: unknown): void;
  }) {
    const seen = new Set<string>();
    const requested = new Set<string>();
    async function scanAvailable(frames: SourceFrame[], signal: AbortSignal): Promise<JobInput[]> {
      const inputs: JobInput[] = [];
      for (const frame of frames) {
        const snapshot = await scanObservedFrame(frame, signal);
        if (snapshot) inputs.push(...snapshot.inputs);
      }
      return inputs;
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

    return async (interaction: Interaction, signal: AbortSignal): Promise<JobInput[]> => {
      signal = AbortSignal.any([signal, lifetime.signal]);
      assertLive();
      signal.throwIfAborted();
      // A metadata fetch may have acquired access since the previous batch.
      // Re-probe live frames without repeating already-scanned documents.
      let available = await inventory(signal);
      while (seen.size < 16) {
        const inputs = await scanAvailable(available.frames, signal);
        if (inputs.length) return inputs;
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
    return fetchHttp(request, signal);
  }

  async function fetchHttp(request: Pick<ResourceRequest, "uri" | "headers">, signal: AbortSignal) {
    const headers = validateRequestHeaders(request.headers ?? []);
    if (!headers) throw transportError("bad-url", "invalid source request headers");
    const range = requestedByteRange(headers);
    if (range && range.length > SOURCE_FETCH_BYTE_LIMIT)
      throw new SizeLimitError(SOURCE_FETCH_BYTE_LIMIT);

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

  /** Resolve a job-owned handle in its exact live frame; cancellation stops
   * waiting without cancelling the page viewer's loader or cache. */
  async function loadViewerTile(
    request: ViewerTileRequest,
    extent: Size,
    signal: AbortSignal,
  ): Promise<ArrayBuffer | ResourceRequest> {
    assertLive();
    signal.throwIfAborted();
    const frame = tileFrames.get(request.handle);
    if (!frame || !sameDocumentUrl(request.source_url, frame.documentUrl))
      throw transportError("source-lost", "viewer source is no longer available");
    const result = await pageOperation(frame, { method: "read-tile", request, extent }, signal);
    return isRecord(result) && "url" in result ? viewerResource(result.url) : viewerBytes(result);
  }

  function dispose() {
    releaseTiles();
    invalidate();
    browserApi.tabs.onUpdated.removeListener(onUpdated);
    browserApi.tabs.onRemoved.removeListener(onRemoved);
  }

  /** Retire page tile handles and single-image candidates before the next job scans. */
  function releaseTiles() {
    singleImageFrames.clear();
    const frames = new Map<SourceFrame, string[]>();
    for (const [handle, frame] of tileFrames) {
      const handles = frames.get(frame) ?? [];
      handles.push(handle);
      frames.set(frame, handles);
    }
    tileFrames.clear();
    for (const [frame, handles] of frames) {
      void browserApi.scripting
        .executeScript({
          target: target(frame),
          func: callPageAgent,
          args: [{ method: "release-tiles", handles } satisfies PageRequest],
          world: "MAIN",
        })
        .catch(() => {});
    }
  }

  return {
    scan,
    loadedImage,
    async imageDownloadLink(signal: AbortSignal) {
      const url = await pageOperation(rootFrame, { method: "find-image-link" }, signal);
      if (url !== undefined && (url.length > MAX_URL_LENGTH || !isPublicHttpUrl(url)))
        throw transportError("bad-url", "invalid image download link");
      return url;
    },
    observations,
    fetch,
    loadViewerTile,
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

  /** Revalidate contributing documents before selecting a viewer original or
   * the source page's current large DOM image. Never use a navigated frame's URL. */
  function loadedImage(signal: AbortSignal) {
    return bounded(async (owned) => {
      const images: LoadedImage[] = [];
      for (const [frame, candidates] of singleImageFrames) {
        if (!candidates.length) continue;
        images.push(...(await liveImages(frame, candidates, owned)));
      }
      const result = await pageCall(rootFrame, { method: "find-loaded-image", images }, owned);
      if (!validImage(result)) throw transportError("bad-url", "invalid loaded image result");
      return result;
    }, signal);
  }

  async function liveImages(frame: SourceFrame, images: LoadedImage[], signal: AbortSignal) {
    try {
      await inspect(frame, signal);
      return images;
    } catch (error) {
      assertLive();
      signal.throwIfAborted();
      if (frame.frameId === 0) throw error;
      return [];
    }
  }
}
