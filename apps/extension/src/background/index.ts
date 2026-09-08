/**
 * Extension background coordinator.
 *
 * It owns toolbar actions, the source-document/job-tab binding, optional-host
 * permission lifetime, and browser sender validation. It intentionally owns
 * neither discovery nor a job loop. Temporary `dz.source.*` / `dz.job.*`
 * envelopes are local compatibility glue pending generated protocol bindings.
 */

import { collectCandidates, fetchSource } from "./source-operations.js";

const api = globalThis.browser ?? globalThis.chrome;
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
const MAX_FETCH_CHUNK_BYTES = 32 * 1024;
const MAX_SOURCE_FETCH_BYTES = 8 * 1024 * 1024;

export const BACKGROUND_LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
export const BACKGROUND_LOG_MAX_CHARS = 500;
export const BACKGROUND_SENSITIVE_QUERY_KEYS = Object.freeze([
  "token", "auth", "authorization", "session", "sessionid", "sid", "key", "apikey", "api_key", "secret", "password", "passwd", "code", "state", "sessiontoken",
]);
let backgroundLogLevel = BACKGROUND_LOG_LEVELS.info;
let backgroundLogSink = null;

export function redactBackgroundUrl(raw) {
  if (typeof raw !== "string" || !raw) return "[empty-url]";
  try {
    const url = new URL(raw);
    if (url.username || url.password) { url.username = "***"; url.password = ""; }
    for (const key of [...url.searchParams.keys()]) {
      if (BACKGROUND_SENSITIVE_QUERY_KEYS.includes(key.toLowerCase())) url.searchParams.set(key, "***");
    }
    url.hash = "";
    return url.toString();
  } catch { return "[invalid-url]"; }
}

export function setBackgroundLogLevel(level) {
  if (typeof level === "string" && level in BACKGROUND_LOG_LEVELS) backgroundLogLevel = BACKGROUND_LOG_LEVELS[level];
  else if (typeof level === "number" && Number.isFinite(level)) backgroundLogLevel = level;
}

export function setBackgroundLogSink(sink) { backgroundLogSink = typeof sink === "function" ? sink : null; }

export function backgroundLog(level, code, detail = "") {
  try {
    if ((BACKGROUND_LOG_LEVELS[level] ?? BACKGROUND_LOG_LEVELS.info) < backgroundLogLevel) return;
    const safeCode = typeof code === "string" && code ? code : "event";
    let text = typeof detail === "string" ? detail : String(detail ?? "");
    if (text.length > BACKGROUND_LOG_MAX_CHARS) text = text.slice(0, BACKGROUND_LOG_MAX_CHARS) + "…";
    const entry = { level, code: safeCode, line: `[dezoomify:background] ${level} ${safeCode}${text ? ` ${text}` : ""}` };
    if (backgroundLogSink) { try { backgroundLogSink(entry); } catch {} }
    else { try { globalThis.console?.[level]?.(entry.line); } catch {} }
  } catch {}
}

const jobs = new Map();
const sourceBindings = new Map();
let wired = false;
let restoreStarted = false;
let jobSequence = 0;

function isPublicHttpUrl(value) {
  try { const url = new URL(value); return url.protocol === "http:" || url.protocol === "https:"; } catch { return false; }
}
function permissionOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null;
  } catch { return null; }
}

function sameDocumentUrl(a, b) {
  try {
    const left = new URL(a); const right = new URL(b);
    left.hash = ""; right.hash = "";
    return left.href === right.href;
  } catch { return a === b; }
}
function sourceBindingKey(entry) { return `${entry.jobId}:${entry.tabId}:${entry.frameId}`; }
function bindingOf(entry) {
  return {
    jobId: entry.jobId, tabId: entry.tabId, frameId: entry.frameId,
    documentGeneration: entry.documentGeneration,
  };
}
function bindingMatches(message, entry) {
  const binding = bindingOf(entry);
  return Boolean(message && message.jobId === binding.jobId && message.tabId === binding.tabId &&
    message.frameId === binding.frameId && message.documentGeneration === binding.documentGeneration);
}
function requestId(message) { return typeof message?.requestId === "string" && message.requestId.length > 0 && message.requestId.length <= 200; }
function makeRequestId(prefix) { jobSequence += 1; return `${prefix}-${Date.now().toString(36)}-${jobSequence}`; }
function makeJobId() {
  try { if (globalThis.crypto?.randomUUID) return `job:${globalThis.crypto.randomUUID()}`; } catch {}
  return makeRequestId("job").replace("job-", "job:");
}

