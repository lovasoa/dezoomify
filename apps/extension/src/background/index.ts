/**
 * Extension background coordinator.
 *
 * It owns toolbar actions, the source-document/job-tab binding, optional-host
 * permission lifetime, and browser sender validation. It intentionally owns
 * neither discovery nor a job loop. Temporary `dz.source.*` / `dz.job.*`
 * envelopes are local compatibility glue pending generated protocol bindings.
 */

const api = globalThis.browser ?? globalThis.chrome;
const STORAGE_KEY = "dezoomify.sourceBindings.v1";
const IDLE_ICON = { 16: "icons/icon16-grey.png", 48: "icons/icon48-grey.png", 128: "icons/icon128-grey.png" };
const ACTIVE_ICON = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
const HELD_CANDIDATE_LIMIT = 64;

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
function sourceRegistrationId(entry) { return `dezoomify-source-${entry.jobId.replace(/[^a-z0-9_-]/gi, "-")}`; }
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
    sourceRegistrationId: entry.sourceRegistrationId ?? null,
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
        sourceActive: false, jobReady: false, jobRunning: false, heldCandidates: [],
        sourceRegistrationId: typeof raw.sourceRegistrationId === "string" ? raw.sourceRegistrationId : null,
        grantedOrigins: new Set(Array.isArray(raw.grantedOrigins) ? raw.grantedOrigins.filter(isPublicHttpUrl) : []),
        primary: raw.primary === true,
      };
      sourceBindings.set(sourceBindingKey(entry), entry);
      if (entry.primary || !jobs.has(entry.jobId)) jobs.set(entry.jobId, entry);
    }
    if (entries.length) backgroundLog("info", "bindings-restored", `${jobs.size} binding(s), no auto-start`);
  } catch (error) { backgroundLog("debug", "storage-read-failed", String(error?.message ?? error)); }
}

function findSourceJob(sender, message) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (typeof tabId !== "number" || typeof frameId !== "number") return null;
  const entry = sourceBindings.get(`${message?.jobId}:${tabId}:${frameId}`);
  return entry?.sourceActive && bindingMatches(message, entry) ? entry : null;
}
function findJobSender(sender, message) {
  const tabId = sender?.tab?.id;
  if (typeof tabId !== "number") return null;
  const job = jobs.get(message?.jobId);
  if (!job || job.jobTabId !== tabId) return null;
  // The first ready notification only proves the job tab owns the opaque id
  // placed in its extension URL. It cannot yet include a source binding.
  if (message?.type === "dz.job.ready") return job;
  const source = sourceBindings.get(`${message.jobId}:${message.tabId}:${message.frameId}`);
  return source && bindingMatches(message, source) ? source : null;
}

async function injectSource(entry) {
  try {
    // Firefox discards programmatically executed content scripts as soon as
    // the invocation returns, including their runtime message listeners.
    // Register a narrow, temporary script and reload once so the collector
    // has a persistent content-script lifetime there. Chromium keeps the
    // direct injection path, which avoids an unnecessary reload.
    if (typeof api?.runtime?.getBrowserInfo === "function" && typeof api?.scripting?.registerContentScripts === "function") {
      const origin = permissionOrigin(entry.sourceUrl);
      if (!origin) throw new Error("source-registration-invalid-url");
      const id = sourceRegistrationId(entry);
      await api.scripting.registerContentScripts([{ id, matches: [`${origin}/*`], js: ["content/modal.js"], allFrames: true, runAt: "document_idle", persistAcrossSessions: false }]);
      entry.sourceRegistrationId = id;
      await persistBindings();
      await api.tabs.reload(entry.tabId);
      backgroundLog("info", "source-registered", `tab ${entry.tabId}`);
      return;
    }
    const injections = await api?.scripting?.executeScript?.({ target: { tabId: entry.tabId, allFrames: true }, files: ["content/modal.js"] });
    const frameIds = new Set([entry.frameId]);
    for (const result of injections ?? []) if (typeof result?.frameId === "number") frameIds.add(result.frameId);
    for (const frameId of frameIds) {
      const bound = frameId === entry.frameId ? entry : {
        ...entry, frameId, sourceActive: true, heldCandidates: [], primary: false,
      };
      sourceBindings.set(sourceBindingKey(bound), bound);
      sendToTab(bound.tabId, { type: "dz.source.bind", ...bindingOf(bound), requestId: makeRequestId("source-bind") }, bound.frameId);
    }
    await persistBindings();
    backgroundLog("info", "source-injected", `tab ${entry.tabId}`);
  } catch (error) {
    entry.sourceActive = false;
    setBadge(entry.tabId, true, true);
    sendToJob(entry, "dz.job.binding", makeRequestId("source-injection-failed"), { sourceValid: false, code: "source-injection-failed" });
    backgroundLog("error", "source-injection-failed", String(error?.message ?? error));
  }
}

function sourceByRegistration(sender) {
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId;
  if (typeof tabId !== "number" || typeof frameId !== "number") return null;
  for (const entry of sourceBindings.values()) {
    if (entry.tabId === tabId && entry.frameId === frameId && entry.sourceActive && entry.sourceRegistrationId) return entry;
  }
  return null;
}

