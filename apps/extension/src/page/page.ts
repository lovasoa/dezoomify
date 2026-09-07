/**
 * Extension page: the whole job lives here.
 *
 * Flow (v1): the toolbar click opens this page bound to exactly that tab
 * (`page.html?tab=<id>` from the activeTab grant) -> finite reload scan
 * (webRequest observed from this page; the tab's origin is covered by the
 * activeTab grant from the action click, or by granted host permissions) ->
 * pick a candidate source URL -> run the wasm discovery core inline -> plan
 * -> fetch tiles with the browser session -> assemble on canvas -> save via
 * a blob anchor.
 *
 * Least privilege: this page never enumerates tabs. It touches only the
 * bound tab via `tabs.get(boundId)`/`tabs.reload(boundId)` plus a webRequest
 * filter scoped to that tab id. The unbound first-run page shows guidance
 * only and makes zero tabs API calls.
 *
 * Module document: imports the staged `scan.js`/`candidates.js` and the wasm
 * glue. Every failure is logged into the visible log (the E2E asserts on it).
 *
 * Job sections mirror shared-ui `view.ts` geometry with the same `dz-*` class
 * names (job/progress, completed, failed) styled by the theme block in
 * `page.html`: a concise result first, the full log layered in `<details>`,
 * with cancel/retry and partial-tile saves. Scan, fetch, candidate, and
 * save-name logic below is unchanged.
 */

import { createScanner, isPrivilegedUrl } from "./scan.js";
import { validateCandidateUrl, redactUrlForLabel } from "./candidates.js";
import { createSessionFetcher, originOf } from "./fetch.js";
import { requestNativeHandoff, NATIVE_HOST_NAME } from "./nativeHandoff.js";
import { parseCrop, clampCrop, subsetPlanForCrop, cropSizeLabel } from "./vendor/crop.js";
import { pickLevel, BROWSER_MAX_PLAN_TILES } from "./vendor/limits.js";
import init, * as wasm from "../wasm/dezoomify-wasm.js";

// Extension tile concurrency (6 workers, paced starts): matches the
// documented browser policy (see limits.test.mjs). Tile fetches run with at
// most 6 in flight and a short per-host stagger so one job cannot flood the
// site; small jobs stay sequential in effect.
const EXT_TILE_CONCURRENCY = 6;
const EXT_TILE_MIN_INTERVAL_MS = 50;

// Local history helpers (todo 5.2): mirror of `packages/shared-ui/src/history.ts`
// for the no-bundler page. The page ships verbatim, so shared-ui cannot be
// imported here; this compact copy keeps the same redaction rule (origin plus
// path hash by default, full URL only for non-sensitive sources). Keep the
// sensitive vocabulary in sync with the canonical module.
const HISTORY_KEY_EXTENSION = "dezoomify.ext.history.v1";
const HISTORY_MAX = 20;
const EXT_SENSITIVE_PARTS = ["apikey", "api_key", "token", "auth", "session", "signature", "secret", "password", "cookie"];
const EXT_SENSITIVE_EXACT = new Set(["cookie", "cookies", "authorization", "proxy-authorization", "bearer", "token", "signature", "sig", "auth", "secret", "password", "session", "sid", "apikey", "api_key", "key"]);

function extSensitiveKey(name) {
  const lower = String(name ?? "").toLowerCase();
  if (lower === "") return false;
  if (EXT_SENSITIVE_EXACT.has(lower)) return true;
  return EXT_SENSITIVE_PARTS.some((part) => lower.includes(part));
}

function extIsSensitiveUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url ?? "").trim());
  } catch {
    return true;
  }
  if (parsed.username !== "" || parsed.password !== "") return true;
  try {
    for (const key of parsed.searchParams.keys()) {
      if (extSensitiveKey(key)) return true;
    }
  } catch {
    return true;
  }
  return false;
}

function extHistoryOrigin(url) {
  try {
    const parsed = new URL(String(url ?? "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    if (!parsed.hostname) return "";
    return parsed.protocol + "//" + parsed.hostname.toLowerCase() + (parsed.port ? ":" + parsed.port : "");
  } catch {
    return "";
  }
}

function extPathHash(url) {
  const text = String(url ?? "");
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function extToHistoryEntry(url, width, height) {
  const origin = extHistoryOrigin(url);
  const trimmed = String(url ?? "").trim();
  if (origin === "" || trimmed === "" || trimmed.length > 2048) return null;
  if (extIsSensitiveUrl(trimmed)) {
    return { origin, pathHash: extPathHash(trimmed), at: Date.now() };
  }
  const entry = { origin, pathHash: extPathHash(trimmed), url: trimmed, at: Date.now() };
  if (Number.isFinite(width) && width > 0) entry.width = Math.floor(width);
  if (Number.isFinite(height) && height > 0) entry.height = Math.floor(height);
  entry.format = "png";
  return entry;
}

function extPushHistory(list, entry) {
  const kept = (Array.isArray(list) ? list : []).filter((item) => {
    return item && !(item.origin === entry.origin && item.pathHash === entry.pathHash);
  });
  kept.unshift(entry);
  return kept.slice(0, HISTORY_MAX);
}

function extParseHistory(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item) => {
      return item && typeof item.origin === "string" && typeof item.pathHash === "string" && typeof item.at === "number";
    }).slice(0, HISTORY_MAX);
  } catch {
    return [];
  }
}

const { DiscoverySession } = wasm;

const api = globalThis.browser ?? globalThis.chrome;

const log = (line) => {
  const el = document.getElementById("log");
  el.textContent += line + "\n";
  el.scrollTop = el.scrollHeight;
};

const fail = (code, detail) => {
  log("FAILED " + code + (detail ? ": " + detail : ""));
  if (detail && detail.stack) log(detail.stack);
  setOutcome("failed");
  const short = typeof detail === "string" && detail.length > 0 ? detail.split("\n")[0] : String(code);
  showFailedSection(short, () => {
    if (uiState.lastTabId !== null) run(uiState.lastTabId);
  });
};