function setBadge(tabId, active, failed = false) {
  try {
    const icon = api?.action?.setIcon?.({ tabId, path: active ? ACTIVE_ICON : IDLE_ICON });
    if (icon?.catch) icon.catch(() => {});
    const badge = api?.action?.setBadgeText?.({ tabId, text: active ? (failed ? "!" : "•") : "" });
    if (badge?.catch) badge.catch(() => {});
  } catch {}
}

function sendToTab(tabId, message, frameId) {
  try {
    const options = typeof frameId === "number" ? { frameId } : undefined;
    const pending = options === undefined ? api?.tabs?.sendMessage?.(tabId, message) : api?.tabs?.sendMessage?.(tabId, message, options);
    if (pending?.catch) pending.catch(() => {});
    return pending;
  } catch { return null; }
}
function sendToJob(entry, type, requestIdValue, extra = {}) {
  if (typeof entry.jobTabId !== "number") return null;
  return sendToTab(entry.jobTabId, { type, ...bindingOf(entry), requestId: requestIdValue, ...extra });
}

function serializableEntry(entry) {
  return {
    ...bindingOf(entry), jobTabId: entry.jobTabId, sourceUrl: entry.sourceUrl,
    grantedOrigins: [...entry.grantedOrigins], primary: entry.primary === true,
  };
}
async function persistBindings() {
  try {
    const entries = [...sourceBindings.values()].map(serializableEntry);
    await api?.storage?.session?.set?.({ [STORAGE_KEY]: entries });
  } catch (error) { backgroundLog("debug", "storage-write-failed", String(error?.message ?? error)); }
}
async function restoreBindings() {
  if (restoreStarted) return;
  restoreStarted = true;
  try {
    const stored = await api?.storage?.session?.get?.(STORAGE_KEY);
    const entries = Array.isArray(stored?.[STORAGE_KEY]) ? stored[STORAGE_KEY] : [];
    for (const raw of entries) {
      if (!raw || typeof raw.jobId !== "string" || typeof raw.tabId !== "number" || typeof raw.frameId !== "number" ||
        typeof raw.documentGeneration !== "number" || typeof raw.jobTabId !== "number") continue;
      const entry = {
        jobId: raw.jobId, tabId: raw.tabId, frameId: raw.frameId, documentGeneration: raw.documentGeneration,
        jobTabId: raw.jobTabId, sourceUrl: typeof raw.sourceUrl === "string" ? raw.sourceUrl : "",
        sourceValid: false, jobActive: false, jobReady: false, jobRunning: false, heldCandidates: [],
        seenCandidates: new Set(), snapshotCount: 0,
        grantedOrigins: new Set(Array.isArray(raw.grantedOrigins) ? raw.grantedOrigins.filter(isPublicHttpUrl) : []),
        primary: raw.primary === true,
      };
      sourceBindings.set(sourceBindingKey(entry), entry);
      if (entry.primary || !jobs.has(entry.jobId)) jobs.set(entry.jobId, entry);
    }
    if (entries.length) backgroundLog("info", "bindings-restored", `${jobs.size} binding(s), no auto-start`);
  } catch (error) { backgroundLog("debug", "storage-read-failed", String(error?.message ?? error)); }
}

function findJobSender(sender, message) {
  const tabId = sender?.tab?.id;
  const senderFrameId = sender?.frameId;
  if (typeof tabId !== "number" || typeof senderFrameId !== "number") return null;
  const job = jobs.get(message?.jobId);
  if (!job || job.jobTabId !== tabId) return null;
  // The first ready notification only proves the job tab owns the opaque id
  // placed in its extension URL. It cannot yet include a source binding.
  if (message?.type === "dz.job.ready") return senderFrameId === 0 ? job : null;
  const source = sourceBindings.get(`${message.jobId}:${message.tabId}:${message.frameId}`);
  return source && senderFrameId === source.frameId && bindingMatches(message, source) ? source : null;
}

async function removeJob(entry, reason) {
  for (const source of [...sourceBindings.values()]) if (source.jobId === entry.jobId) {
    sourceBindings.delete(sourceBindingKey(source));
  }
  jobs.delete(entry.jobId);
  setBadge(entry.tabId, false);
  await persistBindings();
  backgroundLog("info", "job-removed", `${entry.jobId} ${reason}`);
}

