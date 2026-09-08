/**
 * In-tab modal factory (click-to-monitor).
 *
 * Shipped as `content/modal.js` (export-stripped classic script) and injected
 * programmatically by the background via `scripting.executeScript` on exactly
 * the clicked tab (activeTab grant), after the monitored reload completes;
 * styles come from `content/modal.css` via `scripting.insertCSS`. Never
 * declared in the manifest (no `content_scripts`), never runs without that
 * explicit click.
 *
 * Two phases in the SAME tab, never a new tab:
 * - Monitoring: a status card (`#dezoomify-in-tab`, "Monitoring this tab…")
 *   and dismiss paths (Escape, Stop, background `dezoomify-stop-monitor`
 *   on `runtime.onMessage`, wired at mount) that notify the background
 *   (`dezoomify-modal-closed`) so it disarms and restores the grey icon.
 *   Candidates come from the tab's own performance timeline (no permission
 *   needed); a hidden probe iframe is mounted alongside the card on mount
 *   and byte-confirms each candidate via the wasm `DiscoverySession`
 *   (actual response bytes, never URL text).
 * - Job: only after the probe reports `dz-byte-confirmed` (an image was
 *   found in bytes) is the card replaced by the visible Shadow-DOM host
 *   (`#dezoomify-modal-host`) holding the `chrome.runtime.getURL` iframe
 *   (`modal/modal.html`). The loader notifies the background
 *   (`dezoomify-byte-confirmed`) so URL collection stops. A blocked iframe
 *   reports a visible failure in the clicked tab if the job iframe is blocked.
 *
 * Candidate rules mirror `runtime/candidates.ts` (`validateCandidateUrl`):
 * http/https only, bounded length. Format recognition stays the core's job
 * (bytes via DiscoverySession); URL text alone is never detection: many
 * formats require response bytes to be recognized.
 *
 * Plain JavaScript + JSDoc, import-free classic script: `export` is used
 * only so node unit tests can load it via a data: URL; `package-store.sh`
 * strips the `export` prefix for the classic shipped copy. Top-level wiring
 * is guarded so importing under node has no browser effects.
 */

export const MAX_CANDIDATES = 100;
export const MAX_URL_LENGTH = 2048;

/**
 * Candidate URL rule for in-tab collection.
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isInTabCandidateUrl(raw) {
  if (typeof raw !== "string" || raw.length === 0) return false;
  if (raw.length > MAX_URL_LENGTH) return false;
  return raw.startsWith("http://") || raw.startsWith("https://");
}

/**
 * Filter raw resource names to bounded first-seen candidate URLs.
 * Pure (entries are injected by the caller) for unit tests.
 * @param {ArrayLike<unknown> | unknown[]} entries raw `name` values or entries with `.name`
 * @returns {string[]} deduplicated http(s) URLs, first-seen order, capped
 */