// --- Shared-UI-aligned job sections (no bundler) ---
//
// The page ships verbatim with no bundler, so shared-ui `renderView` cannot
// be imported here. These helpers replicate its geometry with the same
// `dz-*` class names styled by the theme block in `page.html`: one `.dz-card`
// hosting the job (progress), completed, and failed sections, with layered
// diagnostics (concise result first, full log in `<details>`). All strings
// reach the DOM via `textContent`, never markup. Scan, fetch, candidate
// ranking, and save naming are unchanged.

const uiState = { cancelRequested: false, lastTabId: null };

// Crop / region selection (todo 5.4, vendored shared-ui): numeric inputs
// plus live estimate. Tainted-safe: plan subset only, never pixel reads.
// Empty or out-of-bounds crops fail before acquisition with a typed error.
function readCropInputs() {
  try {
    const get = (id) => {
      const el = document.getElementById(id);
      return el && typeof el.value === "string" ? el.value.trim() : "";
    };
    const x = get("crop-x");
    const y = get("crop-y");
    const w = get("crop-w");
    const h = get("crop-h");
    if (x === "" && y === "" && w === "" && h === "") return null;
    if (x === "" || y === "" || w === "" || h === "") return null;
    return parseCrop(`${x},${y},${w},${h}`);
  } catch {
    return null;
  }
}

function updateCropEstimate(canvas) {
  try {
    const el = document.getElementById("crop-estimate");
    if (!el) return;
    const rect = readCropInputs();
    if (!rect) {
      el.textContent = "";
      return;
    }
    const clamped = canvas ? clampCrop(rect, canvas) : rect;
    if (!clamped) {
      el.textContent = "That region is empty or outside the image.";
      return;
    }
    el.textContent = `Region: ${cropSizeLabel(clamped)}`;
  } catch {
    // Estimate must never break the job.
  }
}

function initCropInputs() {
  try {
    document.getElementById("dz-crop")?.removeAttribute("hidden");
    for (const id of ["crop-x", "crop-y", "crop-w", "crop-h"]) {
      document.getElementById(id)?.addEventListener("input", () => updateCropEstimate(null));
    }
    document.getElementById("crop-clear")?.addEventListener("click", () => {
      for (const id of ["crop-x", "crop-y", "crop-w", "crop-h"]) {
        const el = document.getElementById(id);
        if (el) el.value = "";
      }
      updateCropEstimate(null);
    });
    document.getElementById("crop-apply")?.addEventListener("click", () => {
      if (uiState.lastTabId !== null) run(uiState.lastTabId);
    });
  } catch {
    // Crop wiring must never break the page.
  }
}

try {
  if (typeof document !== "undefined") initCropInputs();
} catch {
  // Init is best-effort.
}

// Recent-jobs history per tab (todo 5.2): local-only ledger for this page
// instance (one page per bound tab, so session storage is already per-tab).
// Only a redacted origin plus a path hash persists by default; the full
// source URL persists only for non-sensitive URLs (the explicit scan click
// is the opt-in). Credentials never enter history.
const extMemoryFallback = new Map();
const extHistoryStore = {
  getItem(key) {
    try {
      if (typeof sessionStorage !== "undefined" && typeof sessionStorage.getItem === "function") {
        return sessionStorage.getItem(key);
      }
    } catch {
      // Storage unavailable; fall through to the memory fallback.
    }
    return extMemoryFallback.get(key) ?? null;
  },
  setItem(key, value) {
    try {
      if (typeof sessionStorage !== "undefined" && typeof sessionStorage.setItem === "function") {
        sessionStorage.setItem(key, value);
        return;
      }
    } catch {
      // Storage unavailable; fall through to the memory fallback.
    }
    extMemoryFallback.set(key, value);
  },
  removeItem(key) {
    try {
      if (typeof sessionStorage !== "undefined" && typeof sessionStorage.removeItem === "function") {
        sessionStorage.removeItem(key);
      }
    } catch {
      // Removal must never throw.
    }
    extMemoryFallback.delete(key);
  },
};

function extHistoryKey() {
  const tabId = uiState.lastTabId;
  if (tabId !== null && tabId !== undefined) return HISTORY_KEY_EXTENSION + "." + String(tabId);
  return HISTORY_KEY_EXTENSION;
}

function loadExtHistory() {
  try {
    const raw = extHistoryStore.getItem(extHistoryKey());
    return extParseHistory(raw);
  } catch {
    return [];
  }
}

function recordExtHistory(sourceUrl, width, height) {
  try {
    const entry = extToHistoryEntry(sourceUrl, width, height);
    if (!entry) return;
    const next = extPushHistory(loadExtHistory(), entry);
    try {
      extHistoryStore.setItem(extHistoryKey(), JSON.stringify(next));
    } catch {
      // Persistence must never break a save.
    }
    renderExtHistory();
  } catch {
    // History must never break a save.
  }
}

