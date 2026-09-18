/**
 * Extension background coordinator factory.
 *
 * All mutable coordinator state (job/binding maps, wiring flags, id
 * sequences, the logger instance) lives inside `createBackgroundCoordinator`,
 * so each caller (production or test) owns an isolated instance. Nothing in
 * this module reads `globalThis` at import time; the browser API is an
 * injected dependency. Stateless helpers and limits stay at module scope.
 */

import { collectCandidates, fetchSource } from "./source-operations.ts";
import { LOG_LEVELS, LOG_MAX_CHARS, createLogger } from "@dezoomify/browser-runtime/logging";

type LogLevel = keyof typeof LOG_LEVELS;
type Message = Record<string, unknown> & { type?: string; requestId?: string; jobId?: string; tabId?: number; frameId?: number; documentGeneration?: number; url?: string; method?: string; headers?: unknown; origins?: unknown };
type CandidateInput = { url: string; contents?: string };
type CandidateSnapshot = { ok: true; documentUrl: string; inputs: CandidateInput[]; overflow: number };
type CandidateBatch = { requestId: string; inputs: CandidateInput[]; overflow: number; documentUrl: string };
type SourceFetchResult = { ok: boolean; code?: string; status?: number; url?: string; bytes?: number; data?: string };
type Entry = { jobId: string; tabId: number; frameId: number; documentGeneration: number; attemptGeneration: number; jobTabId: number; sourceUrl: string; sourceValid: boolean; jobActive: boolean; jobReady: boolean; jobRunning: boolean; heldCandidates: Array<{ entry: Entry; candidate: CandidateBatch }>; seenCandidates: Set<string>; snapshotCount: number; grantedOrigins: Set<string>; primary: boolean };
export type BrowserApi = {
  action?: { setIcon?: (details: unknown) => Promise<void>; setBadgeText?: (details: unknown) => Promise<void>; onClicked?: { addListener?: (listener: (tab: BrowserTab) => void) => void } };
  tabs?: { sendMessage?: (tabId: number, message: unknown, options?: { frameId: number }) => Promise<unknown>; update?: (tabId: number, details: unknown) => Promise<unknown>; create?: (details: unknown) => Promise<BrowserTab>; onRemoved?: { addListener?: (listener: (tabId: number) => void) => void }; onUpdated?: { addListener?: (listener: (tabId: number, changeInfo: { url?: string }) => void) => void } };
  storage?: { session?: { set?: (value: unknown) => Promise<void>; get?: (key: string) => Promise<Record<string, unknown>> } };
  permissions?: { contains?: (details: { origins: string[] }) => Promise<boolean>; onRemoved?: { addListener?: (listener: (removed: { origins?: string[] }) => void) => void } };
  scripting?: { executeScript?: (details: { target: { tabId: number; frameIds: number[] }; func: (...args: never[]) => unknown; args: unknown[] }) => Promise<Array<{ frameId: number; result: unknown }>> };
  runtime?: { getURL?: (path: string) => string; onMessage?: { addListener?: (listener: (message: Message, sender: BrowserSender, sendResponse: (response: unknown) => void) => boolean | void) => void } };
};
export type BrowserTab = { id?: number; url?: string };
type BrowserSender = { tab?: BrowserTab; frameId?: number };
const testGlobals = globalThis as typeof globalThis & { __DEZOOMIFY_TEST__?: boolean };
const STORAGE_KEY = "dezoomify.sourceBindings.v1";
const IDLE_ICON = { 16: "icons/icon16-grey.png", 48: "icons/icon48-grey.png", 128: "icons/icon128-grey.png" };
const ACTIVE_ICON = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
const HELD_CANDIDATE_LIMIT = 64;
const MAX_SNAPSHOTS = 4;
const MAX_URL_LENGTH = 2048;
const MAX_CANDIDATES = 100;
const MAX_HEADER_COUNT = 64;
const MAX_HEADER_NAME_LENGTH = 256;
const MAX_HEADER_VALUE_LENGTH = 4096;
const MAX_SOURCE_FETCH_BYTES = 8 * 1024 * 1024;
// Base64 ceiling for an 8 MiB body. The length bound rejects oversized
// payloads before decoding; the decoded byte count is cross-checked too.
const MAX_SOURCE_DATA_CHARS = 11184812;

