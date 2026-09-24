import {
  decodeBase64Payload,
  isPublicHttpUrl,
  normalizeFetchMethod,
  SOURCE_FETCH_BYTE_LIMIT,
  validateEngineHeaders,
} from "@dezoomify/browser-runtime";
import type { RuntimeMessage, SourceFetchReply } from "../protocol.ts";
import { SOURCE_FETCH_BASE64_CHAR_LIMIT } from "../protocol.ts";
import { collectCandidates, fetchSource } from "./source-operations.ts";
import type { BrowserApi, Entry, LogLevel } from "./types.ts";

type CandidateSnapshot = Awaited<ReturnType<typeof collectCandidates>>;
type CandidateInput = CandidateSnapshot["inputs"][number];
type SourceFetchResult = Awaited<ReturnType<typeof fetchSource>>;
type SourceBridgeOptions = {
  browserApi: BrowserApi;
  jobs: Map<string, Entry>;
  sendToJob: (entry: Entry, type: string, extra?: Record<string, unknown>) => unknown;
  setBadge: (tabId: number, active: boolean, failed?: boolean) => void;
  log: (level: LogLevel, code: string, detail?: unknown) => void;
};

// Base64 ceiling for one SOURCE_FETCH_BYTE_LIMIT body. The length bound
// rejects oversized payloads before decoding; the decoded byte count is
// cross-checked too.
const MAX_URL_LENGTH = 2048;
const MAX_CANDIDATES = 100;
const MAX_SNAPSHOTS = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCandidateInput(value: unknown): value is CandidateInput {
  return (
    isRecord(value) &&
    typeof value.url === "string" &&
    value.url.length <= MAX_URL_LENGTH &&
    isPublicHttpUrl(value.url) &&
    (value.contents === undefined || typeof value.contents === "string")
  );
}

function isCandidateSnapshot(value: unknown): value is CandidateSnapshot {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.documentUrl === "string" &&
    isPublicHttpUrl(value.documentUrl) &&
    typeof value.overflow === "number" &&
    Number.isSafeInteger(value.overflow) &&
    value.overflow >= 0 &&
    Array.isArray(value.inputs) &&
    value.inputs.length <= MAX_CANDIDATES &&
    value.inputs.every(isCandidateInput)
  );
}

function isSourceFetchResult(value: unknown): value is SourceFetchResult {
  if (!isRecord(value)) return false;
  if (value.ok === false)
    return (
      typeof value.code === "string" &&
      (value.status === undefined || Number.isInteger(value.status))
    );
  return (
    value.ok === true &&
    typeof value.data === "string" &&
    typeof value.bytes === "number" &&
    typeof value.status === "number" &&
    typeof value.url === "string"
  );
}