function renderExtHistory() {
  try {
    const card = document.getElementById("dz-card");
    if (!card) return;
    let section = document.getElementById("dz-ext-history");
    if (!section) {
      section = document.createElement("div");
      section.id = "dz-ext-history";
      section.className = "dz-history-section";
      card.appendChild(section);
    }
    while (section.firstElementChild) section.firstElementChild.remove();
    const entries = loadExtHistory();
    const title = document.createElement("h2");
    title.className = "dz-history-title";
    title.textContent = "Recent pictures";
    section.appendChild(title);
    const note = document.createElement("p");
    note.className = "dz-history-note";
    note.textContent = "Kept only on this device, only for this tab.";
    section.appendChild(note);
    if (entries.length === 0) {
      const empty = document.createElement("p");
      empty.className = "dz-history-empty";
      empty.textContent = "No recent pictures yet. Saved pictures appear here.";
      section.appendChild(empty);
      return;
    }
    const list = document.createElement("ul");
    list.className = "dz-history-list";
    for (const entry of entries.slice(0, 20)) {
      const item = document.createElement("li");
      item.className = "dz-history-item";
      const main = document.createElement("span");
      main.className = "dz-history-main";
      const dims = typeof entry.width === "number" && typeof entry.height === "number"
        ? entry.width + " by " + entry.height + " pixels"
        : "";
      const parts = [entry.origin];
      if (dims !== "") parts.push(dims);
      if (typeof entry.format === "string" && entry.format !== "") parts.push(entry.format);
      main.textContent = parts.join(" ");
      item.appendChild(main);
      if (typeof entry.url === "string" && entry.url !== "" && uiState.lastTabId !== null) {
        const openBtn = document.createElement("button");
        openBtn.type = "button";
        openBtn.className = "dz-btn-secondary";
        openBtn.textContent = "Open again";
        openBtn.addEventListener("click", () => {
          if (uiState.lastTabId !== null) run(uiState.lastTabId);
        });
        item.appendChild(openBtn);
      } else {
        const hidden = document.createElement("span");
        hidden.className = "dz-history-hidden";
        hidden.textContent = "Address hidden for privacy";
        item.appendChild(hidden);
      }
      list.appendChild(item);
    }
    section.appendChild(list);
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "dz-btn-secondary";
    clearBtn.id = "dz-ext-history-clear";
    clearBtn.textContent = "Clear history";
    clearBtn.addEventListener("click", () => {
      try {
        extHistoryStore.removeItem(extHistoryKey());
        renderExtHistory();
      } catch {
        // Clearing must never throw.
      }
    });
    section.appendChild(clearBtn);
  } catch {
    // History rendering must never break the page.
  }
}

function uiEl(id) {
  return document.getElementById(id);
}

function setOutcome(value) {
  if (value === null || value === undefined) {
    delete document.body.dataset.outcome;
  } else {
    document.body.dataset.outcome = value;
  }
}

function setStep(text) {
  const step = uiEl("dz-step");
  if (step && step.textContent !== text) step.textContent = text;
  const track = uiEl("dz-track");
  if (track) track.setAttribute("aria-label", text);
}

function setProgress(current, total) {
  const determinate = Number.isFinite(current) && Number.isFinite(total) && total > 0;
  const pct = determinate ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
  const track = uiEl("dz-track");
  const bar = uiEl("dz-bar");
  const percent = uiEl("dz-percent");
  const counts = uiEl("dz-counts");
  if (track) {
    track.setAttribute("aria-valuenow", String(pct));
    if (determinate) track.classList.remove("dz-indeterminate");
    else track.classList.add("dz-indeterminate");
  }
  if (bar) bar.style.width = determinate ? pct + "%" : "35%";
  if (percent) {
    const text = determinate ? pct + "%" : "";
    if (percent.textContent !== text) percent.textContent = text;
  }
  if (counts) {
    const text = determinate ? current + " of " + total + " tiles" : "";
    if (counts.textContent !== text) counts.textContent = text;
  }
}

function setSource(url) {
  const line = uiEl("dz-source");
  const urlEl = uiEl("dz-source-url");
  if (!line || !urlEl) return;
  if (typeof url === "string" && url) {
    let label = url;
    try {
      label = redactUrlForLabel(url);
    } catch {
      label = url;
    }
    if (urlEl.textContent !== label) urlEl.textContent = label;
    line.title = url;
    line.hidden = false;
  } else {
    line.hidden = true;
  }
}

function setDiagnostics(lines) {
  const diag = uiEl("dz-diag");
  if (!diag) return;
  const text = lines.join("\n");
  if (diag.textContent !== text) diag.textContent = text;
}

function clearResult() {
  const box = uiEl("dz-result");
  if (box) {
    box.replaceChildren();
    box.hidden = true;
  }
  // Drop any stray orphaned handoff affordance outside the result section so
  // a second run can never duplicate it.
  try {
    document.querySelectorAll("body > [data-handoff]").forEach((el) => el.remove());
  } catch {
    // Cleanup must never break the run.
  }
}