async function createJob(tab) {
  const tabId = tab?.id;
  if (typeof tabId !== "number" || !isPublicHttpUrl(tab?.url)) {
    backgroundLog("warn", "privileged-rejected", redactBackgroundUrl(tab?.url));
    return;
  }
  for (const entry of jobs.values()) {
    if (entry.tabId === tabId && entry.jobRunning && typeof entry.jobTabId === "number") {
      try { await api?.tabs?.update?.(entry.jobTabId, { active: true }); } catch {}
      return;
    }
    if (entry.tabId === tabId && entry.jobActive) {
      entry.jobActive = false;
      entry.sourceValid = false;
      sendToJob(entry, "dz.job.cancel", makeRequestId("toolbar-cancel"), { reason: "toolbar-cancel" });
      setBadge(tabId, false);
      await persistBindings();
      return;
    }
    if (entry.tabId === tabId && entry.jobReady && typeof entry.jobTabId === "number") {
      try { await api?.tabs?.update?.(entry.jobTabId, { active: true }); } catch {}
      return;
    }
  }
  const jobId = makeJobId();
  let jobTab;
  try {
    jobTab = await api?.tabs?.create?.({ url: api?.runtime?.getURL?.(`job/job.html#jobId=${encodeURIComponent(jobId)}`), active: true });
  } catch (error) {
    backgroundLog("error", "job-tab-create-failed", String(error?.message ?? error));
    return;
  }
  if (typeof jobTab?.id !== "number") {
    backgroundLog("error", "job-tab-create-failed", "missing tab id");
    return;
  }
  const entry = {
    jobId, tabId, frameId: 0, documentGeneration: 0, jobTabId: jobTab.id, sourceUrl: tab.url,
    sourceValid: true, jobActive: true, jobReady: false, jobRunning: false, heldCandidates: [],
    seenCandidates: new Set(), snapshotCount: 0, grantedOrigins: new Set(), primary: true,
  };
  jobs.set(jobId, entry);
  sourceBindings.set(sourceBindingKey(entry), entry);
  setBadge(tabId, true);
  await persistBindings();
  backgroundLog("info", "job-created", `source ${tabId}, job ${jobTab.id}`);
}

function validSourceHeaders(headers) {
  if (!Array.isArray(headers) || headers.length > MAX_HEADER_COUNT) return null;
  const result = [];
  for (const header of headers) {
    if (!header || typeof header.name !== "string" || typeof header.value !== "string" ||
      header.name.length === 0 || header.name.length > MAX_HEADER_NAME_LENGTH || header.value.length > MAX_HEADER_VALUE_LENGTH ||
      /[\r\n]/.test(header.name) || /[\r\n]/.test(header.value)) return null;
    result.push({ name: header.name, value: header.value });
  }
  return result;
}

function validSourceMethod(method) {
  if (method === undefined) return "GET";
  if (typeof method !== "string" || method.length === 0 || method.length > 16 || !/^[A-Za-z]+$/.test(method)) return null;
  const normalized = method.toUpperCase();
  return ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(normalized) ? normalized : null;
}

function sourceOperationAllowed(entry) {
  return entry?.jobActive === true && entry.sourceValid === true && isPublicHttpUrl(entry.sourceUrl) &&
    sourceBindings.get(sourceBindingKey(entry)) === entry;
}

async function executeSourceOperation(entry, func, args = []) {
  if (!sourceOperationAllowed(entry)) return null;
  const generation = entry.documentGeneration;
  const results = await api?.scripting?.executeScript?.({
    target: { tabId: entry.tabId, frameIds: [entry.frameId] },
    func,
    args,
  });
  if (!sourceOperationAllowed(entry) || entry.documentGeneration !== generation) return null;
  if (!Array.isArray(results) || results.length !== 1 || results[0]?.frameId !== entry.frameId) throw new Error("invalid-source-operation-result");
  return results[0].result;
}

function forwardCandidates(entry, snapshot) {
  const job = jobs.get(entry.jobId) ?? entry;
  const urls = [];
  for (const url of snapshot.urls) {
    if (entry.seenCandidates.has(url)) continue;
    entry.seenCandidates.add(url);
    urls.push(url);
  }
  const candidate = { requestId: makeRequestId("candidates"), urls, overflow: snapshot.overflow, documentUrl: snapshot.documentUrl };
  if (!urls.length && !candidate.overflow) return;
  if (job.jobReady) sendToJob(entry, "dz.job.candidates", candidate.requestId, candidate);
  else if (job.heldCandidates.length < HELD_CANDIDATE_LIMIT) job.heldCandidates.push({ entry, candidate });
}
function flushHeldCandidates(entry) {
  while (entry.jobReady && entry.heldCandidates.length) {
    const held = entry.heldCandidates.shift();
    sendToJob(held.entry, "dz.job.candidates", held.candidate.requestId, held.candidate);
  }
}