export function sameDocumentUrl(a: string, b: string): boolean {
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

/** Coordinates bounded operations in the bound source document. */
export function createSourceBridge({
  browserApi,
  jobs,
  sendToJob,
  setBadge,
  log,
}: SourceBridgeOptions) {
  function sourceOperationAllowed(entry: Entry) {
    return entry.sourceValid && isPublicHttpUrl(entry.sourceUrl) && jobs.get(entry.jobId) === entry;
  }

  async function executeSourceOperation<Args extends unknown[]>(
    entry: Entry,
    func: (...args: Args) => unknown,
    args: Args,
    op = "source",
  ): Promise<unknown | null> {
    if (!sourceOperationAllowed(entry)) {
      log(
        "debug",
        "active-tab-op-skipped",
        `op=${op} tab=${entry.tabId} frame=${entry.frameId} reason=binding-invalid`,
      );
      return null;
    }
    const generation = entry.documentGeneration;
    log(
      "info",
      "active-tab-op-start",
      `op=${op} tab=${entry.tabId} frame=${entry.frameId} gen=${generation}`,
    );
    const results = await browserApi.scripting.executeScript({
      target: { tabId: entry.tabId, frameIds: [entry.frameId] },
      func,
      args,
    });
    if (!sourceOperationAllowed(entry) || entry.documentGeneration !== generation) {
      log("debug", "active-tab-op-discarded", `op=${op} tab=${entry.tabId} reason=binding-lost`);
      return null;
    }
    if (!Array.isArray(results) || results.length !== 1 || results[0]?.frameId !== entry.frameId)
      throw new Error("invalid-source-operation-result");
    return results[0].result;
  }

  function forwardCandidates(entry: Entry, snapshot: CandidateSnapshot) {
    const inputs: CandidateInput[] = [];
    for (const input of snapshot.inputs) {
      if (entry.seenCandidates.has(input.url)) continue;
      entry.seenCandidates.add(input.url);
      inputs.push(input);
    }
    log(
      "debug",
      "candidates-forwarded",
      `jobId=${entry.jobId} added=${inputs.length} overflow=${snapshot.overflow}`,
    );
    if (inputs.length || snapshot.overflow)
      sendToJob(entry, "dz.job.candidates", {
        inputs,
        overflow: snapshot.overflow,
        documentUrl: snapshot.documentUrl,
      });
  }

  function invalidateSourceDocument(entry: Entry, reason: string) {
    entry.documentGeneration += 1;
    entry.sourceValid = false;
    log("info", "source-invalidated", `tab ${entry.tabId} ${reason}`);
  }

  /** A retry gets a fresh dedup set and a finite snapshot budget. */
  function startAttempt(entry: Entry) {
    entry.attemptGeneration += 1;
    entry.jobRunning = false;
    entry.seenCandidates.clear();
    entry.snapshotCount = 0;
    log("info", "attempt-started", `jobId=${entry.jobId} attempt=${entry.attemptGeneration}`);
    void requestCandidateSnapshot(entry);
  }

  async function requestCandidateSnapshot(entry: Entry) {
    if (!sourceOperationAllowed(entry) || entry.snapshotCount >= MAX_SNAPSHOTS) return;
    entry.snapshotCount += 1;
    const attempt = entry.attemptGeneration;
    try {
      const snapshot = await executeSourceOperation(entry, collectCandidates, [], "collect");
      if (!sourceOperationAllowed(entry) || entry.attemptGeneration !== attempt) return;
      if (!isCandidateSnapshot(snapshot)) throw new Error("invalid-candidate-snapshot");
      if (!sameDocumentUrl(snapshot.documentUrl, entry.sourceUrl)) {
        invalidateSourceDocument(entry, "snapshot-document-mismatch");
        return;
      }
      log(
        "info",
        "active-tab-op-result",
        `op=collect tab=${entry.tabId} candidates=${snapshot.inputs.length} overflow=${snapshot.overflow} doc=${snapshot.documentUrl}`,
      );
      forwardCandidates(entry, snapshot);
    } catch (error) {
      if (!sourceOperationAllowed(entry) || entry.attemptGeneration !== attempt) return;
      entry.sourceValid = false;
      setBadge(entry.tabId, true, true);
      log(
        "error",
        "source-snapshot-failed",
        `tab=${entry.tabId} ${error instanceof Error ? error.message : "operation-rejected"}`,
      );
    }
  }

  async function dispatchSourceFetch(
    entry: Entry,
    message: RuntimeMessage,
  ): Promise<SourceFetchReply> {
    const method = normalizeFetchMethod(message.method);
    const headers = validateEngineHeaders(message.headers);
    log(
      "info",
      "source-fetch-request",
      `tab=${entry.tabId} method=${method ?? String(message.method)} purpose=${String(message.purpose ?? "unknown")} url=${String(message.url ?? "")}`,
    );
    const reject = (code: string, status?: number): SourceFetchReply => {
      log("warn", "source-fetch-rejected", `tab=${entry.tabId} code=${code}`);
      return { ok: false, code, ...(status === undefined ? {} : { status }) };
    };
    if (
      !isPublicHttpUrl(message.url) ||
      message.url.length > MAX_URL_LENGTH ||
      !method ||
      !headers
    ) {
      return reject("invalid-source-request");
    }
    let value: unknown;
    try {
      value = await executeSourceOperation(
        entry,
        fetchSource,
        [{ url: message.url, method, headers }],
        "fetch",
      );
    } catch {
      return reject("source-operation-failed");
    }
    if (value === null) {
      return reject("source-invalidated");
    }
    if (!isSourceFetchResult(value)) return reject("invalid-source-fetch-result");
    const result = value;
    if (!result.ok) {
      const code =
        typeof result.code === "string" && /^[a-z0-9-]{1,64}$/.test(result.code)
          ? result.code
          : "source-fetch-failed";
      return reject(code, Number.isInteger(result.status) ? result.status : undefined);
    }
    if (
      typeof result.data !== "string" ||
      result.data.length === 0 ||
      result.data.length > SOURCE_FETCH_BASE64_CHAR_LIMIT ||
      typeof result.bytes !== "number" ||
      !Number.isSafeInteger(result.bytes) ||
      result.bytes < 0 ||
      result.bytes > SOURCE_FETCH_BYTE_LIMIT ||
      typeof result.status !== "number" ||
      !Number.isInteger(result.status) ||
      result.status < 200 ||
      result.status >= 300 ||
      !isPublicHttpUrl(result.url)
    ) {
      return reject("invalid-source-fetch-result");
    }
    const decoded = decodeBase64Payload(result.data, SOURCE_FETCH_BYTE_LIMIT);
    if (!decoded || decoded.byteLength !== result.bytes) {
      return reject("invalid-source-fetch-result");
    }
    log(
      "info",
      "source-fetch-complete",
      `tab=${entry.tabId} status=${result.status} bytes=${result.bytes} url=${result.url}`,
    );
    return {
      ok: true,
      status: result.status,
      url: result.url,
      bytes: result.bytes,
      data: result.data,
    };
  }

  return { dispatchSourceFetch, invalidateSourceDocument, requestCandidateSnapshot, startAttempt };
}