function pageActionButton(label, primary, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = primary ? "dz-btn-tactile" : "dz-btn-secondary";
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function showCompletedSection(info) {
  const box = uiEl("dz-result");
  if (!box) return;
  box.replaceChildren();
  const partial = info.failedTiles > 0;
  const sec = document.createElement("div");
  sec.className = "dz-view-body dz-completed-section";
  const header = document.createElement("div");
  header.className = "dz-completed-header";
  const titles = document.createElement("div");
  const title = document.createElement("h2");
  title.className = "dz-completed-title";
  title.textContent = partial ? "Saved with gaps" : "Saved";
  const summary = document.createElement("p");
  summary.className = "dz-completed-summary";
  summary.textContent = partial
    ? "Saved " + info.savedName + " (" + info.width + "x" + info.height + ", " +
      (info.totalTiles - info.failedTiles) + " of " + info.totalTiles + " tiles; " +
      info.failedTiles + " tile(s) missing)."
    : "Saved " + info.savedName + " (" + info.width + "x" + info.height + ").";
  titles.append(title, summary);
  header.append(titles);
  const actions = document.createElement("div");
  actions.className = "dz-actions-row";
  actions.append(pageActionButton("Scan again", false, info.onAgain));
  sec.append(header, actions);
  box.append(sec);
  box.hidden = false;
}

function showFailedSection(message, onRetry) {
  const box = uiEl("dz-result");
  if (!box) return;
  box.replaceChildren();
  const sec = document.createElement("div");
  sec.className = "dz-view-body dz-error-section";
  const header = document.createElement("div");
  header.className = "dz-error-header";
  const titles = document.createElement("div");
  const title = document.createElement("h2");
  title.className = "dz-error-title";
  title.textContent = "Could not dezoomify image";
  const msg = document.createElement("p");
  msg.className = "dz-error-message";
  msg.textContent = message;
  titles.append(title, msg);
  header.append(titles);
  const hint = document.createElement("p");
  hint.className = "dz-notice-guidance";
  hint.textContent = "Full technical output is kept below under Technical details & logs.";
  const actions = document.createElement("div");
  actions.className = "dz-actions-row";
  actions.append(pageActionButton("Try again", true, onRetry));
  sec.append(header, hint, actions);
  box.append(sec);
  box.hidden = false;
}

function showCancelledSection(onAgain) {
  const box = uiEl("dz-result");
  if (!box) return;
  box.replaceChildren();
  const sec = document.createElement("div");
  sec.className = "dz-view-body dz-notice-section";
  const title = document.createElement("h2");
  title.className = "dz-notice-title";
  title.textContent = "Save cancelled";
  const msg = document.createElement("p");
  msg.className = "dz-notice-message";
  msg.textContent = "The image save was stopped. Nothing was saved.";
  const actions = document.createElement("div");
  actions.className = "dz-actions-row";
  actions.append(pageActionButton("Scan again", false, onAgain));
  sec.append(title, msg, actions);
  box.append(sec);
  box.hidden = false;
}

function throwIfCancelled() {
  if (uiState.cancelRequested) {
    throw Object.assign(new Error("cancelled by user"), { code: "cancelled" });
  }
}

function pickedUrlFor(tab) {
  // url is visible when activeTab covers the tab or host permissions grant it;
  // the scanner still enforces the privileged-URL guard when it is known.
  return typeof tab.url === "string" && tab.url ? tab.url : "http://unknown/";
}

async function getBoundTab(tabId) {
  // Single-tab access only: never enumerate tabs (`tabs.query`). The bound
  // id comes from the toolbar click (`?tab=`). `tabs.get` exposes only that
  // tab; its URL is visible under the activeTab grant or a granted host
  // permission, otherwise this degrades to an id-only label and the scan
  // still enforces the privileged-URL guard when the URL is known.
  const tab = await api.tabs.get(tabId);
  if (!tab || typeof tab.id !== "number") {
    throw Object.assign(new Error("target tab vanished"), { code: "no-target-tab" });
  }
  return tab;
}

async function runScan(tabId) {
  const store = { urls: [] };
  const tab = await getBoundTab(tabId);
  const url = pickedUrlFor(tab);
  if (isPrivilegedUrl(url)) {
    throw Object.assign(new Error("privileged URL: " + JSON.stringify(url)), { code: "privileged-url" });
  }

  const listener = { ref: null };
  const scanner = createScanner({
    queryActiveTab: async () => ({ id: tabId, url }),
    addWebRequestListener: (handler, id) => {
      listener.ref = (details) => {
        handler(details.tabId, details.url);
        if (
          details.tabId === id &&
          validateCandidateUrl(details.url).ok &&
          !store.urls.includes(details.url)
        ) {
          store.urls.push(details.url);
        }
      };
      api.webRequest.onBeforeRequest.addListener(listener.ref, {
        urls: ["http://*/*", "https://*/*"],
        tabId: id,
      });
    },
    removeWebRequestListener: () => {
      if (listener.ref) api.webRequest.onBeforeRequest.removeListener(listener.ref);
    },
    reloadTab: (id) => api.tabs.reload(id),
  });

  await scanner.startScan();
  while (scanner.getState() !== "stopped") {
    if (uiState.cancelRequested) {
      scanner.dispose("cancelled");
      throw Object.assign(new Error("cancelled by user"), { code: "cancelled" });
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const snap = scanner.getSnapshot();
  log("scan stopped: " + snap.stopReason + ", observed " + store.urls.length + " urls");
  return store.urls;
}

function makeTabFetcher(tabOrigin) {
  return createSessionFetcher({
    fetchImpl: async (url, init) => {
      const started = Date.now();
      const res = await fetch(url, init);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const headers = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      const finalUrl = res.url || url;
      return {
        status: res.status,
        url: finalUrl,
        headers,
        bytes,
        redirectChain: [url, finalUrl],
        durationMs: Date.now() - started,
      };
    },
    hasPermission: async (origin) => {
      if (origin === tabOrigin) return true;
      try {
        if (api?.permissions?.contains) {
          return await api.permissions.contains({ origins: [origin + "/*"] });
        }
      } catch {
        return false;
      }
      return false;
    },
    requestPermission: async (origin) => {
      if (origin === tabOrigin) return true;
      try {
        if (api?.permissions?.request) {
          return await api.permissions.request({ origins: [origin + "/*"] });
        }
      } catch {
        return false;
      }
      return false;
    },
  });
}

function tabOriginOf(url) {
  try {
    return originOf(url);
  } catch {
    return "";
  }
}

async function discover(sourceUrl, tabOrigin) {
  await init();
  const session = new DiscoverySession(sourceUrl);
  const fetcher = makeTabFetcher(tabOrigin);
  for (;;) {
    throwIfCancelled();
    const raw = session.nextNeed();
    if (!raw || raw === "null") break;
    const need = JSON.parse(raw);
    try {
      const out = await fetcher.fetchResource(need.uri, { userIntent: true });
      session.provide(need.id, out.bytes, out.finalUrl || need.uri);
    } catch (e) {
      session.provideFailure(need.id, String((e && e.message) || e));
    }
  }
  return { session, catalog: JSON.parse(session.finish()) };
}

async function planLevel(session, image, tabOrigin) {
  // Canonical level picking (vendored limits.js, no forked area math):
  // largest fitting wins via pickLevel; the BROWSER_MAX_PLAN_TILES guard
  // fails gigapixel plans cheaply before serializing trillions of tiles.
  const picked = pickLevel({ levels: image.levels });
  const level = image.levels.find((candidate) => candidate.index === picked.index) ?? image.levels[0];
  let plan = JSON.parse(session.levelTiles(image.id, level.index));
  const fetcher = makeTabFetcher(tabOrigin);
  let guard = 0;
  while (plan.kind === "probe" && guard++ < 5) {
    throwIfCancelled();
    const out = await fetcher.fetchResource(plan.uri, { userIntent: true });
    const bmp = await createImageBitmap(new Blob([out.bytes]));
    plan = JSON.parse(session.probeSubmit(image.id, level.index, bmp.width > 0, bmp.width, bmp.height));
  }
  if (plan.tiles && plan.tiles.length > BROWSER_MAX_PLAN_TILES) {
    throw Object.assign(
      new Error(
        `estimated ${plan.tiles.length} tiles exceeds the ${BROWSER_MAX_PLAN_TILES}-tile browser plan limit; use the desktop app`,
      ),
      { code: "PLAN_INVALID" },
    );
  }
  return plan;
}

async function assemble(session, plan, tabOrigin) {
  const canvas = document.createElement("canvas");
  canvas.width = plan.canvas.x;
  canvas.height = plan.canvas.y;
  const ctx = canvas.getContext("2d");
  const fetcher = makeTabFetcher(tabOrigin);
  let done = 0;
  let failedTiles = 0;
  // Taint gate: pixel reads stay behind originClean. Readable session bytes
  // keep the canvas clean; a tainted canvas finishes as display-only success
  // (visible via ordinary display, no byte save) instead of a silent blank.
  let originClean = true;
  let lastStartMs = 0;
  setProgress(0, plan.tiles.length);
  for (const tile of plan.tiles) {
    throwIfCancelled();
    // Pace starts per host (EXT_TILE_MIN_INTERVAL_MS) within the
    // EXT_TILE_CONCURRENCY bound (sequential here, so never above 6).
    const nowStart = Date.now();
    const sinceLast = nowStart - lastStartMs;
    if (lastStartMs !== 0 && sinceLast < EXT_TILE_MIN_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, EXT_TILE_MIN_INTERVAL_MS - sinceLast));
    }
    lastStartMs = Date.now();
    let bytes = null;
    let bmp = null;
    try {
      const out = await fetcher.fetchResource(tile.uri, { userIntent: true });
      bytes = out.bytes;
      if (tile.processing) bytes = session.applyProcessing(tile.processing, bytes);
      bmp = await createImageBitmap(new Blob([bytes]));
    } catch (e) {
      // Partial save: one bad tile must not lose the rest of the image.
      // The placement read below stays fatal so a tainted canvas still
      // fails fast instead of saving blank output.
      failedTiles += 1;
      log(
        "tile failed at " + tile.x + "," + tile.y +
          " (" + (done + failedTiles) + "/" + plan.tiles.length + "): " +
          ((e && e.message) || e) + " (continuing)",
      );
      setProgress(done + failedTiles, plan.tiles.length);
      continue;
    }
    // Trust the plan for placement so a mis-sized decode never leaves a seam:
    // log the mismatch and scale the decoded bytes to the planned extent.
    const planW = tile.w ?? bmp.width;
    const planH = tile.h ?? bmp.height;
    if (planW !== bmp.width || planH !== bmp.height) {
      log("tile size mismatch at " + tile.x + "," + tile.y + ": plan " + planW + "x" + planH + ", decoded " + bmp.width + "x" + bmp.height);
    }
    if (planW > 0 && planH > 0 && bmp.width > 0 && bmp.height > 0) {
      ctx.drawImage(bmp, 0, 0, bmp.width, bmp.height, tile.x, tile.y, planW, planH);
    }
    if (originClean) {
      try {
        const sample = ctx.getImageData(tile.x + 5, tile.y + 5, 1, 1).data;
        done += 1;
        setProgress(done + failedTiles, plan.tiles.length);
        log("tile " + (done + failedTiles) + "/" + plan.tiles.length + " at " + tile.x + "," + tile.y + " bmp " + bmp.width + "px sample " + [...sample].join(","));
      } catch (taint) {
        originClean = false;
        log("display-only: canvas tainted at " + tile.x + "," + tile.y + " (" + ((taint && taint.message) || taint) + "); finishing visible without a byte save");
        done += 1;
        setProgress(done + failedTiles, plan.tiles.length);
      }
    } else {
      // display-only continuation: ordinary display stays visible, no reads.
      done += 1;
      setProgress(done + failedTiles, plan.tiles.length);
      log("display-only: tile " + (done + failedTiles) + "/" + plan.tiles.length + " at " + tile.x + "," + tile.y);
    }
  }
  if (!originClean) {
    return { blob: null, done, failedTiles, total: plan.tiles.length, originClean, displayOnly: true };
  }
  if (done === 0) {
    throw Object.assign(new Error("all " + plan.tiles.length + " tiles failed"), { code: "tile-failed" });
  }
  if (failedTiles > 0) {
    log("partial: saved " + done + " of " + plan.tiles.length + " tiles (" + failedTiles + " missing)");
  }
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  return { blob, done, failedTiles, total: plan.tiles.length, originClean, displayOnly: false };
}

// Shared save name (todo 4.6): canonical logic lives in
// packages/shared-ui/src/saveName.ts (`dezoomify-WxH.png`, fallback
// `dezoomify.png`). A literal shared-ui import is impossible here: this page
// ships verbatim as `page.js` with no bundler (see `package-store.sh`), so
// the pure helper is replicated, not imported (same pattern as the modal
// geometry below).
function extensionForSaveFormat(format) {
  const lower = typeof format === "string" ? format.toLowerCase() : "png";
  if (lower === "jpeg" || lower === "jpg") return "jpg";
  if (lower === "tiff" || lower === "tif") return "tif";
  return "png";
}

function suggestedNameFor(width, height, format) {
  const ext = extensionForSaveFormat(format);
  const w = typeof width === "number" ? width : Number(width);
  const h = typeof height === "number" ? height : Number(height);
  if (Number.isFinite(w) && Number.isFinite(h) && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) {
    return `dezoomify-${w}x${h}.${ext}`;
  }
  return `dezoomify.${ext}`;
}

function save(blob, width, height) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedNameFor(width, height, "png");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return anchor.download;
}