export const BACKGROUND_LOG_MAX_CHARS = LOG_MAX_CHARS;

function isPublicHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}
function permissionOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
}

function sameDocumentUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a); const right = new URL(b);
    left.hash = ""; right.hash = "";
    return left.href === right.href;
  } catch { return a === b; }
}

export function createBackgroundCoordinator({ browserApi }: { browserApi?: BrowserApi }) {
  const backgroundLogger = createLogger("background");

  function setBackgroundLogLevel(level: string | number) { backgroundLogger.setLevel(level); }
  function setBackgroundLogSink(sink: unknown) { backgroundLogger.setSink(sink); }
  function backgroundLog(level: LogLevel, code: string, detail: unknown = "") { backgroundLogger.log(level, code, detail); }

  const jobs = new Map<string, Entry>();
  const sourceBindings = new Map<string, Entry>();
  let wired = false;
  let restoreStarted = false;
  let jobSequence = 0;

  function sourceBindingKey(entry: Entry) { return `${entry.jobId}:${entry.tabId}:${entry.frameId}`; }
  function bindingOf(entry: Entry) {
    return {
      jobId: entry.jobId, tabId: entry.tabId, frameId: entry.frameId,
      documentGeneration: entry.documentGeneration,
    };
  }
  function bindingMatches(message: Message, entry: Entry) {
    const binding = bindingOf(entry);
    return Boolean(message && message.jobId === binding.jobId && message.tabId === binding.tabId &&
      message.frameId === binding.frameId && message.documentGeneration === binding.documentGeneration);
  }
  function requestId(message: Message) { return typeof message?.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 200; }
  function makeRequestId(prefix: string) { jobSequence += 1; return `${prefix}-${Date.now().toString(36)}-${jobSequence}`; }
  function makeJobId() {
    try { if (globalThis.crypto?.randomUUID) return `job:${globalThis.crypto.randomUUID()}`; } catch {}
    return makeRequestId("job").replace("job-", "job:");
  }

  function setBadge(tabId: number, active: boolean, failed = false) {
    try {
      const icon = browserApi?.action?.setIcon?.({ tabId, path: active ? ACTIVE_ICON : IDLE_ICON });
      if (icon?.catch) icon.catch(() => {});
      const badge = browserApi?.action?.setBadgeText?.({ tabId, text: active ? (failed ? "!" : "•") : "" });
      if (badge?.catch) badge.catch(() => {});
    } catch {}
  }

  function sendToTab(tabId: number, message: unknown, frameId?: number) {
    try {
      const options = typeof frameId === "number" ? { frameId } : undefined;
      const pending = options === undefined ? browserApi?.tabs?.sendMessage?.(tabId, message) : browserApi?.tabs?.sendMessage?.(tabId, message, options);
      if (pending?.catch) pending.catch(() => {});
      return pending;
    } catch { return null; }
  }
  function sendToJob(entry: Entry, type: string, requestIdValue: string | undefined, extra: Record<string, unknown> = {}) {
    if (!requestIdValue) return null;
    if (typeof entry.jobTabId !== "number") return null;
    backgroundLog("debug", "job-message-sent", `type=${type} request=${requestIdValue} tab=${entry.jobTabId}`);
    return sendToTab(entry.jobTabId, { type, ...bindingOf(entry), requestId: requestIdValue, ...extra });
  }

  function serializableEntry(entry: Entry) {
    return {
      ...bindingOf(entry), jobTabId: entry.jobTabId, sourceUrl: entry.sourceUrl,
      grantedOrigins: [...entry.grantedOrigins], primary: entry.primary === true,
    };
  }
  async function persistBindings() {
    try {
      const entries = [...sourceBindings.values()].map(serializableEntry);
      await browserApi?.storage?.session?.set?.({ [STORAGE_KEY]: entries });
    } catch (error) { backgroundLog("debug", "storage-write-failed", error instanceof Error ? error.message : error); }
  }
  async function restoreBindings() {
    if (restoreStarted) return;
    restoreStarted = true;
    try {
      const stored = await browserApi?.storage?.session?.get?.(STORAGE_KEY);
      const entries = Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
      for (const raw of entries) {
        if (!raw || typeof raw.jobId !== "string" || typeof raw.tabId !== "number" || typeof raw.frameId !== "number" ||
          typeof raw.documentGeneration !== "number" || typeof raw.jobTabId !== "number") continue;
        const entry: Entry = {
          jobId: raw.jobId, tabId: raw.tabId, frameId: raw.frameId, documentGeneration: raw.documentGeneration,
          attemptGeneration: 0,
          jobTabId: raw.jobTabId, sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
          sourceValid: false, jobActive: false, jobReady: false, jobRunning: false, heldCandidates: [],
          seenCandidates: new Set<string>(), snapshotCount: 0,
          grantedOrigins: new Set(Array.isArray(raw.grantedOrigins) ? raw.grantedOrigins.filter(isPublicHttpUrl) : []),
          primary: raw.primary === true,
        };
        sourceBindings.set(sourceBindingKey(entry), entry);
        if (entry.primary || !jobs.has(entry.jobId)) jobs.set(entry.jobId, entry);
      }
      if (entries.length) backgroundLog("info", "bindings-restored", `${jobs.size} binding(s), no auto-start`);
    } catch (error) { backgroundLog("debug", "storage-read-failed", error instanceof Error ? error.message : error); }
  }

  function findJobSender(sender: BrowserSender, message: Message): Entry | null {
    const tabId = sender?.tab?.id;
    const senderFrameId = sender?.frameId;
    if (typeof tabId !== "number" || typeof senderFrameId !== "number") return null;
    if (typeof message.jobId !== "string") return null;
    const job = jobs.get(message.jobId);
    if (!job || job.jobTabId !== tabId) return null;
    // The first ready notification only proves the job tab owns the opaque id
    // placed in its extension URL. It cannot yet include a source binding.
    if (message?.type === "dz.job.ready") return senderFrameId === 0 ? job : null;
    const source = sourceBindings.get(`${message.jobId}:${message.tabId}:${message.frameId}`);
    return source && senderFrameId === source.frameId && bindingMatches(message, source) ? source : null;
  }

  async function removeJob(entry: Entry, reason: string) {
    for (const source of [...sourceBindings.values()]) if (source.jobId === entry.jobId) {
      sourceBindings.delete(sourceBindingKey(source));
    }
    jobs.delete(entry.jobId);
    setBadge(entry.tabId, false);
    await persistBindings();
    backgroundLog("info", "job-removed", `${entry.jobId} ${reason}`);
  }

  async function createJob(tab: BrowserTab) {
    const tabId = tab?.id;
    if (typeof tabId !== "number" || !isPublicHttpUrl(tab?.url)) {
      backgroundLog("warn", "privileged-rejected", String(tab?.url ?? ""));
      return;
    }
    backgroundLog("info", "toolbar-click", `tab=${tabId} url=${String(tab?.url ?? "")}`);
    for (const entry of jobs.values()) {
      if (entry.tabId === tabId && entry.jobRunning && typeof entry.jobTabId === "number") {
        backgroundLog("info", "job-focus", `tab=${tabId} jobTab=${entry.jobTabId} reason=running`);
        try { await browserApi?.tabs?.update?.(entry.jobTabId, { active: true }); } catch {}
        return;
      }
      if (entry.tabId === tabId && entry.jobActive) {
        entry.jobActive = false;
        entry.sourceValid = false;
        backgroundLog("info", "job-cancel-requested", `tab=${tabId} jobId=${entry.jobId}`);
        sendToJob(entry, "dz.job.cancel", makeRequestId("toolbar-cancel"), { reason: "toolbar-cancel" });
        setBadge(tabId, false);
        await persistBindings();
        return;
      }
      if (entry.tabId === tabId && entry.jobReady && typeof entry.jobTabId === "number") {
        backgroundLog("info", "job-focus", `tab=${tabId} jobTab=${entry.jobTabId} reason=ready`);
        try { await browserApi?.tabs?.update?.(entry.jobTabId, { active: true }); } catch {}
        return;
      }
    }
    const jobId = makeJobId();
    let jobTab;
    try {
      jobTab = await browserApi?.tabs?.create?.({ url: browserApi?.runtime?.getURL?.(`job.html#jobId=${encodeURIComponent(jobId)}`), active: true });
    } catch (error) {
      backgroundLog("error", "job-tab-create-failed", error instanceof Error ? error.message : error);
      return;
    }
    if (typeof jobTab?.id !== "number") {
      backgroundLog("error", "job-tab-create-failed", "missing tab id");
      return;
    }
    const entry: Entry = {
      jobId, tabId, frameId: 0, documentGeneration: 0, attemptGeneration: 0, jobTabId: jobTab.id, sourceUrl: tab.url,
      sourceValid: true, jobActive: true, jobReady: false, jobRunning: false, heldCandidates: [],
      seenCandidates: new Set<string>(), snapshotCount: 0, grantedOrigins: new Set<string>(), primary: true,
    };
    jobs.set(jobId, entry);
    sourceBindings.set(sourceBindingKey(entry), entry);
    setBadge(tabId, true);
    await persistBindings();
    backgroundLog("info", "job-created", `jobId=${jobId} jobTab=${jobTab.id} sourceTab=${tabId} frame=${entry.frameId} url=${tab.url}`);
  }

  function validSourceHeaders(headers: unknown): Array<{ name: string; value: string }> | null {
    if (!Array.isArray(headers) || headers.length > MAX_HEADER_COUNT) return null;
    const result: Array<{ name: string; value: string }> = [];
    for (const header of headers) {
      if (!header || typeof header.name !== "string" || typeof header.value !== "string" ||
        header.name.length === 0 || header.name.length > MAX_HEADER_NAME_LENGTH || header.value.length > MAX_HEADER_VALUE_LENGTH ||
        /[\r\n]/.test(header.name) || /[\r\n]/.test(header.value)) return null;
      result.push({ name: header.name, value: header.value });
    }
    return result;
  }

  function validSourceMethod(method: unknown): string | null {
    if (method === undefined) return "GET";
    if (typeof method !== "string" || method.length === 0 || method.length > 16 || !/^[A-Za-z]+$/.test(method)) return null;
    const normalized = method.toUpperCase();
    return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(normalized) ? normalized : null;
  }

  function sourceOperationAllowed(entry: Entry) {
    return entry?.jobActive === true && entry.sourceValid === true && isPublicHttpUrl(entry.sourceUrl) &&
      sourceBindings.get(sourceBindingKey(entry)) === entry;
  }

  async function executeSourceOperation(entry: Entry, func: (...args: never[]) => unknown, args: unknown[] = [], op = "source"): Promise<unknown> {
    if (!sourceOperationAllowed(entry)) {
      backgroundLog("debug", "active-tab-op-skipped", `op=${op} tab=${entry.tabId} frame=${entry.frameId} reason=binding-invalid`);
      return null;
    }
    const generation = entry.documentGeneration;
    backgroundLog("info", "active-tab-op-start", `op=${op} tab=${entry.tabId} frame=${entry.frameId} gen=${generation}`);
    const results = await browserApi?.scripting?.executeScript?.({
      target: { tabId: entry.tabId, frameIds: [entry.frameId] },
      func,
      args,
    });
    if (!sourceOperationAllowed(entry) || entry.documentGeneration !== generation) {
      backgroundLog("debug", "active-tab-op-discarded", `op=${op} tab=${entry.tabId} reason=binding-lost`);
      return null;
    }
    if (!Array.isArray(results) || results.length !== 1 || results[0]?.frameId !== entry.frameId) throw new Error("invalid-source-operation-result");
    return results[0].result;
  }

  function forwardCandidates(entry: Entry, snapshot: CandidateSnapshot) {
    const job = jobs.get(entry.jobId) ?? entry;
    const inputs: CandidateInput[] = [];
    for (const input of snapshot.inputs) {
      if (entry.seenCandidates.has(input.url)) continue;
      entry.seenCandidates.add(input.url);
      inputs.push(input);
    }
    const candidate = { requestId: makeRequestId("candidates"), inputs, overflow: snapshot.overflow, documentUrl: snapshot.documentUrl };
    backgroundLog("debug", "candidates-forwarded", `jobId=${entry.jobId} added=${inputs.length} overflow=${snapshot.overflow} ready=${job.jobReady} held=${job.heldCandidates.length}`);
    if (!inputs.length && !candidate.overflow) return;
    if (job.jobReady) sendToJob(entry, "dz.job.candidates", candidate.requestId, candidate);
    else if (job.heldCandidates.length < HELD_CANDIDATE_LIMIT) job.heldCandidates.push({ entry, candidate });
  }
  function flushHeldCandidates(entry: Entry) {
    while (entry.jobReady && entry.heldCandidates.length) {
      const held = entry.heldCandidates.shift();
      if (!held) break;
      sendToJob(held.entry, "dz.job.candidates", held.candidate.requestId, held.candidate);
    }
  }

  async function handlePermission(entry: Entry, message: Message) {
    const origins = Array.isArray(message.origins)
      ? [...new Set(message.origins.map(permissionOrigin).filter((origin): origin is string => origin !== null))]
      : [];
    if (!origins.length) return sendToJob(entry, "dz.job.permission-required", message.requestId, { granted: false, code: "invalid-origins" });
    let granted = false;
    // The job page owns `permissions.request()` because it retains the user
    // activation from its Allow button. The coordinator verifies that grant
    // before resuming a paused acquisition.
    if (testGlobals.__DEZOOMIFY_TEST__ && message.testGrant === true) granted = true;
    else try { granted = Boolean(await browserApi?.permissions?.contains?.({ origins: origins.map((origin) => `${origin}/*`) })); } catch {}
    if (granted) for (const origin of origins) entry.grantedOrigins.add(origin);
    await persistBindings();
    backgroundLog("info", "permission-check", `req=${message.requestId} jobId=${entry.jobId} origins=${origins.length} granted=${granted}`);
    sendToJob(entry, "dz.job.permission-required", message.requestId, { granted, origins });
  }

  function invalidateSourceDocument(entry: Entry, reason: string) {
    entry.documentGeneration += 1;
    entry.sourceValid = false;
    entry.jobActive = false;
    entry.heldCandidates.length = 0;
    sendToJob(entry, "dz.job.binding", makeRequestId("source-invalidated"), { sourceValid: false, reason });
    void persistBindings();
    backgroundLog("info", "source-invalidated", `tab ${entry.tabId} ${reason}`);
  }

  /**
   * Begin a fresh discovery attempt for the bound source document. Each attempt
   * owns its candidate dedup and snapshot budget, so an explicit user retry
   * re-sends the page's current candidates instead of reusing the previous
   * attempt's dedup state. Snapshots already in flight from the prior attempt are
   * discarded by the `attemptGeneration` guard in `requestCandidateSnapshot`.
   */
  function startAttempt(entry: Entry) {
    entry.attemptGeneration += 1;
    entry.jobRunning = false;
    entry.seenCandidates.clear();
    entry.snapshotCount = 0;
    backgroundLog("info", "attempt-started", `jobId=${entry.jobId} attempt=${entry.attemptGeneration}`);
    void requestCandidateSnapshot(entry);
  }

  async function requestCandidateSnapshot(entry: Entry) {
    if (!sourceOperationAllowed(entry) || entry.snapshotCount >= MAX_SNAPSHOTS) return;
    entry.snapshotCount += 1;
    const attempt = entry.attemptGeneration;
    try {
      const snapshot = await executeSourceOperation(entry, collectCandidates, [], "collect") as CandidateSnapshot | null;
      if (!sourceOperationAllowed(entry) || entry.attemptGeneration !== attempt) return;
      if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.inputs) ||
        typeof snapshot.documentUrl !== "string" || !isPublicHttpUrl(snapshot.documentUrl) ||
        !Number.isSafeInteger(snapshot.overflow) || snapshot.overflow < 0 ||
        snapshot.inputs.length > MAX_CANDIDATES ||
        snapshot.inputs.some((input) => !input || typeof input !== "object" || typeof input.url !== "string" ||
          input.url.length > MAX_URL_LENGTH || !isPublicHttpUrl(input.url) ||
          (input.contents !== undefined && typeof input.contents !== "string"))) {
        throw new Error("invalid-candidate-snapshot");
      }
      if (!sameDocumentUrl(snapshot.documentUrl, entry.sourceUrl)) {
        invalidateSourceDocument(entry, "snapshot-document-mismatch");
        return;
      }
      backgroundLog("info", "active-tab-op-result", `op=collect tab=${entry.tabId} candidates=${snapshot.inputs.length} overflow=${snapshot.overflow} doc=${snapshot.documentUrl}`);
      forwardCandidates(entry, snapshot);
    } catch (error) {
      if (!sourceOperationAllowed(entry) || entry.attemptGeneration !== attempt) return;
      entry.sourceValid = false;
      setBadge(entry.tabId, true, true);
      sendToJob(entry, "dz.job.binding", makeRequestId("source-snapshot-failed"), { sourceValid: false, code: "source-snapshot-failed" });
      backgroundLog("error", "source-snapshot-failed", `tab=${entry.tabId} ${error instanceof Error ? error.message : "operation-rejected"}`);
    }
  }

  function decodeSourceData(data: string): Uint8Array | null {
    try {
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    } catch { return null; }
  }

  async function dispatchSourceFetch(entry: Entry, message: Message) {
    const method = validSourceMethod(message.method);
    const headers = validSourceHeaders(message.headers);
    backgroundLog("info", "source-fetch-request", `req=${message.requestId} tab=${entry.tabId} method=${method ?? String(message.method)} purpose=${String(message.purpose ?? "unknown")} url=${String(message.url ?? "")}`);
    const reject = (code: string, extra: Record<string, unknown> = {}) => {
      backgroundLog("warn", "source-fetch-rejected", `req=${message.requestId} code=${code}`);
      sendToJob(entry, "dz.job.fetch", message.requestId, {
        sourceType: "dz.source.fetch-complete", ok: false, code, ...extra,
      });
    };
    if (!isPublicHttpUrl(message.url) || !method || !headers) {
      reject("invalid-source-request");
      return;
    }
    let result: SourceFetchResult | null;
    try {
      result = await executeSourceOperation(entry, fetchSource, [{ url: message.url, method, headers }], "fetch") as SourceFetchResult | null;
    } catch {
      reject("source-operation-failed");
      return;
    }
    if (!result) {
      reject("source-invalidated");
      return;
    }
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
      reject("invalid-source-fetch-result");
      return;
    }
    if (!result.ok) {
      const code = typeof result.code === "string" && /^[a-z0-9-]{1,64}$/.test(result.code) ? result.code : "source-fetch-failed";
      reject(code, Number.isInteger(result.status) ? { status: result.status } : {});
      return;
    }
    if (typeof result.data !== "string" || result.data.length === 0 || result.data.length > MAX_SOURCE_DATA_CHARS ||
      typeof result.bytes !== "number" || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > MAX_SOURCE_FETCH_BYTES ||
      typeof result.status !== "number" || !Number.isInteger(result.status) || result.status < 200 || result.status >= 300 || !isPublicHttpUrl(result.url) ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(result.data)) {
      reject("invalid-source-fetch-result");
      return;
    }
    const decoded = decodeSourceData(result.data);
    if (!decoded || decoded.byteLength !== result.bytes) {
      reject("invalid-source-fetch-result");
      return;
    }
    backgroundLog("info", "source-fetch-complete", `req=${message.requestId} tab=${entry.tabId} status=${result.status} bytes=${result.bytes} url=${result.url}`);
    sendToJob(entry, "dz.job.fetch", message.requestId, {
      sourceType: "dz.source.fetch-complete", ok: true, status: result.status, url: result.url, bytes: result.bytes, data: result.data,
    });
  }

  function wire() {
    if (wired || !browserApi) return;
    wired = true;
    void restoreBindings();
    browserApi.action?.onClicked?.addListener?.((tab) => { void createJob(tab); });
    browserApi.tabs?.onRemoved?.addListener?.((tabId) => {
      for (const entry of [...jobs.values()]) {
        if (entry.tabId === tabId || entry.jobTabId === tabId) void removeJob(entry, entry.tabId === tabId ? "source-tab-closed" : "job-tab-closed");
      }
    });
    browserApi.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
      if (typeof changeInfo?.url !== "string") return;
      for (const entry of sourceBindings.values()) if (entry.tabId === tabId && entry.sourceValid && !sameDocumentUrl(changeInfo.url, entry.sourceUrl)) invalidateSourceDocument(entry, "navigation");
    });
    browserApi.permissions?.onRemoved?.addListener?.((removed) => {
      const removedOrigins = new Set((removed?.origins ?? []).map((origin) => origin.replace(/\/\*$/, "")));
      for (const entry of jobs.values()) {
        const revoked = [...entry.grantedOrigins].filter((origin) => removedOrigins.has(origin));
        if (!revoked.length) continue;
        for (const origin of revoked) entry.grantedOrigins.delete(origin);
        backgroundLog("info", "permission-revoked", `jobId=${entry.jobId} origins=${revoked.length}`);
        sendToJob(entry, "dz.job.permission-required", makeRequestId("permission-revoked"), { granted: false, revoked, code: "permission-revoked" });
      }
      void persistBindings();
    });
    browserApi.runtime?.onMessage?.addListener?.((message, sender, sendResponse) => {
      if (!message || typeof message.type !== "string") return;
      if (!requestId(message)) return;
      // Test-only toolbar equivalent: headless browsers cannot click browser
      // chrome, so the E2E driver asks for the same createJob path the
      // toolbar uses. Inert in store packages: the flag is set only by the
      // WXT's test-only build flag, and no webpage can execute here.
      if (message.type === "dezoomify-test-start-job") {
        if (!testGlobals.__DEZOOMIFY_TEST__ || typeof message.tabId !== "number" || !isPublicHttpUrl(message.url)) return;
        void createJob({ id: message.tabId, url: message.url });
        try { sendResponse?.({ ok: true }); } catch {}
        return true;
      }
      if (message.type.startsWith("dz.job.")) {
        backgroundLog("debug", "job-message-received", `type=${message.type} request=${message.requestId} tab=${sender?.tab?.id} frame=${sender?.frameId}`);
        const entry = findJobSender(sender, message);
        if (!entry) {
          backgroundLog("debug", "job-message-rejected", `type=${message.type} tab=${sender?.tab?.id} frame=${sender?.frameId} reason=unknown-sender`);
          return;
        }
        if (message.type === "dz.job.ready") {
          const job = jobs.get(entry.jobId) ?? entry;
          job.jobReady = true;
          backgroundLog("info", "binding-ready", `jobId=${entry.jobId} sourceValid=${entry.sourceValid} tab=${entry.tabId} frame=${entry.frameId} gen=${entry.documentGeneration}`);
          sendToJob(entry, "dz.job.binding", message.requestId, { sourceValid: entry.sourceValid, documentUrl: entry.sourceUrl });
          flushHeldCandidates(job);
          startAttempt(job);
        } else if (message.type === "dz.job.fetch" && entry.sourceValid && entry.jobActive) {
          (jobs.get(entry.jobId) ?? entry).jobRunning = true;
          void dispatchSourceFetch(entry, message);
        } else if (message.type === "dz.job.fetch") {
          backgroundLog("debug", "job-message-rejected", `type=${message.type} request=${message.requestId} reason=inactive-source`);
        } else if (message.type === "dz.job.candidates-more" && entry.sourceValid && entry.jobActive) {
          void requestCandidateSnapshot(entry);
        } else if (message.type === "dz.job.retry" && entry.sourceValid && entry.jobActive) {
          // Explicit user retry of a retryable failure: take one fresh bounded
          // snapshot of the bound source document and start a new attempt.
          backgroundLog("info", "job-retry", `jobId=${entry.jobId} tab=${entry.tabId}`);
          startAttempt(jobs.get(entry.jobId) ?? entry);
        } else if (message.type === "dz.job.retry") {
          backgroundLog("debug", "job-message-rejected", `type=${message.type} reason=inactive-source`);
        } else if (message.type === "dz.job.cancel") {
          backgroundLog("info", "job-cancelled", `jobId=${entry.jobId} tab=${entry.tabId}`);
          entry.jobRunning = false;
          entry.jobActive = false;
          entry.sourceValid = false;
          void persistBindings();
        } else if (message.type === "dz.job.closed") {
          void removeJob(entry, "job-closed");
        } else if (message.type === "dz.job.permission-required") {
          void handlePermission(entry, message);
        }
        try { sendResponse?.({ ok: true }); } catch {}
        return true;
      }
    });
  }

  function startBackground() {
    try { if (browserApi?.action?.onClicked) wire(); } catch (error) { backgroundLog("error", "wire-failed", error instanceof Error ? error.message : error); }
  }

  return {
    BACKGROUND_LOG_MAX_CHARS,
    setBackgroundLogLevel,
    setBackgroundLogSink,
    backgroundLog,
    startBackground,
  };
}

export type BackgroundCoordinator = ReturnType<typeof createBackgroundCoordinator>;
