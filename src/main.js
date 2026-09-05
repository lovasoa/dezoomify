// GENERATED from src/main.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: src/main.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Web application entry point (single source of truth; `./main.js` is
// generated from this file by `scripts/sync-web-js.mjs`, never hand-edited).
// Real pipeline: worker-hosted wasm core discovery -> direct-first transport
// with automatic eligible metadata-proxy fallback -> tile download -> canvas
// assembly -> real PNG save. Nothing here fabricates progress or completion.
import { createController } from "../packages/shared-ui/src/controller.js";
import { renderView, showDesktopAppGuidance, showExtensionGuidance } from "../packages/shared-ui/src/view.js";

import {
  RATE_LIMITED_BY_SITE_MESSAGE,
  SITE_BUSY_MESSAGE,
  classifyReadableBytes,
  noImageFoundError,
} from "./discovery.js";
import { buildHash, looksLikeUsableUrl, parseHash } from "./hash.js";
import { isProxyEligible } from "./webIntegration.js";
import { createProxyTransport, PROXY_METADATA_MAX_BYTES } from "./proxyTransport.js";
import {
  createDiscoveryClient,
  failure,

} from "../packages/browser-runtime/src/session.js";

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;
let activeTransport                = null;
/** User opt-out for the metadata CORS proxy (UI toggle; default allows fallback). */
let proxyOptOut = false;
let client                         = null;
let jobToken = 0;
let resultBlobUrl                = null;

/** Per-request timeout applied to every individual HTTP request (30 s). */
export const REQUEST_TIMEOUT_MS = 30000;

// --- Live job activity (drives the progressive-disclosure job view) ---
let requestSeq = 0;
const pendingStarts = new Map                                              ();
let completedRequests = 0;
let failedRequests = 0;
let heartbeatTimer                                        = null;
let suppressHashWrite = false;

function activity()                                          {
  if (!viewCtx.jobActivity) viewCtx.jobActivity = { timeoutMs: REQUEST_TIMEOUT_MS };
  return viewCtx.jobActivity                                           ;
}

function resetActivity(url        )       {
  pendingStarts.clear();
  completedRequests = 0;
  failedRequests = 0;
  const now = Date.now();
  viewCtx.jobActivity = {
    url,
    startedAt: now,
    now,
    stepLabel: "Finding the zoomable image…",
    detail: "Contacting the museum server…",
    pendingRequests: 0,
    completedRequests: 0,
    failedRequests: 0,
    longestPendingMs: 0,
    timeoutMs: REQUEST_TIMEOUT_MS,
    lastProgressAt: now,
    log: [],
  };
}

function touchProgress()       {
  activity().lastProgressAt = Date.now();
}

function setStep(label        , detail         )       {
  const a = activity();
  a.stepLabel = label;
  if (detail !== undefined) a.detail = detail;
  touchProgress();
  update();
}

function pushLog(line        )       {
  const a = activity();
  if (!a.log) a.log = [];
  const elapsed = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
  a.log.push(`${elapsed}s: ${line}`);
  if (a.log.length > 60) a.log.splice(0, a.log.length - 60);
}

function noteRequestStart(label        )         {
  const id = ++requestSeq;
  pendingStarts.set(id, { startedAt: Date.now(), label });
  const a = activity();
  a.pendingRequests = pendingStarts.size;
  refreshLongestPending();
  return id;
}

function noteRequestEnd(id        , ok         )       {
  pendingStarts.delete(id);
  if (ok) completedRequests += 1;
  else failedRequests += 1;
  const a = activity();
  a.pendingRequests = pendingStarts.size;
  a.completedRequests = completedRequests;
  a.failedRequests = failedRequests;
  refreshLongestPending();
  touchProgress();
}

function refreshLongestPending()       {
  const a = activity();
  const now = Date.now();
  a.now = now;
  let longest = 0;
  for (const { startedAt } of pendingStarts.values()) {
    longest = Math.max(longest, now - startedAt);
  }
  a.longestPendingMs = longest;
}

function startHeartbeat()       {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    refreshLongestPending();
    update();
  }, 500);
  const t = heartbeatTimer                                     ;
  if (t && typeof t.unref === "function") {
    try {
      t.unref();
    } catch {
      // browser timers lack unref
    }
  }
}