/**
 * Rank scan URLs in one core batch (`rankCandidates` over the core registry:
 * known formats first in builtin order, unknowns last, never dropped).
 * Falls back to first-seen order when the wasm glue predates the export.
 */
function rankUrls(urls) {
  if (typeof wasm.rankCandidates !== "function") {
    return urls.map((url) => ({ url, format: null }));
  }
  try {
    const ranked = JSON.parse(wasm.rankCandidates(JSON.stringify(urls)));
    if (Array.isArray(ranked) && ranked.every((entry) => entry && typeof entry.url === "string")) {
      return ranked;
    }
  } catch {
    // Fall through to first-seen order below.
  }
  return urls.map((url) => ({ url, format: null }));
}

async function run(tabId) {
  uiState.lastTabId = tabId;
  uiState.cancelRequested = false;
  clearResult();
  setOutcome(null);
  const job = uiEl("dz-job");
  if (job) job.hidden = false;
  const cancelBtn = uiEl("dz-cancel");
  if (cancelBtn) {
    cancelBtn.hidden = false;
    cancelBtn.disabled = false;
    cancelBtn.onclick = () => {
      uiState.cancelRequested = true;
      cancelBtn.disabled = true;
      setStep("Cancelling…");
    };
  }
  setSource("");
  setProgress(NaN, 0);
  try {
    setStep("Scanning page…");
    setDiagnostics(["Phase: scan", "Tiles: -"]);
    const urls = await runScan(tabId);
    throwIfCancelled();
    if (urls.length === 0) {
      throw Object.assign(new Error("no zoomable candidate observed"), { code: "no-candidate" });
    }
    let tabOrigin = "";
    try {
      const tab = await api.tabs.get(tabId);
      if (tab?.url) tabOrigin = tabOriginOf(tab.url);
    } catch {
      tabOrigin = "";
    }
    await init();
    const ranked = rankUrls(urls);
    log("ranked " + ranked.length + " candidates");
    setDiagnostics(["Phase: discovery", "Candidates: " + ranked.length]);
    let found = null;
    for (let i = 0; i < ranked.length; i++) {
      throwIfCancelled();
      const candidate = ranked[i];
      setStep("Finding the zoomable image (" + (i + 1) + "/" + ranked.length + ")…");
      log("trying " + (i + 1) + "/" + ranked.length + (candidate.format ? " (" + candidate.format + ")" : ""));
      try {
        const result = await discover(candidate.url, tabOrigin);
        if (result.catalog.images && result.catalog.images.length > 0) {
          found = { ...result, source: candidate.url };
          break;
        }
        log("candidate has no image: " + candidate.url);
      } catch (e) {
        throwIfCancelled();
        log("candidate failed: " + candidate.url + ": " + (e && e.message ? e.message : String(e)));
      }
    }
    if (!found) {
      throw Object.assign(new Error("no zoomable candidate observed"), { code: "no-candidate" });
    }
    const { session, catalog } = found;
    log("source: " + found.source);
    setSource(found.source);
    const image = catalog.images[0];
    if (!image) throw Object.assign(new Error("catalog has no image"), { code: "no-image" });
    log("image: " + (image.title || image.format));

    setStep("Choosing the highest resolution…");
    let plan = await planLevel(session, image, tabOrigin);
    throwIfCancelled();
    try {
      updateCropEstimate(plan.canvas);
    } catch {
      // Estimate is best-effort.
    }
    const requestedCrop = readCropInputs();
    if (requestedCrop) {
      try {
        plan = subsetPlanForCrop(plan, requestedCrop);
        log(`crop ${requestedCrop.w}x${requestedCrop.h} at ${requestedCrop.x},${requestedCrop.y}: planning ${plan.tiles.length} tiles`);
      } catch (e) {
        throw Object.assign(new Error("That region is empty or outside the image. Choose x,y,w,h inside the level size."), { code: "crop-invalid", detail: e?.message });
      }
    }
    log("plan: " + plan.tiles.length + " tiles, canvas " + plan.canvas.x + "x" + plan.canvas.y);
    setDiagnostics([
      "Phase: tiles",
      "Tiles: " + plan.tiles.length,
      "Canvas: " + plan.canvas.x + "x" + plan.canvas.y,
    ]);
    setStep("Saving image tiles…");
    const result = await assemble(session, plan, tabOrigin);
    throwIfCancelled();
    if (result.displayOnly || result.originClean === false) {
      // display-only: ordinary display stays visible, no byte save promises.
      setStep("Done (display-only)");
      setDiagnostics([
        "Phase: display-only",
        "Tiles: " + result.done + " of " + result.total,
        "Canvas: " + plan.canvas.x + "x" + plan.canvas.y,
      ]);
      log("display-only: finished visible without a byte save; use the desktop app for a file");
      setProgress(result.total, result.total);
      setOutcome("display-only");
      showCompletedSection({
        width: plan.canvas.x,
        height: plan.canvas.y,
        savedName: "display-only (no file saved)",
        failedTiles: result.failedTiles,
        totalTiles: result.total,
        onAgain: () => run(tabId),
      });
      return;
    }
    setStep("Assembling the final picture…");
    setDiagnostics([
      "Phase: saving",
      "Tiles: " + result.done + " of " + result.total,
      "Canvas: " + plan.canvas.x + "x" + plan.canvas.y,
    ]);
    const savedName = save(result.blob, plan.canvas.x, plan.canvas.y);
    log("saved " + savedName);
    recordExtHistory(found.source, plan.canvas.x, plan.canvas.y);
    setProgress(result.total, result.total);
    setStep("Done");
    setOutcome("saved");
    showCompletedSection({
      width: plan.canvas.x,
      height: plan.canvas.y,
      savedName,
      failedTiles: result.failedTiles,
      totalTiles: result.total,
      onAgain: () => run(tabId),
    });
    offerNativeHandoff(found.source);
  } catch (e) {
    if ((e && e.code) === "cancelled" || uiState.cancelRequested) {
      log("cancelled by user");
      setOutcome("cancelled");
      setStep("Cancelled");
      setDiagnostics(["Phase: cancelled"]);
      showCancelledSection(() => run(tabId));
    } else {
      setDiagnostics(["Phase: failed", "Code: " + ((e && e.code) || "job-failed")]);
      fail(e.code || "job-failed", e.message + "\n" + (e.stack || ""));
    }
  } finally {
    const doneBtn = uiEl("dz-cancel");
    if (doneBtn) {
      doneBtn.hidden = true;
      doneBtn.disabled = false;
      doneBtn.onclick = null;
    }
  }
}

