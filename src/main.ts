// Web application entry point (typed twin of main.js; keep both in sync).
// Real pipeline: worker-hosted wasm core discovery -> direct-first transport
// with automatic eligible metadata-proxy fallback -> tile download -> canvas
// assembly -> real PNG save. Nothing here fabricates progress or completion.
import { createController } from "../packages/shared-ui/src/controller.ts";
import { renderView, showDesktopAppGuidance, showExtensionGuidance } from "../packages/shared-ui/src/view.ts";
import type { ViewContext } from "../packages/shared-ui/src/view.ts";
import {
  RATE_LIMITED_BY_SITE_MESSAGE,
  SITE_BUSY_MESSAGE,
  classifyReadableBytes,
  noImageFoundError,
} from "./discovery.ts";
import { buildHash, looksLikeUsableUrl, parseHash } from "./hash.ts";
import {
  createDiscoveryClient,
  failure,
  type DiscoveryClient,
  type PlanTile,
  type WebCatalog,
} from "../packages/browser-runtime/src/session.ts";

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;
let activeTransport: string | null = null;
let client: DiscoveryClient | null = null;
let jobToken = 0;
let resultBlobUrl: string | null = null;

/** Per-request timeout applied to every individual HTTP request (30 s). */
export const REQUEST_TIMEOUT_MS = 30000;

// --- Live job activity (drives the progressive-disclosure job view) ---
let requestSeq = 0;
const pendingStarts = new Map<number, { startedAt: number; label: string }>();
let completedRequests = 0;
let failedRequests = 0;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let suppressHashWrite = false;

function activity(): NonNullable<ViewContext["jobActivity"]> {
  if (!viewCtx.jobActivity) viewCtx.jobActivity = { timeoutMs: REQUEST_TIMEOUT_MS };
  return viewCtx.jobActivity as NonNullable<ViewContext["jobActivity"]>;
}

function resetActivity(url: string): void {
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

function touchProgress(): void {
  activity().lastProgressAt = Date.now();
}

function setStep(label: string, detail?: string): void {
  const a = activity();
  a.stepLabel = label;
  if (detail !== undefined) a.detail = detail;
  touchProgress();
  update();
}

function pushLog(line: string): void {
  const a = activity();
  if (!a.log) a.log = [];
  const elapsed = a.startedAt ? Math.round((Date.now() - a.startedAt) / 1000) : 0;
  a.log.push(`${elapsed}s: ${line}`);
  if (a.log.length > 60) a.log.splice(0, a.log.length - 60);
}

function noteRequestStart(label: string): number {
  const id = ++requestSeq;
  pendingStarts.set(id, { startedAt: Date.now(), label });
  const a = activity();
  a.pendingRequests = pendingStarts.size;
  refreshLongestPending();
  return id;
}

function noteRequestEnd(id: number, ok: boolean): void {
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

function refreshLongestPending(): void {
  const a = activity();
  const now = Date.now();
  a.now = now;
  let longest = 0;
  for (const { startedAt } of pendingStarts.values()) {
    longest = Math.max(longest, now - startedAt);
  }
  a.longestPendingMs = longest;
}

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    refreshLongestPending();
    update();
  }, 500);
  const t = heartbeatTimer as unknown as { unref?: () => void };
  if (t && typeof t.unref === "function") {
    try {
      t.unref();
    } catch {
      // browser timers lack unref
    }
  }
}

function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

interface TimeoutCombined {
  signal: AbortSignal;
  cleanup(): void;
  timedOut?: () => boolean;
}

/**
 * Combine a caller signal with the 30 s per-request timeout.
 * Uses AbortSignal.any/timeout when available, manual wiring otherwise.
 */
function timeoutSignal(parentSignal?: AbortSignal, ms: number = REQUEST_TIMEOUT_MS): TimeoutCombined {
  const AS = AbortSignal as unknown as {
    timeout?: (ms: number) => AbortSignal;
    any?: (signals: AbortSignal[]) => AbortSignal;
  };
  if (typeof AbortSignal !== "undefined" && typeof AS.timeout === "function") {
    const timeout = (AS.timeout as (ms: number) => AbortSignal)(ms);
    if (parentSignal && typeof AS.any === "function") {
      return { signal: (AS.any as (s: AbortSignal[]) => AbortSignal)([parentSignal, timeout]), cleanup() {} };
    }
    if (!parentSignal) return { signal: timeout, cleanup() {} };
  }
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (parentSignal && onAbort) parentSignal.removeEventListener("abort", onAbort);
  };
  if (parentSignal?.aborted) {
    ctrl.abort((parentSignal as AbortSignal & { reason?: unknown }).reason);
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
        ctrl.abort((parentSignal as AbortSignal & { reason?: unknown }).reason);
      } catch {
        ctrl.abort();
      }
    };
    parentSignal.addEventListener("abort", onAbort, { once: true });
  }
  return { signal: ctrl.signal, cleanup, timedOut: () => timedOut };
}

function nextEvent(kind: string, extra: Record<string, unknown> = {}) {
  currentSeq++;
  return { seq: currentSeq, sessionId, kind, ...extra };
}