function stopSource(entry, reason) {
  if (!entry.sourceActive) return;
  sendToTab(entry.tabId, { type: "dz.source.stop", ...bindingOf(entry), requestId: makeRequestId("source-stop"), reason }, entry.frameId);
  entry.sourceActive = false;
}
async function removeJob(entry, reason) {
  for (const source of [...sourceBindings.values()]) if (source.jobId === entry.jobId) {
    stopSource(source, reason);
    sourceBindings.delete(sourceBindingKey(source));
  }
  jobs.delete(entry.jobId);
  if (entry.sourceRegistrationId) {
    try { await api?.scripting?.unregisterContentScripts?.({ ids: [entry.sourceRegistrationId] }); } catch {}
  }
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
    if (entry.tabId === tabId && entry.sourceActive) {
      stopSource(entry, "toolbar-cancel");
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
    sourceActive: true, jobReady: false, jobRunning: false, heldCandidates: [], grantedOrigins: new Set(), primary: true,
  };
  jobs.set(jobId, entry);
  sourceBindings.set(sourceBindingKey(entry), entry);
  setBadge(tabId, true);
  await persistBindings();
  backgroundLog("info", "job-created", `source ${tabId}, job ${jobTab.id}`);
  void injectSource(entry);
}

function forwardCandidates(entry, message) {
  const job = jobs.get(entry.jobId) ?? entry;
  const candidate = { requestId: message.requestId, urls: Array.isArray(message.urls) ? message.urls : [], overflow: Number(message.overflow) || 0, documentUrl: message.documentUrl };
  if (job.jobReady) sendToJob(entry, "dz.job.candidates", candidate.requestId, candidate);
  else if (job.heldCandidates.length < HELD_CANDIDATE_LIMIT) job.heldCandidates.push({ entry, candidate });
  sendToTab(entry.tabId, { type: "dz.source.candidates-ack", ...bindingOf(entry), requestId: message.requestId, urls: candidate.urls }, entry.frameId);
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
  const oldBinding = bindingOf(entry);
  entry.documentGeneration += 1;
  entry.sourceActive = false;
  entry.heldCandidates.length = 0;
  sendToTab(entry.tabId, { type: "dz.source.invalidated", ...oldBinding, requestId: makeRequestId("source-invalidated"), reason }, entry.frameId);
  sendToJob(entry, "dz.job.binding", makeRequestId("source-invalidated"), { sourceValid: false, reason });
  void persistBindings();
  backgroundLog("info", "source-invalidated", `tab ${entry.tabId} ${reason}`);
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
    for (const entry of sourceBindings.values()) if (entry.tabId === tabId && entry.sourceActive && !sameDocumentUrl(changeInfo.url, entry.sourceUrl)) invalidateSourceDocument(entry, "navigation");
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
    // The Firefox-only registered collector has no binding on its first
    // message. Its mount acknowledgement is the proof that its persistent
    // listener exists; only then do we disclose and send the binding.
    if (message.type === "dz.source.mounted") {
      const entry = sourceByRegistration(sender);
      if (!entry) return;
      sendToTab(entry.tabId, { type: "dz.source.bind", ...bindingOf(entry), requestId: makeRequestId("source-bind") }, entry.frameId);
      try { sendResponse?.({ ok: true }); } catch {}
      return true;
    }
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
    if (message.type.startsWith("dz.source.")) {
      const entry = findSourceJob(sender, message);
      if (!entry) return;
      if (message.type === "dz.source.ready") {
        sendToJob(entry, "dz.job.binding", message.requestId, { sourceValid: true, documentUrl: message.documentUrl });
        flushHeldCandidates(jobs.get(entry.jobId) ?? entry);
      } else if (message.type === "dz.source.candidates") forwardCandidates(entry, message);
      else if (message.type === "dz.source.fetch-chunk" || message.type === "dz.source.fetch-complete" || message.type === "dz.source.invalidated") {
        const { type: sourceType, ...payload } = message;
        sendToJob(entry, "dz.job.fetch", message.requestId, { sourceType, ...payload });
      }
      try { sendResponse?.({ ok: true }); } catch {}
      return true;
    }
    if (message.type.startsWith("dz.job.")) {
      const entry = findJobSender(sender, message);
      if (!entry) return;
      if (message.type === "dz.job.ready") {
        const job = jobs.get(entry.jobId) ?? entry;
        job.jobReady = true;
        sendToJob(entry, "dz.job.binding", message.requestId, { sourceValid: entry.sourceActive, documentUrl: entry.sourceUrl });
        flushHeldCandidates(job);
      } else if (message.type === "dz.job.fetch" && entry.sourceActive) {
        (jobs.get(entry.jobId) ?? entry).jobRunning = true;
        sendToTab(entry.tabId, { type: "dz.source.fetch", ...bindingOf(entry), requestId: message.requestId, url: message.url, method: message.method, headers: message.headers }, entry.frameId);
      } else if (message.type === "dz.job.cancel") {
        entry.jobRunning = false;
        stopSource(entry, "job-cancel");
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