function tabButton(tabId, label) {
  const b = document.createElement("button");
  b.dataset.tabid = String(tabId);
  b.textContent = "Scan " + label;
  b.addEventListener("click", () => {
    document.getElementById("tabs").replaceChildren();
    run(tabId);
  });
  return b;
}

/**
 * Offer native handoff for the discovered source (huge outputs, local
 * destinations, durable jobs). The button lives in the shared completed
 * section next to the scan-again action with `dz-*` classes, so a retry
 * unmounts it with the section and it can never duplicate. Explicit consent
 * names the destination origins and cookie names; values cross once in a
 * bounded message and are never logged. Declining keeps the job in the
 * extension.
 * @param {string} sourceUrl non-secret validated source
 */
function offerNativeHandoff(sourceUrl) {
  let origin;
  try {
    origin = new URL(sourceUrl).origin + "/";
  } catch {
    return;
  }
  const actions = document.querySelector("#dz-result .dz-completed-section .dz-actions-row");
  if (!actions) return;
  if (actions.querySelector("[data-handoff]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dz-btn-secondary";
  button.dataset.handoff = sourceUrl;
  button.textContent = "Send to desktop app (" + origin + ")";
  button.addEventListener("click", () => {
    handoffToDesktop(sourceUrl, origin).catch((e) => {
      log("handoff failed: " + (e && e.code ? e.code : "handoff-failed"));
    });
  });
  actions.append(button);
  log("handoff available for " + origin);
}

/**
 * Handoff consent dialog (todo 4.5): non-blocking DOM modal, never `confirm()`.
 *
 * Reuses the shared modal geometry from `openModal()` (shared-ui `view.ts`):
 * one `.dz-modal-backdrop` (role=dialog, aria-modal) holding a
 * `.dz-modal-card` (close button, title, subtitle, body, actions), plus the
 * desktop deep-link confirm behavior (explicit confirm/decline actions,
 * Escape and backdrop dismiss as decline, Tab trapped inside, focus returns
 * to the opener). A literal shared-ui import is impossible here: this page
 * ships verbatim as `page.js` with no bundler (see `package-store.sh`), so
 * the geometry is replicated, not imported.
 *
 * All labels use `textContent` (never `innerHTML`): origins and cookie names
 * are site-influenced and must never parse as markup. Names/scopes only;
 * cookie values are unread at consent time and never shown. Initial focus is
 * the decline action so an accidental Enter fails safe (stays in extension).
 * @param {{ host: string, origins: string[], cookieNames: string[], jobId: string }} details
 * @returns {Promise<boolean>} true only on explicit confirm.
 */
function requestHandoffConsent(details) {
  return new Promise((resolve) => {
    const doc = document;
    // Like openModal(): a single modal at a time, drop a stale backdrop first.
    doc.querySelector(".dz-modal-backdrop")?.remove();
    const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const origins = Array.isArray(details.origins) ? details.origins : [];
    const cookieNames = Array.isArray(details.cookieNames) ? details.cookieNames : [];

    const backdrop = doc.createElement("div");
    backdrop.className = "dz-modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "dz-handoff-title");
    backdrop.setAttribute("aria-describedby", "dz-handoff-desc");
    // Structural overlay only (the page ships no stylesheet): class names
    // stay shared-themed for consistency if styles are ever added.
    backdrop.setAttribute(
      "style",
      "position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.45);",
    );

    const card = doc.createElement("div");
    card.className = "dz-modal-card";
    card.setAttribute(
      "style",
      "max-width:min(92vw,480px);background:#fff;color:#000;padding:1.25rem;border-radius:4px;box-shadow:0 4px 20px rgba(0,0,0,0.3);",
    );

    const closeBtn = doc.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "dz-modal-close";
    closeBtn.setAttribute("aria-label", "Close dialog");
    closeBtn.title = "Close";
    closeBtn.textContent = "×";

    const title = doc.createElement("h2");
    title.id = "dz-handoff-title";
    title.className = "dz-modal-title";
    title.tabIndex = -1;
    title.textContent = "Send to desktop app?";

    const subtitle = doc.createElement("p");
    subtitle.id = "dz-handoff-desc";
    subtitle.className = "dz-modal-subtitle";
    subtitle.textContent = "Host: " + details.host;

    const body = doc.createElement("div");
    body.className = "dz-modal-body";
    const originsLine = doc.createElement("p");
    originsLine.textContent = "Origins: " + (origins.join(", ") || "(none)");
    const cookiesLine = doc.createElement("p");
    cookiesLine.textContent = "Cookies: " + (cookieNames.join(", ") || "(none)");
    const jobLine = doc.createElement("p");
    jobLine.textContent = "Job: " + details.jobId;
    const note = doc.createElement("p");
    note.textContent = "Nothing is sent until you confirm. Declining keeps the job in the extension.";
    body.append(originsLine, cookiesLine, jobLine, note);

    const actions = doc.createElement("div");
    actions.className = "dz-modal-actions";
    actions.setAttribute("style", "display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem;");
    const declineBtn = doc.createElement("button");
    declineBtn.type = "button";
    declineBtn.className = "dz-btn-secondary";
    declineBtn.textContent = "Stay in extension";
    const confirmBtn = doc.createElement("button");
    confirmBtn.type = "button";
    confirmBtn.className = "dz-btn-tactile";
    confirmBtn.textContent = "Send to desktop app";
    actions.append(declineBtn, confirmBtn);

    card.append(closeBtn, title, subtitle, body, actions);
    backdrop.appendChild(card);

    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      doc.removeEventListener("keydown", onKeyDown, true);
      backdrop.remove();
      if (opener && typeof opener.focus === "function") {
        try {
          opener.focus();
        } catch {
          // Focus return is best-effort only.
        }
      }
      resolve(value);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
        return;
      }
      // Focus trap (desktop confirm pattern): Tab cycles inside the dialog.
      if (e.key !== "Tab") return;
      const focusables = [...backdrop.querySelectorAll("button")].filter((el) => !el.disabled);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = doc.activeElement;
      if (e.shiftKey) {
        if (active === first || !backdrop.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        e.preventDefault();
        first.focus();
      }
    };

    closeBtn.addEventListener("click", () => settle(false));
    declineBtn.addEventListener("click", () => settle(false));
    confirmBtn.addEventListener("click", () => settle(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) settle(false);
    });
    doc.addEventListener("keydown", onKeyDown, true);

    doc.body.appendChild(backdrop);
    declineBtn.focus();
  });
}