function stopHeartbeat()       {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

/**
 * Combine a caller signal with the 30 s per-request timeout.
 * Uses AbortSignal.any/timeout when available, manual wiring otherwise.
 */
function timeoutSignal(parentSignal              , ms         = REQUEST_TIMEOUT_MS)                  {
  const AS = AbortSignal

   ;
  if (typeof AbortSignal !== "undefined" && typeof AS.timeout === "function") {
    const timeout = (AS.timeout                               )(ms);
    if (parentSignal && typeof AS.any === "function") {
      return { signal: (AS.any                                     )([parentSignal, timeout]), cleanup() {} };
    }
    if (!parentSignal) return { signal: timeout, cleanup() {} };
  }
  const ctrl = new AbortController();
  let timer                                       = null;
  let onAbort                      = null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (parentSignal && onAbort) parentSignal.removeEventListener("abort", onAbort);
  };
  if (parentSignal?.aborted) {
    ctrl.abort((parentSignal                                      ).reason);
    return { signal: ctrl.signal, cleanup() {}, timedOut: () => false };
  }
  let timedOut = false;
  timer = setTimeout(() => {
    timedOut = true;
    try {
      ctrl.abort(new DOMException(`Request timed out after ${ms / 1000}s`, "TimeoutError"));
    } catch {
      ctrl.abort();
    }
  }, ms);
  if (parentSignal) {
    onAbort = () => {
      cleanup();
      try {
        ctrl.abort((parentSignal                                      ).reason);
      } catch {
        ctrl.abort();
      }
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ctrl.signal, cleanup, timedOut: () => timedOut };
}

function nextEvent(kind        , extra                          = {}) {
  currentSeq++;
  return { seq: currentSeq, sessionId, kind, ...extra };
}

function isAllowedSourceUrl(urlString        )          {
  try {
    const u = new URL(urlString);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    if (u.protocol === "http:") {
      const host = u.hostname.toLowerCase();
      const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
      if (!loopback) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function fetchDirect(url        , headers                         , signal              )                         {
  const reqId = noteRequestStart("direct");
  const combined = timeoutSignal(signal);
  try {
    const res = await fetch(url, { headers, signal: combined.signal, credentials: "omit" });
    if (!res.ok) {
      noteRequestEnd(reqId, false);
      return { outcome: "http-error", finalUrl: res.url, status: res.status };
    }
    const bytes = await res.arrayBuffer();
    noteRequestEnd(reqId, true);
    return { outcome: "readable", finalUrl: res.url, status: res.status, bytes };
  } catch (e) {
    noteRequestEnd(reqId, false);
    if (signal?.aborted) return { outcome: "cancelled" };
    const name = (e                     )?.name;
    if (name === "TimeoutError" || (combined.timedOut && combined.timedOut())) {
      pushLog(`Request timed out after 30 s: ${shortUrl(url)}`);
      return { outcome: "network-error" };
    }
    return { outcome: "network-error" };
  } finally {
    combined.cleanup();
    update();
  }
}

function shortUrl(url        )         {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? `…${u.pathname.slice(-39)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return String(url).slice(0, 60);
  }
}

// Shared metadata-proxy client (single policy implementation; the inline
// duplicate is gone). Pre-checks credential-bearing targets, cancellation,
// and the response-size budget; status codes map to stable machine-readable
// codes. Request timing instrumentation stays here so the live job view
// keeps counting proxy attempts.
const proxyTransport = createProxyTransport(
  (input        , init                          ) =>
    fetch(input, init               ).then((res) => ({
      status: res.status,
      headers: res.headers,
      arrayBuffer: () => res.arrayBuffer(),
    })),
  { protocolVersion: 1, maxBytes: PROXY_METADATA_MAX_BYTES },
);

async function fetchViaProxy(targetUrl        , signal              )                                                                               {
  const reqId = noteRequestStart("proxy");
  const combined = timeoutSignal(signal);
  try {
    const res = await proxyTransport.fetchViaProxy(targetUrl, { signal: combined.signal });
    if (!res.ok) {
      noteRequestEnd(reqId, false);
      return { ok: false, status: res.status, code: res.code ?? "PROXY_ERROR" };
    }
    noteRequestEnd(reqId, true);
    return { ok: true, status: res.status, bytes: res.bytes };
  } catch (e) {
    noteRequestEnd(reqId, false);
    if (signal?.aborted) return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    if (((e                     )?.name === "TimeoutError") || (combined.timedOut && combined.timedOut())) {
      pushLog("Metadata proxy request timed out after 30 s.");
      return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
    }
    return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
  } finally {
    combined.cleanup();
    update();
  }
}

const DIRECT_LABEL = "Direct from your browser";
const PROXY_LABEL = "Metadata proxy";

/**
 * Fetch one metadata resource for discovery: direct first, then the eligible
 * metadata proxy after a classified network failure. The zoomable-content
 * classifier gates every success: generic pages fail with NO_IMAGE_FOUND.
 */
async function fetchMetadataFor(
  url        ,
  headers                        ,
)                                                                  {
  activeTransport = DIRECT_LABEL;
  const direct = await fetchDirect(url, headers);
  let via = "direct";
  let bytes                     = null;
  if (direct.outcome === "readable" && direct.bytes) {
    bytes = direct.bytes;
  } else if (
    direct.outcome === "network-error" &&
    isProxyEligible({ url, kind: "metadata", headers }, { proxyOptOut }).eligible
  ) {
    activeTransport = PROXY_LABEL;
    via = "proxy";
    const proxied = await fetchViaProxy(url);
    if (!proxied.ok || !proxied.bytes) {
      if (proxied.code === "PROXY_RATE_LIMITED") {
        throw failure("UPSTREAM_RATE_LIMITED", RATE_LIMITED_BY_SITE_MESSAGE, true);
      }
      throw failure("PROXY_ERROR", "The metadata proxy could not fetch this address.", false);
    }
    bytes = proxied.bytes;
  } else if (direct.outcome === "http-error") {
    if (direct.status === 429) {
      // A direct fetch uses the user's own connection, so this throttle is on
      // their IP, not on our server; the fix is waiting, not another app.
      throw failure("UPSTREAM_RATE_LIMITED", SITE_BUSY_MESSAGE, true);
    }
    throw failure("DISCOVERY_HTTP_ERROR", `The server answered HTTP ${direct.status}.`, false);
  } else {
    throw failure("DISCOVERY_FAILED", "Could not fetch this address.");
  }
  const verdict = classifyReadableBytes(bytes, { via });
  if (!verdict.found) {
    throw failure("NO_IMAGE_FOUND", noImageFoundError(via).message, false);
  }
  return { bytes, finalUri: direct.finalUrl, via };
}

async function fetchTileFor(url        , headers                        )                                  {
  const direct = await fetchDirect(url, headers);
  if (direct.outcome !== "readable" || !direct.bytes) {
    throw failure("TILE_FAILED", `Tile request failed (HTTP ${direct.status ?? "network"}).`);
  }
  return { bytes: direct.bytes };
}

async function probeSizeFor(
  url        ,
  headers                        ,
)                                                          {
  try {
    const { bytes } = await fetchTileFor(url, headers);
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const size = { ok: bitmap.width > 0 && bitmap.height > 0, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { ok: false, width: 0, height: 0 };
  }
}

function disposeClient()       {
  client?.dispose();
  client = null;
}

function reportProgress(current        , total        , message        )       {
  viewCtx.currentProgress = { current, total, message };
  touchProgress();
  update();
}

function writeHash(url        )       {
  if (suppressHashWrite || typeof window === "undefined" || !window.location) return;
  try {
    // Legacy contract: the hash body IS the target URL (`#https://…`).
    window.location.hash = buildHash(url);
  } catch {
    // Hash writes must never break the job.
  }
}

function clearHash()       {
  if (typeof window === "undefined") return;
  try {
    if (window.history && typeof window.history.replaceState === "function") {
      const clean = `${window.location.pathname}${window.location.search}`;
      window.history.replaceState(null, "", clean);
    } else {
      window.location.hash = "";
    }
  } catch {
    // Hash cleanup must never break reset.
  }
}

function makeClient()                  {
  disposeClient();
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return createDiscoveryClient({
    worker,
    fetchMetadata: fetchMetadataFor,
    fetchTile: fetchTileFor,
    probeSize: probeSizeFor,
  });
}

/** Largest declared level wins; undeclared sizes keep the last level. */
function pickLevel(image                                                                            )              {
  let best                     = null;
  let bestArea = -1;
  for (const level of image.levels) {
    const size = level.imageSize;
    const area = size ? size.x * size.y : -1;
    if (area >= bestArea) {
      best = { index: level.index };
      bestArea = area;
    }
  }
  return best ?? { index: 0 };
}

async function drawTile(client2                 , ctx2d                          , tile          )                {
  let { bytes } = await fetchTileFor(tile.uri, tile.headers ?? {});
  if (tile.processing && tile.processing !== "none") {
    bytes = await client2.process(tile.processing, bytes);
  }
  const bitmap = await createImageBitmap(new Blob([bytes]));
  try {
    const w = Math.min(tile.w ?? bitmap.width, bitmap.width);
    const h = Math.min(tile.h ?? bitmap.height, bitmap.height);
    if (w > 0 && h > 0) {
      ctx2d.drawImage(bitmap, 0, 0, w, h, tile.x, tile.y, w, h);
    }
  } finally {
    bitmap.close();
  }
}

async function runJob(url        )                {
  const token = ++jobToken;
  resetActivity(url);
  writeHash(url);
  startHeartbeat();
  setStep("Finding the zoomable image…", "Contacting the museum server…");
  controller.dispatch(nextEvent("start-discovery", { transport: "direct" })         );
  update();
  try {
    client = makeClient();
    pushLog(`Starting discovery for ${shortUrl(url)}`);
    const catalog             = await client.start(url);
    if (token !== jobToken) return;
    pushLog(`Found ${catalog.images.length} image${catalog.images.length === 1 ? "" : "s"}`);
    const image = catalog.images[0];
    const via = activeTransport === PROXY_LABEL ? "proxy" : "direct";
    controller.dispatch(
      nextEvent("images-found", { imageCount: catalog.images.length, transport: via })         ,
    );
    setStep("Image found — picking the best one…");
    controller.dispatch(nextEvent("image-chosen")         );
    const level = pickLevel(image);
    setStep("Choosing the highest resolution…");
    controller.dispatch(nextEvent("level-chosen")         );
    setStep("Checking the image size…");
    controller.dispatch(nextEvent("preflight-ok", { transport: via })         );
    update();

    const plan = await client.plan(image.id, level.index);
    if (token !== jobToken) return;
    pushLog(`Image size determined; planning ${plan.tiles.length} tiles`);
    const canvas = document.getElementById("rendering-canvas")                            ;
    if (!canvas) throw failure("WORKER_FAILED", "no rendering canvas", false);
    const width = plan.canvas ? plan.canvas.x : 0;
    const height = plan.canvas ? plan.canvas.y : 0;
    if (!(width > 0 && height > 0 && width * height <= 268435456)) {
      throw failure("PLAN_INVALID", "The image size could not be determined.", false);
    }
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext("2d")                            ;
    ctx2d.clearRect(0, 0, width, height);

    const total = plan.tiles.length;
    setStep("Downloading image tiles…", `${total} tiles at full resolution`);
    reportProgress(0, total, `Downloading ${total} tiles…`);
    let done = 0;
    let failed          = null;
    const queue = [...plan.tiles];
    const tileWorker = async ()                => {
      while (queue.length && !failed) {
        const tile = queue.shift();
        if (!tile) return;
        try {
          await drawTile(client                   , ctx2d, tile);
        } catch (error) {
          failed = error;
          return;
        }
        if (token !== jobToken) return;
        done += 1;
        reportProgress(done, total, `Downloading ${total} tiles…`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, Math.max(1, total)) }, tileWorker));
    if (failed) throw failed;
    if (token !== jobToken) return;

    controller.dispatch(nextEvent("save-start")         );
    setStep("Assembling the final picture…", "Encoding PNG in your browser");
    reportProgress(total, total, "Encoding PNG…");
    const blob = await new Promise      ((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))),
        "image/png",
      );
    });
    if (resultBlobUrl) URL.revokeObjectURL(resultBlobUrl);
    resultBlobUrl = URL.createObjectURL(blob);
    viewCtx.completedInfo = {
      width,
      height,
      mime: "image/png",
      blobUrl: resultBlobUrl,
    };
    viewCtx.originClean = true;
    pushLog(`Done: ${width}×${height} PNG (${total} tiles)`);
    controller.dispatch(nextEvent("save-done")         );
    update();
  } catch (error) {
    if (token !== jobToken) return;
    const code = (error                     )?.code || "DISCOVERY_FAILED";
    pushLog(`Failed (${code}): ${((error         )?.message) || "unknown error"}`);
    controller.dispatch(
      nextEvent("fail", {
        error: {
          code,
          category: code === "NO_IMAGE_FOUND" ? "discovery" : "transport",
          retryable: (error                           )?.retryable ?? code !== "NO_IMAGE_FOUND",
          message:
            (error         )?.message || "Could not download this zoomable image.",
          transport: activeTransport ?? "direct",
          phase: code === "NO_IMAGE_FOUND" ? "discovery" : "acquisition",
        },
      })         ,
    );
    update();
  } finally {
    if (token === jobToken) {
      stopHeartbeat();
      refreshLongestPending();
      disposeClient();
    }
  }
}