async function handlePermission(entry, message) {
  const origins = Array.isArray(message.origins)
    ? [...new Set(message.origins.map(permissionOrigin).filter(Boolean))]
    : [];
  if (!origins.length) return sendToJob(entry, "dz.job.permission-required", message.requestId, { granted: false, code: "invalid-origins" });
  let granted = false;
  try { granted = Boolean(await api?.permissions?.request?.({ origins: origins.map((origin) => `${origin}/*`) })); } catch {}
  if (granted) for (const origin of origins) entry.grantedOrigins.add(origin);
  await persistBindings();
  sendToJob(entry, "dz.job.permission-required", message.requestId, { granted, origins });
}

function invalidateSourceDocument(entry, reason) {
  entry.documentGeneration += 1;
  entry.sourceValid = false;
  entry.jobActive = false;
  entry.heldCandidates.length = 0;
  sendToJob(entry, "dz.job.binding", makeRequestId("source-invalidated"), { sourceValid: false, reason });
  void persistBindings();
  backgroundLog("info", "source-invalidated", `tab ${entry.tabId} ${reason}`);
}

async function requestCandidateSnapshot(entry) {
  if (!sourceOperationAllowed(entry) || entry.snapshotCount >= MAX_SNAPSHOTS) return;
  entry.snapshotCount += 1;
  try {
    const snapshot = await executeSourceOperation(entry, collectCandidates);
    if (!snapshot || snapshot.ok !== true || !Array.isArray(snapshot.urls) ||
      typeof snapshot.documentUrl !== "string" || !isPublicHttpUrl(snapshot.documentUrl) ||
      !Number.isSafeInteger(snapshot.overflow) || snapshot.overflow < 0 ||
      snapshot.urls.length > MAX_CANDIDATES ||
      snapshot.urls.some((url) => typeof url !== "string" || url.length > MAX_URL_LENGTH || !isPublicHttpUrl(url))) {
      throw new Error("invalid-candidate-snapshot");
    }
    if (!sameDocumentUrl(snapshot.documentUrl, entry.sourceUrl)) {
      invalidateSourceDocument(entry, "snapshot-document-mismatch");
      return;
    }
    forwardCandidates(entry, snapshot);
  } catch (error) {
    if (!sourceOperationAllowed(entry)) return;
    entry.sourceValid = false;
    setBadge(entry.tabId, true, true);
    sendToJob(entry, "dz.job.binding", makeRequestId("source-snapshot-failed"), { sourceValid: false, code: "source-snapshot-failed" });
    backgroundLog("error", "source-snapshot-failed", "operation-rejected");
  }
}

async function dispatchSourceFetch(entry, message) {
  const method = validSourceMethod(message.method);
  const headers = validSourceHeaders(message.headers);
  if (!isPublicHttpUrl(message.url) || !method || !headers) {
    sendToJob(entry, "dz.job.fetch", message.requestId, {
      sourceType: "dz.source.fetch-complete", ok: false, code: "invalid-source-request",
    });
    return;
  }
  let result;
  try {
    result = await executeSourceOperation(entry, fetchSource, [{ url: message.url, method, headers }]);
  } catch {
    sendToJob(entry, "dz.job.fetch", message.requestId, {
      sourceType: "dz.source.fetch-complete", ok: false, code: "source-operation-failed",
    });
    return;
  }
  if (!result) {
    sendToJob(entry, "dz.job.fetch", message.requestId, {
      sourceType: "dz.source.fetch-complete", ok: false, code: "source-invalidated",
    });
    return;
  }
  if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
    sendToJob(entry, "dz.job.fetch", message.requestId, {
      sourceType: "dz.source.fetch-complete", ok: false, code: "invalid-source-fetch-result",
    });
    return;
  }
  if (!result.ok) {
    const code = typeof result.code === "string" && /^[a-z0-9-]{1,64}$/.test(result.code) ? result.code : "source-fetch-failed";
    sendToJob(entry, "dz.job.fetch", message.requestId, {
      sourceType: "dz.source.fetch-complete", ok: false, code, ...(Number.isInteger(result.status) ? { status: result.status } : {}),
    });
    return;
  }
  const chunkBytes = result.chunks?.reduce?.((sum, chunk) => sum + (Array.isArray(chunk?.bytes) ? chunk.bytes.length : MAX_SOURCE_FETCH_BYTES + 1), 0);
  if (!Array.isArray(result.chunks) || !Number.isSafeInteger(result.bytes) || result.bytes < 0 || result.bytes > MAX_SOURCE_FETCH_BYTES ||
    !Number.isInteger(result.status) || result.status < 200 || result.status >= 300 || !isPublicHttpUrl(result.url) ||
    chunkBytes !== result.bytes || chunkBytes > MAX_SOURCE_FETCH_BYTES ||
    result.chunks.some((chunk) => !chunk || !Number.isSafeInteger(chunk.sequence) || chunk.sequence < 0 ||
      !Array.isArray(chunk.bytes) || chunk.bytes.length > MAX_FETCH_CHUNK_BYTES ||
      chunk.bytes.some((value) => !Number.isInteger(value) || value < 0 || value > 255))) {
    sendToJob(entry, "dz.job.fetch", message.requestId, {
      sourceType: "dz.source.fetch-complete", ok: false, code: "invalid-source-fetch-result",
    });
    return;
  }
  for (const chunk of result.chunks) {
    sendToJob(entry, "dz.job.fetch", message.requestId, {
      sourceType: "dz.source.fetch-chunk", sequence: chunk.sequence, bytes: chunk.bytes,
    });
  }
  sendToJob(entry, "dz.job.fetch", message.requestId, {
    sourceType: "dz.source.fetch-complete", ok: true, status: result.status, url: result.url, bytes: result.bytes,
  });
}

