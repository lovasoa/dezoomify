/**
 * Explicit-action source-tab collector.
 *
 * This is deliberately not a UI and never creates an iframe or uses
 * `window.postMessage`. The background coordinator binds this script to one
 * source document after opening the dedicated extension job tab. Discovery
 * stays in the source document because its performance timeline and its
 * session-aware fetches belong to that document.
 *
 * The temporary `dz.source.*` envelopes are kept here until generated
 * protocol bindings replace them. Every outbound envelope after binding
 * includes the complete binding and a request id. Acknowledgements remove
 * queued URLs, so a busy first hundred requests cannot make later discovery
 * permanently invisible.
 */

export const MAX_URL_LENGTH = 2048;
export const MAX_PENDING_CANDIDATES = 64;
export const MAX_RECENT_CANDIDATES = 256;
export const MAX_CANDIDATE_CHUNK = 16;
export const MAX_FETCH_CHUNK_BYTES = 32 * 1024;
export const MAX_SOURCE_FETCH_BYTES = 8 * 1024 * 1024;

export function isSourceCandidateUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) return false;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/** Retained as a small pure helper for callers that seed a timeline. */
export function collectInTabUrls(entries) {
  const urls = [];
  const seen = new Set();
  for (const entry of Array.from(entries ?? [])) {
    const url = typeof entry === "string" ? entry : entry?.name;
    if (!isSourceCandidateUrl(url) || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  return urls;
}

function bindingMatches(message, binding) {
  return Boolean(
    message && binding &&
    message.jobId === binding.jobId &&
    message.tabId === binding.tabId &&
    message.frameId === binding.frameId &&
    message.documentGeneration === binding.documentGeneration,
  );
}

function newRequestId(deps, prefix) {
  try {
    const crypto = deps.crypto ?? deps.window?.crypto;
    if (crypto?.randomUUID) return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    // The monotonic fallback below is sufficient correlation within this tab.
  }
  deps.requestSequence.value += 1;
  return `${prefix}-${Date.now().toString(36)}-${deps.requestSequence.value}`;
}

/**
 * Creates a source-only collector. The coordinator supplies a binding via
 * `dz.source.bind` (a temporary bootstrap envelope); all operational traffic
 * uses the v1 `dz.source.*` envelopes supplied by the coordinator contract.
 */
export function createSourceCollector(deps) {
  const win = deps.window;
  const chromeApi = deps.chromeApi ?? win?.chrome ?? win?.browser ?? null;
  const perf = deps.performance ?? win?.performance ?? null;
  const Observer = deps.PerformanceObserver ?? win?.PerformanceObserver ?? null;
  const requestDeps = { ...deps, requestSequence: { value: 0 } };
  const pending = [];
  const pendingSet = new Set();
  const recent = new Map();
  const outstanding = new Map();
  const fetches = new Map();
  let binding = null;
  let observer = null;
  let runtimeListener = null;
  let mounted = false;
  let stopped = false;
  let overflow = 0;

  function send(message) {
    try {
      const result = chromeApi?.runtime?.sendMessage?.(message);
      if (result?.catch) result.catch(() => {});
      return result;
    } catch {
      return null;
    }
  }

  function envelope(type, requestId, extra = {}) {
    return { type, ...binding, requestId, ...extra };
  }

  function remember(url) {
    recent.delete(url);
    recent.set(url, true);
    while (recent.size > MAX_RECENT_CANDIDATES) recent.delete(recent.keys().next().value);
  }

  function seedPending(urls) {
    let added = 0;
    for (const url of urls) {
      if (recent.has(url) || pendingSet.has(url)) continue;
      if (pending.length >= MAX_PENDING_CANDIDATES) {
        overflow += 1;
        continue;
      }
      pending.push(url);
      pendingSet.add(url);
      added += 1;
    }
    return added;
  }

  function addCandidates(entries) {
    if (!binding || stopped) return 0;
    const added = seedPending(collectInTabUrls(entries));
    flushCandidates();
    return added;
  }

  function flushCandidates() {
    if (!binding || stopped || outstanding.size > 0 || pending.length === 0) return;
    const urls = pending.slice(0, MAX_CANDIDATE_CHUNK);
    const requestId = newRequestId(requestDeps, "candidates");
    outstanding.set(requestId, urls);
    send(envelope("dz.source.candidates", requestId, {
      urls,
      overflow,
      documentUrl: String(win?.location?.href ?? ""),
    }));
    overflow = 0;
  }

  function acknowledge(message) {
    if (!bindingMatches(message, binding) || typeof message.requestId !== "string") return false;
    const urls = outstanding.get(message.requestId);
    if (!urls) return false;
    outstanding.delete(message.requestId);
    const accepted = new Set(Array.isArray(message.urls) ? message.urls : urls);
    for (const url of urls) {
      const index = pending.indexOf(url);
      if (index >= 0) pending.splice(index, 1);
      pendingSet.delete(url);
      if (accepted.has(url)) remember(url);
    }
    // A full timing buffer may contain more URLs than the bounded pending
    // queue. Re-read it only after space is released; this turns overflow
    // into a diagnostic, not permanent discovery blindness.
    seedTimeline();
    flushCandidates();
    return true;
  }

  async function sourceFetch(message) {
    if (!bindingMatches(message, binding) || typeof message.requestId !== "string") return;
    if (!isSourceCandidateUrl(message.url) || fetches.has(message.requestId)) return;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    fetches.set(message.requestId, controller);
    try {
      const response = await fetch(message.url, {
        method: message.method === "POST" ? "POST" : "GET",
        headers: message.headers && typeof message.headers === "object" ? message.headers : undefined,
        credentials: "include",
        signal: controller?.signal,
      });
      const headers = {};
      try { response.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; }); } catch {}
      let total = 0;
      let sequence = 0;
      const reader = response.body?.getReader?.();
      if (reader) {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          const value = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value ?? []);
          total += value.byteLength;
          if (total > MAX_SOURCE_FETCH_BYTES) throw Object.assign(new Error("source response exceeds limit"), { code: "too-large" });
          for (let at = 0; at < value.byteLength; at += MAX_FETCH_CHUNK_BYTES) {
            send(envelope("dz.source.fetch-chunk", message.requestId, {
              sequence: sequence++, bytes: Array.from(value.subarray(at, at + MAX_FETCH_CHUNK_BYTES)),
            }));
          }
        }
      } else {
        const value = new Uint8Array(await response.arrayBuffer());
        total = value.byteLength;
        if (total > MAX_SOURCE_FETCH_BYTES) throw Object.assign(new Error("source response exceeds limit"), { code: "too-large" });
        for (let at = 0; at < value.byteLength; at += MAX_FETCH_CHUNK_BYTES) {
          send(envelope("dz.source.fetch-chunk", message.requestId, {
            sequence: sequence++, bytes: Array.from(value.subarray(at, at + MAX_FETCH_CHUNK_BYTES)),
          }));
        }
      }
      send(envelope("dz.source.fetch-complete", message.requestId, {
        ok: response.ok, status: response.status, url: response.url || message.url, headers, bytes: total,
      }));
    } catch (error) {
      send(envelope("dz.source.fetch-complete", message.requestId, {
        ok: false,
        code: String(error?.code ?? (error?.name === "AbortError" ? "cancelled" : "source-fetch-failed")),
      }));
    } finally {
      fetches.delete(message.requestId);
    }
  }

  function stop(reason, notify) {
    if (stopped) return;
    stopped = true;
    try { observer?.disconnect?.(); } catch {}
    observer = null;
    for (const controller of fetches.values()) {
      try { controller?.abort?.(); } catch {}
    }
    fetches.clear();
    pending.length = 0;
    pendingSet.clear();
    outstanding.clear();
    if (notify && binding) send(envelope("dz.source.invalidated", newRequestId(requestDeps, "invalidated"), { reason }));
  }

  function seedTimeline() {
    // The main document is not a resource timing entry, so it is always an
    // explicit input. Child frames run their own copy with their own frame id.
    // Both the document and the retained resource entries seed ONE batch:
    // flushing the document URL alone would make a downstream host commit to
    // the page itself before the viewer traffic arrives.
    seedPending([String(win?.location?.href ?? "")]);
    try { seedPending(collectInTabUrls(perf?.getEntriesByType?.("resource") ?? [])); } catch {}
    flushCandidates();
  }

  function observe() {
    seedTimeline();
    try {
      if (typeof Observer !== "function") return;
      observer = new Observer((list) => {
        try { addCandidates(list?.getEntries?.() ?? []); } catch {}
      });
      observer?.observe?.({ type: "resource", buffered: true });
    } catch { observer = null; }
  }

  function bind(message) {
    if (!message || typeof message.jobId !== "string" || typeof message.tabId !== "number" ||
      typeof message.frameId !== "number" || typeof message.documentGeneration !== "number" ||
      typeof message.requestId !== "string") return false;
    // A stopped singleton remains in the document after cancellation. Reuse
    // it only then; a live collector never accepts a delayed competing bind.
    if (binding && !bindingMatches(message, binding) && !stopped) return false;
    binding = {
      jobId: message.jobId, tabId: message.tabId, frameId: message.frameId,
      documentGeneration: message.documentGeneration,
    };
    stopped = false;
    send(envelope("dz.source.ready", message.requestId, { documentUrl: String(win?.location?.href ?? "") }));
    observe();
    return true;
  }

  function onMessage(message) {
    if (!mounted || !message || typeof message.type !== "string") return;
    if (message.type === "dz.source.bind") bind(message);
    else if (message.type === "dz.source.candidates-ack") acknowledge(message);
    else if (message.type === "dz.source.fetch") void sourceFetch(message);
    else if (message.type === "dz.source.stop" && bindingMatches(message, binding)) stop("coordinator-stop", false);
    else if (message.type === "dz.source.invalidated" && bindingMatches(message, binding)) stop("document-invalidated", false);
  }

  function mount() {
    if (mounted) return false;
    mounted = true;
    runtimeListener = onMessage;
    try { chromeApi?.runtime?.onMessage?.addListener?.(runtimeListener); } catch {}
    return true;
  }

  function dispose() {
    stop("dispose", false);
    try { chromeApi?.runtime?.onMessage?.removeListener?.(runtimeListener); } catch {}
    runtimeListener = null;
  }

  return {
    mount, dispose, onMessage, addCandidates, flushCandidates,
    get binding() { return binding && { ...binding }; },
    get pendingCount() { return pending.length; },
    get mounted() { return mounted; },
  };
}

// The entrypoint itself owns the sole global guard. `mount()` does not read
// or set it, avoiding the old bootstrap-before-mount double-guard bug.
try {
  const g = typeof globalThis === "undefined" ? null : globalThis;
  const api = g?.browser ?? g?.chrome;
  if (g && !g.__dezoomifySourceMounted && api?.runtime && typeof document !== "undefined" && typeof window !== "undefined") {
    const collector = createSourceCollector({ document, window, chromeApi: api, performance: window.performance, PerformanceObserver: window.PerformanceObserver, crypto: window.crypto });
    if (collector.mount()) {
      g.__dezoomifySourceMounted = collector;
      // A registered Firefox content script starts without a binding. This
      // acknowledgement lets the coordinator bind only after its persistent
      // runtime listener is live.
      try { api.runtime.sendMessage({ type: "dz.source.mounted" }); } catch {}
    }
  }
} catch {
  // A hostile document must never make injection fail noisily.
}