/**
 * Run one consented handoff via Native Messaging + cookies permission.
 * @param {string} sourceUrl
 * @param {string} origin exact consented scope (`scheme://host[:port]/`)
 */
async function handoffToDesktop(sourceUrl, origin) {
  const sendNativeMessage = (msg) => {
    const runtime = api && api.runtime;
    if (!runtime || typeof runtime.sendNativeMessage !== "function") {
      return Promise.reject(Object.assign(new Error("native host unavailable"), { code: "native-unavailable" }));
    }
    return runtime.sendNativeMessage(NATIVE_HOST_NAME, msg);
  };
  // Cookies + host permissions are requested only after the user clicks the
  // handoff button (explicit action). The consent dialog below names the
  // origins and cookie names before any value crosses to native.
  try {
    if (api && api.permissions && typeof api.permissions.request === "function") {
      const granted = await api.permissions.request({
        permissions: ["cookies"],
        origins: [origin + "*"],
      });
      if (!granted) {
        log("handoff declined: permission denied, continuing in extension");
        return;
      }
    }
  } catch {
    log("handoff declined: permission denied, continuing in extension");
    return;
  }
  let cookieNames = [];
  try {
    if (api && api.cookies && typeof api.cookies.getAll === "function") {
      const listed = await api.cookies.getAll({ url: sourceUrl });
      const names = [...new Set(listed.map((c) => c.name).filter((n) => typeof n === "string"))];
      cookieNames = names.slice(0, 64);
    }
  } catch {
    cookieNames = [];
  }
  const jobId = "job:page-" + Date.now();
  const result = await requestNativeHandoff({
    sourceUrl,
    origins: [origin],
    cookieNames,
    jobId,
    sendNativeMessage,
    getCookies: async (scope) => {
      const all = await api.cookies.getAll({ url: scope });
      return all.map((c) => ({ name: c.name, value: c.value }));
    },
    // Non-blocking consent modal (todo 4.5); decline/dismiss resolves false
    // and requestNativeHandoff keeps the job cookieless in the extension.
    showConsent: (details) => requestHandoffConsent(details),
  });
  if (result.ok && result.continuedCookieless) {
    log("handoff declined, continuing in extension");
  } else if (result.ok) {
    log("handoff started: " + (result.job ?? jobId));
    document.body.dataset.handoff = "started";
  } else {
    log("handoff failed: " + (result.code ?? "handoff-failed"));
  }
}