const appContainer = typeof document !== "undefined" ? document.getElementById("app") : null;

let viewCtx              = {
  capabilities: {
    extensionAvailable: false,
    nativeAvailable: false,
    browserCanSave: true,
  },
  originClean: true,
  initialUrl: undefined,
  proxyOptOut: false,
};

function update()       {
  if (!appContainer) return;
  const state = controller.getState();
  if (activeTransport && !state.transport) {
    state.transport = activeTransport;
  }
  if (viewCtx.jobActivity) refreshLongestPending();
  renderView(
    appContainer,
    state,
    {
      onSubmitUrl(url        ) {
        if (!isAllowedSourceUrl(url)) {
          controller.dispatch(
            nextEvent("fail", {
              error: {
                code: "INVALID_URL",
                category: "validation",
                retryable: false,
                message: "Please enter a valid web address starting with https://",
              },
            })         ,
          );
          update();
          return;
        }
        runJob(url);
      },
      onCancel() {
        jobToken += 1;
        stopHeartbeat();
        disposeClient();
        controller.dispatch(nextEvent("cancel")         );
        update();
      },
      onReset() {
        jobToken += 1;
        stopHeartbeat();
        disposeClient();
        sessionId = `sess:web-${Date.now()}`;
        controller.reset(sessionId);
        currentSeq = 0;
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
        viewCtx.jobActivity = undefined;
        viewCtx.initialUrl = undefined;
        activeTransport = null;
        clearHash();
        if (resultBlobUrl) {
          URL.revokeObjectURL(resultBlobUrl);
          resultBlobUrl = null;
        }
        update();
      },
      onSave() {
        if (!resultBlobUrl) return;
        const anchor = document.createElement("a");
        anchor.href = resultBlobUrl;
        anchor.download = "zoomed-image.png";
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      },
      onToggleProxyOptOut(optOut         ) {
        // Session-scoped only (no storage effect). The checkbox already
        // reflects the choice, so no re-render here (it would steal focus).
        proxyOptOut = optOut;
        viewCtx.proxyOptOut = optOut;
      },
      onCopyShareLink() {
        const href = (typeof window !== "undefined" && window.location && window.location.href) || "";
        const btn = document.getElementById("dz-btn-share");
        const done = () => {
          if (btn) {
            btn.textContent = "Copied!";
            setTimeout(() => {
              try {
                if (btn.isConnected) btn.textContent = "Copy shareable link";
              } catch {
                // Button may be gone after re-render; ignore.
              }
            }, 2000);
          }
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            (navigator.clipboard.writeText(href)                 ).then(done, done);
          } else if (href) {
            const ta = document.createElement("textarea");
            ta.value = href;
            document.body.appendChild(ta);
            ta.select();
            document.execCommand("copy");
            ta.remove();
            done();
          }
        } catch {
          // Copy failures stay silent; the address bar link still works.
        }
      },
    },
    viewCtx,
  );
}

function startFromHash()       {
  if (typeof window === "undefined") return;
  const raw = parseHash(window.location.hash);
  if (raw && looksLikeUsableUrl(raw) && isAllowedSourceUrl(raw)) {
    viewCtx.initialUrl = raw;
    update();
    runJob(raw);
  } else if (raw) {
    viewCtx.initialUrl = raw;
    update();
  }
}

if (appContainer) {
  document.getElementById("dz-nav-btn-extension")?.addEventListener("click", () => showExtensionGuidance());
  document.getElementById("dz-nav-btn-desktop")?.addEventListener("click", () => showDesktopAppGuidance());
  if (typeof window !== "undefined") {
    window.addEventListener("hashchange", () => {
      const raw = parseHash(window.location.hash);
      const current = viewCtx.jobActivity?.url;
      if (raw && raw !== current && looksLikeUsableUrl(raw) && isAllowedSourceUrl(raw)) {
        suppressHashWrite = false;
        runJob(raw);
      } else if (!raw && !current) {
        viewCtx.initialUrl = undefined;
        update();
      }
    });
  }
  startFromHash();
  update();
}

export { controller, update };