function isAllowedSourceUrl(urlString: string): boolean {
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

function isPrivateOrLocalHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === "localhost" || h === "localhost." || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".lan")) return true;
  if (h === "127.0.0.1" || h.startsWith("127.") || h === "10.0.0.1") return true;
  if (h.startsWith("10.") || h.startsWith("192.168.") || h.startsWith("169.254.")) return true;
  if (h === "::1" || h === "[::1]") return true;
  const m = h.match(/^172\.(\d+)\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return false;
}

function hasSignedQuery(urlString: string): boolean {
  try {
    const u = new URL(urlString);
    for (const k of u.searchParams.keys()) {
      const l = k.toLowerCase();
      if (
        l === "token" || l === "signature" || l === "sig" || l === "auth" ||
        l === "key" || l === "session" || l === "sid" || l === "ticket" ||
        l === "secret" || l === "password"
      ) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isProxyEligible(urlString: string): boolean {
  let u: URL;
  try {
    u = new URL(urlString);
  } catch {
    return false;
  }
  if (u.username !== "" || u.password !== "") return false;
  if (hasSignedQuery(urlString)) return false;
  if (isPrivateOrLocalHostname(u.hostname)) return false;
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  return true;
}

interface DirectOutcome {
  outcome: "readable" | "http-error" | "network-error" | "cancelled";
  finalUrl?: string;
  status?: number;
  bytes?: ArrayBuffer;
}

async function fetchDirect(url: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<DirectOutcome> {
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
    const name = (e as { name?: string })?.name;
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

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? `…${u.pathname.slice(-39)}` : u.pathname;
    return `${u.host}${path}`;
  } catch {
    return String(url).slice(0, 60);
  }
}

async function fetchViaProxy(targetUrl: string, signal?: AbortSignal): Promise<{ ok: boolean; status: number; bytes?: ArrayBuffer; code?: string }> {
  const reqId = noteRequestStart("proxy");
  const combined = timeoutSignal(signal);
  try {
    const res = await fetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl, protocolVersion: 1 }),
      signal: combined.signal,
      credentials: "omit",
    });
    if (!res.ok) {
      // Surface the proxy's machine-readable error code (e.g. PROXY_RATE_LIMITED
      // means the upstream site throttled our server) instead of collapsing
      // every failure into one generic code.
      noteRequestEnd(reqId, false);
      let code = "PROXY_ERROR";
      try {
        const body = (await res.json()) as { code?: unknown };
        if (body && typeof body.code === "string") code = body.code;
      } catch {
        // Unreadable body keeps the generic code.
      }
      return { ok: false, status: res.status, code };
    }
    const bytes = await res.arrayBuffer();
    noteRequestEnd(reqId, true);
    return { ok: true, status: 200, bytes };
  } catch (e) {
    noteRequestEnd(reqId, false);
    if (signal?.aborted) return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    if (((e as { name?: string })?.name === "TimeoutError") || (combined.timedOut && combined.timedOut())) {
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
  url: string,
  headers: Record<string, string>,
): Promise<{ bytes: ArrayBuffer; finalUri?: string; via: string }> {
  activeTransport = DIRECT_LABEL;
  const direct = await fetchDirect(url, headers);
  let via = "direct";
  let bytes: ArrayBuffer | null = null;
  if (direct.outcome === "readable" && direct.bytes) {
    bytes = direct.bytes;
  } else if (direct.outcome === "network-error" && isProxyEligible(url)) {
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

async function fetchTileFor(url: string, headers: Record<string, string>): Promise<{ bytes: ArrayBuffer }> {
  const direct = await fetchDirect(url, headers);
  if (direct.outcome !== "readable" || !direct.bytes) {
    throw failure("TILE_FAILED", `Tile request failed (HTTP ${direct.status ?? "network"}).`);
  }
  return { bytes: direct.bytes };
}

async function probeSizeFor(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; width: number; height: number }> {
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

function disposeClient(): void {
  client?.dispose();
  client = null;
}

function reportProgress(current: number, total: number, message: string): void {
  viewCtx.currentProgress = { current, total, message };
  touchProgress();
  update();
}

function writeHash(url: string): void {
  if (suppressHashWrite || typeof window === "undefined" || !window.location) return;
  try {
    // Legacy contract: the hash body IS the target URL (`#https://…`).
    window.location.hash = buildHash(url);
  } catch {
    // Hash writes must never break the job.
  }
}

function clearHash(): void {
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

function makeClient(): DiscoveryClient {
  disposeClient();
  const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  return createDiscoveryClient({
    worker,
    fetchMetadata: fetchMetadataFor,
    fetchTile: fetchTileFor,
    probeSize: probeSizeFor,
  });
}

interface PickedLevel {
  index: number;
}

/** Largest declared level wins; undeclared sizes keep the last level. */
function pickLevel(image: { levels: Array<{ index: number; imageSize?: { x: number; y: number } }> }): PickedLevel {
  let best: PickedLevel | null = null;
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

async function drawTile(client2: DiscoveryClient, ctx2d: CanvasRenderingContext2D, tile: PlanTile): Promise<void> {
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

async function runJob(url: string): Promise<void> {
  const token = ++jobToken;
  resetActivity(url);
  writeHash(url);
  startHeartbeat();
  setStep("Finding the zoomable image…", "Contacting the museum server…");
  controller.dispatch(nextEvent("start-discovery", { transport: "direct" }) as never);
  update();
  try {
    client = makeClient();
    pushLog(`Starting discovery for ${shortUrl(url)}`);
    const catalog: WebCatalog = await client.start(url);
    if (token !== jobToken) return;
    pushLog(`Found ${catalog.images.length} image${catalog.images.length === 1 ? "" : "s"}`);
    const image = catalog.images[0];
    const via = activeTransport === PROXY_LABEL ? "proxy" : "direct";
    controller.dispatch(
      nextEvent("images-found", { imageCount: catalog.images.length, transport: via }) as never,
    );
    setStep("Image found — picking the best one…");
    controller.dispatch(nextEvent("image-chosen") as never);
    const level = pickLevel(image);
    setStep("Choosing the highest resolution…");
    controller.dispatch(nextEvent("level-chosen") as never);
    setStep("Checking the image size…");
    controller.dispatch(nextEvent("preflight-ok", { transport: via }) as never);
    update();

    const plan = await client.plan(image.id, level.index);
    if (token !== jobToken) return;
    pushLog(`Image size determined; planning ${plan.tiles.length} tiles`);
    const canvas = document.getElementById("rendering-canvas") as HTMLCanvasElement | null;
    if (!canvas) throw failure("WORKER_FAILED", "no rendering canvas", false);
    const width = plan.canvas ? plan.canvas.x : 0;
    const height = plan.canvas ? plan.canvas.y : 0;
    if (!(width > 0 && height > 0 && width * height <= 268435456)) {
      throw failure("PLAN_INVALID", "The image size could not be determined.", false);
    }
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext("2d") as CanvasRenderingContext2D;
    ctx2d.clearRect(0, 0, width, height);

    const total = plan.tiles.length;
    setStep("Downloading image tiles…", `${total} tiles at full resolution`);
    reportProgress(0, total, `Downloading ${total} tiles…`);
    let done = 0;
    let failed: unknown = null;
    const queue = [...plan.tiles];
    const tileWorker = async (): Promise<void> => {
      while (queue.length && !failed) {
        const tile = queue.shift();
        if (!tile) return;
        try {
          await drawTile(client as DiscoveryClient, ctx2d, tile);
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

    controller.dispatch(nextEvent("save-start") as never);
    setStep("Assembling the final picture…", "Encoding PNG in your browser");
    reportProgress(total, total, "Encoding PNG…");
    const blob = await new Promise<Blob>((resolve, reject) => {
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
    controller.dispatch(nextEvent("save-done") as never);
    update();
  } catch (error) {
    if (token !== jobToken) return;
    const code = (error as { code?: string })?.code || "DISCOVERY_FAILED";
    pushLog(`Failed (${code}): ${((error as Error)?.message) || "unknown error"}`);
    controller.dispatch(
      nextEvent("fail", {
        error: {
          code,
          category: code === "NO_IMAGE_FOUND" ? "discovery" : "transport",
          retryable: (error as { retryable?: boolean })?.retryable ?? code !== "NO_IMAGE_FOUND",
          message:
            (error as Error)?.message || "Could not download this zoomable image.",
          transport: activeTransport ?? "direct",
          phase: code === "NO_IMAGE_FOUND" ? "discovery" : "acquisition",
        },
      }) as never,
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

let viewCtx: ViewContext = {
  capabilities: {
    extensionAvailable: false,
    nativeAvailable: false,
    browserCanSave: true,
  },
  originClean: true,
  initialUrl: undefined,
};

function update(): void {
  if (!appContainer) return;
  // Preserve open <details> across heartbeat re-renders so the collapsed
  // technical logs don't snap shut while elapsed time ticks.
  const openDetails: number[] = [];
  try {
    appContainer.querySelectorAll("details").forEach((d, i) => {
      if ((d as HTMLDetailsElement).open) openDetails.push(i);
    });
  } catch {
    // Non-fatal: re-render without preservation.
  }
  const state = controller.getState();
  if (activeTransport && !state.transport) {
    state.transport = activeTransport;
  }
  if (viewCtx.jobActivity) refreshLongestPending();
  renderView(
    appContainer,
    state,
    {
      onSubmitUrl(url: string) {
        if (!isAllowedSourceUrl(url)) {
          controller.dispatch(
            nextEvent("fail", {
              error: {
                code: "INVALID_URL",
                category: "validation",
                retryable: false,
                message: "Please enter a valid web address starting with https://",
              },
            }) as never,
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
        controller.dispatch(nextEvent("cancel") as never);
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
            (navigator.clipboard.writeText(href) as Promise<void>).then(done, done);
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
  try {
    const details = appContainer.querySelectorAll("details");
    for (const i of openDetails) {
      const el = details[i] as HTMLDetailsElement | undefined;
      if (el) el.open = true;
    }
  } catch {
    // Non-fatal.
  }
}

function startFromHash(): void {
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