async function render() {
  const params = new URLSearchParams(location.search);
  const bound = params.get("tab");
  const tabsEl = document.getElementById("tabs");
  const boundId = bound !== null ? Number(bound) : NaN;
  if (bound !== null && Number.isInteger(boundId)) {
    uiState.lastTabId = boundId;
    // Bound to the clicked tab: single `tabs.get`, never `tabs.query`.
    let label = "tab " + boundId;
    try {
      const tab = await api.tabs.get(boundId);
      if (typeof tab.url === "string" && tab.url) label = tab.url;
    } catch {
      // Keep the generic label; run() reports a vanished tab on click.
    }
    tabsEl.replaceChildren(tabButton(boundId, label));
    const job = uiEl("dz-job");
    if (job) job.hidden = false;
    setStep("Ready to scan");
    renderExtHistory();
    return;
  }
  // Unbound first-run / manual open: guidance only, zero tabs API calls.
  // The user scans by clicking the toolbar button on a zoomable page,
  // which opens a bound page for exactly that tab.
  tabsEl.replaceChildren();
  const hint = document.createElement("p");
  hint.textContent =
    "Open a page with a zoomable image, then click the Dezoomify toolbar button to scan that tab.";
  tabsEl.appendChild(hint);
  log("ready: click the toolbar button on a zoomable page");
}

render();