export function collectInTabUrls(entries) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(entries) ? entries : Array.from(entries ?? []);
  for (const entry of list) {
    const name = typeof entry === "string" ? entry : entry && entry.name;
    if (!isInTabCandidateUrl(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

/**
 * Create the in-tab modal. All host effects are injected for tests.
 * @param {{
 *   document: any,
 *   window: any,
 *   chromeApi?: any,
 *   performance?: any,
 *   PerformanceObserver?: any,
 *   setTimeout?: typeof setTimeout,
 *   clearTimeout?: typeof clearTimeout,
 *   crypto?: any,
 * }} deps
 */
export function createInTabModal(deps) {
  const doc = deps.document;
  const win = deps.window;
  const chromeApi = deps.chromeApi ?? (win && (win.chrome ?? win.browser)) ?? null;
  const timerSet = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const timerClear = deps.clearTimeout ?? ((handle) => clearTimeout(handle));

  /** @type {string[]} */
  const candidates = [];
  const seen = new Set();
  /** @type {any} */
  let host = null;
  /** @type {any} */
  let jobHost = null;
  /** @type {any} */
  let frame = null;
  /** @type {any} */
  let statusEl = null;
  /** @type {string|null} */
  let token = null;
  /** @type {any} */
  let observer = null;
  /** @type {any} */
  let readyTimer = null;
  /** @type {((message: any) => void) | null} */
  let runtimeListener = null;
  let mounted = false;
  let jobPhase = false;
  let byteConfirmed = false;

  function addCandidates(urls) {
    for (const url of urls ?? []) {
      if (!isInTabCandidateUrl(url)) continue;
      if (seen.has(url)) continue;
      if (candidates.length >= MAX_CANDIDATES) break;
      seen.add(url);
      candidates.push(url);
    }
  }

  function snapshotCandidates() {
    return [...candidates];
  }

  function makeToken() {
    try {
      const bytes = deps.crypto ?? (win && win.crypto) ?? null;
      if (bytes && typeof bytes.getRandomValues === "function") {
        const buf = new Uint8Array(16);
        bytes.getRandomValues(buf);
        return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
      }
    } catch {
      // Fall through to the Math.random fallback below.
    }
    return "t" + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }

  function frameUrl() {
    const base = chromeApi && chromeApi.runtime && typeof chromeApi.runtime.getURL === "function"
      ? chromeApi.runtime.getURL("modal/modal.html")
      : "modal/modal.html";
    return base + "#token=" + encodeURIComponent(token ?? "");
  }

  function notifyBackground(message) {
    try {
      if (chromeApi && chromeApi.runtime && typeof chromeApi.runtime.sendMessage === "function") {
        const reply = chromeApi.runtime.sendMessage({ ...(message ?? {}) });
        if (reply && typeof reply.catch === "function") reply.catch(() => {});
        return reply;
      }
    } catch {
      // Background unreachable; the in-tab candidates still work.
    }
    return null;
  }

  function setStatus(text) {
    try {
      if (statusEl) statusEl.textContent = text;
    } catch {
      // Status paint must never throw.
    }
  }

  function showStartupFailure(message) {
    if (!mounted) return;
    try {
      if (observer && typeof observer.disconnect === "function") observer.disconnect();
    } catch {
      // Failure presentation must not be blocked by observer cleanup.
    }
    observer = null;
    try {
      if (host && host.dataset) host.dataset.state = "error";
    } catch {
      // Dataset is cosmetic only.
    }
    setStatus("Dezoomify could not start: " + message + " Close this message and try again.");
    notifyBackground({
      type: "dezoomify-modal-failed",
      code: "modal-start-failed",
      detail: message,
    });
  }

  function forwardToFrame() {
    // Best-effort live forward: the probe iframe re-reads the snapshot on
    // its own handshake, and the modal iframe accepts repeat
    // `dz-modal-candidates` posts at any time.
    try {
      if (frame && frame.contentWindow && token) {
        frame.contentWindow.postMessage(
          { kind: "dz-modal-candidates", token, urls: snapshotCandidates() },
          "*",
        );
      }
    } catch {
      // Frame not ready yet; the handshake delivers the snapshot.
    }
  }

  function onMessage(message) {
    if (!mounted) return;
    if (!message || typeof message.type !== "string") return;
    if (message.type === "dezoomify-monitor-update") {
      if (Array.isArray(message.urls)) addCandidates(message.urls);
      const seenCount = Number(message.seen);
      setStatus(Number.isFinite(seenCount) && seenCount > 0
        ? "Monitoring this tab… " + seenCount + " image request(s) seen."
        : "Monitoring this tab for zoomable images…");
      forwardToFrame();
    } else if (message.type === "dezoomify-stop-monitor") {
      detach("background-stop");
    } else if (message.type === "dezoomify-detected") {
      // Legacy snapshot message (pre-byte-confirmation backgrounds): treat
      // as candidates only, never as detection. The probe iframe confirms
      // from bytes before the job UI is revealed.
      if (Array.isArray(message.urls)) addCandidates(message.urls);
      forwardToFrame();
    }
  }

  function onWindowMessage(event) {
    if (!mounted) return;
    const data = event && event.data;
    if (!data || typeof data !== "object") return;
    if (data.token !== token) return;
    if (data.kind === "dz-modal-ready" && event.source) {
      if (readyTimer !== null) {
        try {
          timerClear(readyTimer);
        } catch {
          // Timer cleanup must never throw.
        }
        readyTimer = null;
      }
      try {
        event.source.postMessage(
          { kind: "dz-modal-candidates", token, urls: snapshotCandidates() },
          event.origin,
        );
      } catch {
        // Frame vanished mid-handshake; close cleans up below.
      }
      return;
    }
    if (data.kind === "dz-byte-confirmed") {
      // Probe byte-confirmed an image from response bytes (never URL text).
      // Reveal the job UI and stop background collection.
      if (byteConfirmed) return;
      byteConfirmed = true;
      revealJobPhase();
      notifyBackground({ type: "dezoomify-byte-confirmed" });
      return;
    }
    if (data.kind === "dz-modal-error") {
      // Keep the failed job iframe visible. Never silently collapse back to a
      // grey icon when the in-browser job has a user-visible error.
      revealJobPhase();
      notifyBackground({
        type: "dezoomify-modal-failed",
        code: typeof data.code === "string" ? data.code : "job-failed",
        detail: typeof data.message === "string" ? data.message : "image job failed",
      });
      return;
    }
    if (data.kind === "dz-modal-close") {
      detach("frame");
    }
  }

  function onKeyDown(event) {
    if (!mounted) return;
    if (event && event.key === "Escape") {
      if (typeof event.preventDefault === "function") event.preventDefault();
      detach("escape");
      return;
    }
    // Focus trap for the monitoring card (the job iframe traps its own Tab
    // inside the extension page).
    if (event && event.key === "Tab" && !jobPhase && host) {
      let focusables = [];
      try {
        focusables = [...host.querySelectorAll("button")].filter((el) => !el.disabled);
      } catch {
        focusables = [];
      }
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = doc.activeElement;
      if (event.shiftKey) {
        if (active === first || !host.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function observeResources() {
    // Seed with already-loaded subresources (the page loaded before the click).
    try {
      const perf = deps.performance ?? (win && win.performance) ?? null;
      const entries = perf && typeof perf.getEntriesByType === "function"
        ? perf.getEntriesByType("resource")
        : [];
      addCandidates(collectInTabUrls(entries));
    } catch {
      // Performance timeline unavailable; the background collector still covers pre-click traffic.
    }
    // Watch future subresources (lazy zoom viewers fetch tiles after the click).
    try {
      const Observer = deps.PerformanceObserver ?? (win && win.PerformanceObserver) ?? null;
      if (typeof Observer !== "function") return;
      observer = new Observer((list) => {
        try {
          addCandidates(collectInTabUrls(list.getEntries()));
        } catch {
          // One bad batch must never kill the observer.
        }
      });
      if (observer && typeof observer.observe === "function") {
        observer.observe({ type: "resource", buffered: false });
      }
    } catch {
      observer = null;
    }
  }

  function buildStatusCard() {
    host = doc.createElement("div");
    host.id = "dezoomify-in-tab";
    host.setAttribute("lang", "en");
    const card = doc.createElement("div");
    card.className = "dz-in-tab-card";
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-label", "Dezoomify");
    const title = doc.createElement("h2");
    title.className = "dz-in-tab-title";
    title.textContent = "Dezoomify";
    statusEl = doc.createElement("p");
    statusEl.className = "dz-in-tab-status";
    statusEl.textContent = "Monitoring this tab for zoomable images…";
    const actions = doc.createElement("div");
    actions.className = "dz-in-tab-actions";
    const stopBtn = doc.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "dz-btn-secondary";
    stopBtn.textContent = "Stop";
    stopBtn.addEventListener("click", () => detach("button"));
    actions.append(stopBtn);
    card.append(title, statusEl, actions);
    host.appendChild(card);
    doc.documentElement.appendChild(host);
  }

  function enterJobPhase() {
    if (!mounted || jobHost) return;
    // Hidden probe: mounted alongside the status card on mount so wasm
    // byte-confirmation starts at once. Never removes the status card;
    // `revealJobPhase()` shows the iframe only after byte confirmation.
    jobHost = doc.createElement("div");
    jobHost.id = "dezoomify-modal-host";
    try {
      if (jobHost.style) jobHost.style.display = "none";
    } catch {
      // Hiding is best-effort; the status card still covers the probe.
    }
    let shadow = null;
    try {
      shadow = jobHost.attachShadow({ mode: "closed" });
    } catch {
      shadow = null;
    }
    const style = doc.createElement("style");
    style.textContent =
      ".dz-backdrop{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(24,22,21,0.55);padding:24px;box-sizing:border-box;}" +
      ".dz-frame{width:min(94vw,720px);height:min(88vh,760px);border:1px solid #a19797;border-radius:4px;background:#fcfeff;box-shadow:0 4px 20px rgba(130,115,110,0.35);}";
    const backdrop = doc.createElement("div");
    backdrop.className = "dz-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", "Dezoomify");
    backdrop.addEventListener("click", (event) => {
      if (event && event.target === backdrop) detach("backdrop");
    });
    frame = doc.createElement("iframe");
    frame.setAttribute("id", "dezoomify-modal-frame");
    frame.setAttribute("class", "dz-frame");
    frame.setAttribute("src", frameUrl());
    frame.setAttribute("title", "Dezoomify");
    backdrop.appendChild(frame);
    if (shadow) {
      shadow.appendChild(style);
      shadow.appendChild(backdrop);
    } else {
      jobHost.appendChild(style);
      jobHost.appendChild(backdrop);
    }
    doc.documentElement.appendChild(jobHost);
    armReadyTimeout();
  }

  function revealJobPhase() {
    if (!mounted || !jobHost || jobPhase) return;
    jobPhase = true;
    // Byte confirmation swaps the monitoring card for the visible job UI.
    try {
      if (host && typeof host.remove === "function") host.remove();
    } catch {
      // ignore
    }
    host = null;
    statusEl = null;
    try {
      if (jobHost.style) jobHost.style.display = "";
    } catch {
      // Showing must never throw.
    }
  }

  function armReadyTimeout() {
    if (readyTimer !== null) {
      try {
        timerClear(readyTimer);
      } catch {
        // ignore
      }
    }
    readyTimer = timerSet(() => {
      readyTimer = null;
      if (!mounted) return;
      // The iframe never came alive. Keep this error in the tab instead of
      // removing the card or opening a second extension page.
      showStartupFailure("the job window was blocked by the browser");
    }, 8000);
  }

  function detach(reason) {
    if (!mounted) return { detached: false, reason: reason ?? "close" };
    mounted = false;
    jobPhase = false;
    byteConfirmed = false;
    if (readyTimer !== null) {
      try {
        timerClear(readyTimer);
      } catch {
        // Timer cleanup must never throw.
      }
      readyTimer = null;
    }
    try {
      win.removeEventListener("message", onWindowMessage);
    } catch {
      // ignore
    }
    try {
      doc.removeEventListener("keydown", onKeyDown, true);
    } catch {
      // ignore
    }
    try {
      if (observer && typeof observer.disconnect === "function") observer.disconnect();
    } catch {
      // ignore
    }
    observer = null;
    try {
      const onMsg = chromeApi && chromeApi.runtime && chromeApi.runtime.onMessage;
      if (runtimeListener && onMsg && typeof onMsg.removeListener === "function") {
        onMsg.removeListener(runtimeListener);
      }
    } catch {
      // ignore
    }
    runtimeListener = null;
    try {
      if (host && typeof host.remove === "function") host.remove();
    } catch {
      // ignore
    }
    host = null;
    try {
      if (jobHost && typeof jobHost.remove === "function") jobHost.remove();
    } catch {
      // ignore
    }
    jobHost = null;
    frame = null;
    statusEl = null;
    candidates.length = 0;
    seen.clear();
    // Lifecycle: closing disposes the background collector and restores the
    // default (grey) action icon via the background.
    notifyBackground({ type: "dezoomify-modal-closed", reason: reason ?? "close" });
    return { detached: true, reason: reason ?? "close" };
  }

  function cleanup(reason) {
    const out = detach(reason ?? "close");
    return { cleaned: out.detached || out.reason !== undefined, reason: out.reason };
  }

  function mount() {
    if (mounted) return false;
    if (win && win.__dezoomifyInTabMounted) return false;
    mounted = true;
    jobPhase = false;
    byteConfirmed = false;
    token = makeToken();
    if (win) {
      try {
        win.__dezoomifyInTabMounted = true;
      } catch {
        // Flag write is best-effort only.
      }
    }
    observeResources();
    buildStatusCard();
    // Hidden probe starts wasm byte-confirmation at once, not on first URL.
    enterJobPhase();
    // Background lifecycle channel (monitor updates, second-click/background
    // stop, legacy snapshots): without this the card can neither show
    // progress nor honor Stop from outside the tab.
    try {
      const onMsg = chromeApi && chromeApi.runtime && chromeApi.runtime.onMessage;
      if (onMsg && typeof onMsg.addListener === "function") {
        runtimeListener = (message) => onMessage(message);
        onMsg.addListener(runtimeListener);
      }
    } catch {
      // Listener wiring is best-effort; timeline probing works without it.
    }
    try {
      win.addEventListener("message", onWindowMessage);
    } catch {
      // Message wiring is best-effort; the frame handshake degrades to fallback.
    }
    try {
      doc.addEventListener("keydown", onKeyDown, true);
    } catch {
      // Escape wiring is best-effort only.
    }
    return true;
  }

  return {
    mount,
    detach,
    cleanup,
    onMessage,
    snapshotCandidates,
    addCandidates,
    get mounted() {
      return mounted;
    },
    get jobPhase() {
      return jobPhase;
    },
  };
}

// Auto-mount exactly once when injected as a classic content script. The
// `typeof` guards keep node imports side-effect free for unit tests.
try {
  const g = typeof globalThis !== "undefined" ? globalThis : null;
  const hasBrowser = g && (g.chrome ?? g.browser) && (g.chrome ?? g.browser).runtime &&
    typeof (g.chrome ?? g.browser).runtime.getURL === "function";
  const hasDom = typeof document !== "undefined" && typeof window !== "undefined";
  const already = g && g.__dezoomifyInTabMounted === true;
  if (hasBrowser && hasDom && !already) {
    createInTabModal({
      document,
      window,
      chromeApi: g.chrome ?? g.browser,
      performance: window.performance,
      PerformanceObserver: window.PerformanceObserver,
      crypto: window.crypto,
    }).mount();
  }
} catch {
  // Auto-mount must never throw in hostile pages.
}
