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
 */

import { createScanner, isPrivilegedUrl } from "./scan.js";
import { validateCandidateUrl } from "./candidates.js";
import { createSessionFetcher, originOf } from "./fetch.js";
import { requestNativeHandoff, NATIVE_HOST_NAME } from "./nativeHandoff.js";
import init, * as wasm from "../wasm/dezoomify-wasm.js";

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
  document.body.dataset.outcome = "failed";
};

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
  // Largest declared level that fits the browser canvas wins (same rule as
  // the webapp job: 16384 x 16384). Planning a gigapixel level would exhaust
  // memory serializing trillions of tiles, so when nothing fits the smallest
  // declared level is planned and the canvas check below fails it cheaply.
  const MAX_CANVAS_AREA = 16384 * 16384;
  let level = null;
  let bestArea = -1;
  let smallest = null;
  let smallestArea = Number.POSITIVE_INFINITY;
  let sawDeclared = false;
  let lastUndeclared = null;
  for (const candidate of image.levels) {
    const size = candidate.imageSize;
    if (!size) {
      lastUndeclared = candidate;
      continue;
    }
    sawDeclared = true;
    const area = size.x * size.y;
    if (area <= MAX_CANVAS_AREA && area >= bestArea) {
      level = candidate;
      bestArea = area;
    }
    if (area < smallestArea) {
      smallest = candidate;
      smallestArea = area;
    }
  }
  if (!level) level = sawDeclared ? smallest : lastUndeclared;
  let plan = JSON.parse(session.levelTiles(image.id, level.index));
  const fetcher = makeTabFetcher(tabOrigin);
  let guard = 0;
  while (plan.kind === "probe" && guard++ < 5) {
    const out = await fetcher.fetchResource(plan.uri, { userIntent: true });
    const bmp = await createImageBitmap(new Blob([out.bytes]));
    plan = JSON.parse(session.probeSubmit(image.id, level.index, bmp.width > 0, bmp.width, bmp.height));
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
  for (const tile of plan.tiles) {
    const out = await fetcher.fetchResource(tile.uri, { userIntent: true });
    let bytes = out.bytes;
    if (tile.processing) bytes = session.applyProcessing(tile.processing, bytes);
    const bmp = await createImageBitmap(new Blob([bytes]));
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
    const sample = ctx.getImageData(tile.x + 5, tile.y + 5, 1, 1).data;
    log("tile " + ++done + "/" + plan.tiles.length + " at " + tile.x + "," + tile.y + " bmp " + bmp.width + "px sample " + [...sample].join(","));
  }
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  return blob;
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
  try {
    const urls = await runScan(tabId);
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
    let found = null;
    for (let i = 0; i < ranked.length; i++) {
      const candidate = ranked[i];
      log("trying " + (i + 1) + "/" + ranked.length + (candidate.format ? " (" + candidate.format + ")" : ""));
      try {
        const result = await discover(candidate.url, tabOrigin);
        if (result.catalog.images && result.catalog.images.length > 0) {
          found = { ...result, source: candidate.url };
          break;
        }
        log("candidate has no image: " + candidate.url);
      } catch (e) {
        log("candidate failed: " + candidate.url + ": " + (e && e.message ? e.message : String(e)));
      }
    }
    if (!found) {
      throw Object.assign(new Error("no zoomable candidate observed"), { code: "no-candidate" });
    }
    const { session, catalog } = found;
    log("source: " + found.source);
    const image = catalog.images[0];
    if (!image) throw Object.assign(new Error("catalog has no image"), { code: "no-image" });
    log("image: " + (image.title || image.format));
    offerNativeHandoff(found.source);

    const plan = await planLevel(session, image, tabOrigin);
    log("plan: " + plan.tiles.length + " tiles, canvas " + plan.canvas.x + "x" + plan.canvas.y);
    const blob = await assemble(session, plan, tabOrigin);
    const savedName = save(blob, plan.canvas.x, plan.canvas.y);
    log("saved " + savedName);
    document.body.dataset.outcome = "saved";
  } catch (e) {
    fail(e.code || "job-failed", e.message + "\n" + (e.stack || ""));
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
 * destinations, durable jobs). Explicit consent names the destination
 * origins and cookie names; values cross once in a bounded message and are
 * never logged. Declining keeps the job in the extension.
 * @param {string} sourceUrl non-secret validated source
 */
function offerNativeHandoff(sourceUrl) {
  let origin;
  try {
    origin = new URL(sourceUrl).origin + "/";
  } catch {
    return;
  }
  const button = document.createElement("button");
  button.dataset.handoff = sourceUrl;
  button.textContent = "Send to desktop app (" + origin + ")";
  button.addEventListener("click", () => {
    handoffToDesktop(sourceUrl, origin).catch((e) => {
      log("handoff failed: " + (e && e.code ? e.code : "handoff-failed"));
    });
  });
  document.body.appendChild(button);
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
    // Bound to the clicked tab: single `tabs.get`, never `tabs.query`.
    let label = "tab " + boundId;
    try {
      const tab = await api.tabs.get(boundId);
      if (typeof tab.url === "string" && tab.url) label = tab.url;
    } catch {
      // Keep the generic label; run() reports a vanished tab on click.
    }
    tabsEl.replaceChildren(tabButton(boundId, label));
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