function wire() {
  if (wired || !api) return;
  wired = true;
  void restoreBindings();
  api.action?.onClicked?.addListener?.((tab) => { void createJob(tab); });
  api.tabs?.onRemoved?.addListener?.((tabId) => {
    for (const entry of [...jobs.values()]) {
      if (entry.tabId === tabId || entry.jobTabId === tabId) void removeJob(entry, entry.tabId === tabId ? "source-tab-closed" : "job-tab-closed");
    }
  });
  api.tabs?.onUpdated?.addListener?.((tabId, changeInfo) => {
    if (typeof changeInfo?.url !== "string") return;
    for (const entry of sourceBindings.values()) if (entry.tabId === tabId && entry.sourceValid && !sameDocumentUrl(changeInfo.url, entry.sourceUrl)) invalidateSourceDocument(entry, "navigation");
  });
  api.permissions?.onRemoved?.addListener?.((removed) => {
    const removedOrigins = new Set((removed?.origins ?? []).map((origin) => origin.replace(/\/\*$/, "")));
    for (const entry of jobs.values()) {
      const revoked = [...entry.grantedOrigins].filter((origin) => removedOrigins.has(origin));
      if (!revoked.length) continue;
      for (const origin of revoked) entry.grantedOrigins.delete(origin);
      sendToJob(entry, "dz.job.permission-required", makeRequestId("permission-revoked"), { granted: false, revoked, code: "permission-revoked" });
    }
    void persistBindings();
  });
  api.runtime?.onMessage?.addListener?.((message, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return;
    if (!requestId(message)) return;
    // Test-only toolbar equivalent: headless browsers cannot click browser
    // chrome, so the E2E driver asks for the same createJob path the
    // toolbar uses. Inert in store packages: the flag is set only by the
    // test-driver block that package-store.sh appends under
    // DEZOOMIFY_TEST_DRIVER=1, and no webpage can execute here.
    if (message.type === "dezoomify-test-start-job") {
      if (!globalThis.__DEZOOMIFY_TEST__ || typeof message.tabId !== "number" || !isPublicHttpUrl(message.url)) return;
      void createJob({ id: message.tabId, url: message.url });
      try { sendResponse?.({ ok: true }); } catch {}
      return true;
    }
    if (message.type.startsWith("dz.job.")) {
      const entry = findJobSender(sender, message);
      if (!entry) return;
      if (message.type === "dz.job.ready") {
        const job = jobs.get(entry.jobId) ?? entry;
        job.jobReady = true;
        sendToJob(entry, "dz.job.binding", message.requestId, { sourceValid: entry.sourceValid, documentUrl: entry.sourceUrl });
        flushHeldCandidates(job);
        void requestCandidateSnapshot(entry);
      } else if (message.type === "dz.job.fetch" && entry.sourceValid && entry.jobActive) {
        (jobs.get(entry.jobId) ?? entry).jobRunning = true;
        void dispatchSourceFetch(entry, message);
      } else if (message.type === "dz.job.candidates-more" && entry.sourceValid && entry.jobActive) {
        void requestCandidateSnapshot(entry);
      } else if (message.type === "dz.job.cancel") {
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

try { if (api?.action?.onClicked) wire(); } catch (error) { backgroundLog("error", "wire-failed", String(error?.message ?? error)); }
