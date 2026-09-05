// Web application entry point (browser ES module, no build step).
// Real pipeline: worker-hosted wasm core discovery -> direct-first transport
// with automatic eligible metadata-proxy fallback -> tile download -> canvas
// assembly -> real PNG save. Nothing here fabricates progress or completion.
import { createController } from "../packages/shared-ui/src/controller.js";
import { renderView, showDesktopAppGuidance, showExtensionGuidance } from "../packages/shared-ui/src/view.js";
import {
  RATE_LIMITED_BY_SITE_MESSAGE,
  SITE_BUSY_MESSAGE,
  classifyDiscovery,
  classifyReadableBytes,
  noImageFoundError,
} from "./discovery.js";
import { createDiscoveryClient } from "../packages/browser-runtime/src/session.js";

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;
let activeTransport = null;
let client = null;
let jobToken = 0;
let resultBlobUrl = null;

function nextEvent(kind, extra = {}) {
  currentSeq++;
  return { seq: currentSeq, sessionId, kind, ...extra };
}

function isAllowedSourceUrl(urlString) {
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

function isPrivateOrLocalHostname(hostname) {
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

function hasSignedQuery(urlString) {
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

function isProxyEligible(urlString) {
  let u;
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

async function fetchDirect(url, headers, signal) {
  try {
    const res = await fetch(url, { headers, signal, credentials: "omit" });
    if (!res.ok) {
      return { outcome: "http-error", finalUrl: res.url, status: res.status, headers: {} };
    }
    const bytes = await res.arrayBuffer();
    return { outcome: "readable", finalUrl: res.url, status: res.status, headers: {}, bytes };
  } catch (e) {
    if (signal?.aborted) return { outcome: "cancelled", reason: "aborted" };
    return { outcome: "network-error", reason: String((e && e.message) || e) };
  }
}

async function fetchViaProxy(targetUrl, signal) {
  try {
    const res = await fetch("/api/proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetUrl, protocolVersion: 1 }),
      signal,
      credentials: "omit",
    });
    if (!res.ok) {
      // Surface the proxy's machine-readable error code (e.g. PROXY_RATE_LIMITED
      // means the upstream site throttled our server) instead of collapsing
      // every failure into one generic code.
      let code = "PROXY_ERROR";
      try {
        const body = await res.json();
        if (body && typeof body.code === "string") code = body.code;
      } catch {
        // Unreadable body keeps the generic code.
      }
      return { ok: false, status: res.status, code };
    }
    const bytes = await res.arrayBuffer();
    return { ok: true, status: 200, bytes, contentType: res.headers.get("content-type") || undefined };
  } catch {
    if (signal?.aborted) return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
  }
}

const DIRECT_LABEL = "Direct from your browser";
const PROXY_LABEL = "Metadata proxy";

/**
 * Fetch one metadata resource for discovery: direct first, then the eligible
 * metadata proxy after a classified network failure. The zoomable-content
 * classifier gates every success: generic pages fail with NO_IMAGE_FOUND.
 */
async function fetchMetadataFor(url, headers) {
  activeTransport = DIRECT_LABEL;
  const direct = await fetchDirect(url, headers);
  let via = "direct";
  let bytes = null;
  if (direct.outcome === "readable") {
    bytes = direct.bytes;
  } else if (direct.outcome === "network-error" && isProxyEligible(url)) {
    activeTransport = PROXY_LABEL;
    via = "proxy";
    const proxied = await fetchViaProxy(url);
    if (!proxied.ok) {
      if (proxied.code === "PROXY_RATE_LIMITED") {
        throw Object.assign(new Error(RATE_LIMITED_BY_SITE_MESSAGE), {
          code: "UPSTREAM_RATE_LIMITED",
          retryable: true,
        });
      }
      throw Object.assign(
        new Error("The metadata proxy could not fetch this address."),
        { code: "PROXY_ERROR" },
      );
    }
    bytes = proxied.bytes;
  } else if (direct.outcome === "http-error") {
    if (direct.status === 429) {
      // A direct fetch uses the user's own connection, so this throttle is on
      // their IP, not on our server; the fix is waiting, not another app.
      throw Object.assign(new Error(SITE_BUSY_MESSAGE), {
        code: "UPSTREAM_RATE_LIMITED",
        retryable: true,
      });
    }
    throw Object.assign(new Error(`The server answered HTTP ${direct.status}.`), {
      code: "DISCOVERY_HTTP_ERROR",
    });
  } else {
    throw Object.assign(new Error("Could not fetch this address."), {
      code: "DISCOVERY_FAILED",
    });
  }
  const verdict = classifyReadableBytes(bytes, { via });
  if (!verdict.found) {
    throw Object.assign(new Error(noImageFoundError(via).message), {
      code: "NO_IMAGE_FOUND",
      retryable: false,
    });
  }
  return { bytes, finalUri: direct.outcome === "readable" ? direct.finalUrl : undefined, via };
}

async function fetchTileFor(url, headers) {
  const direct = await fetchDirect(url, headers);
  if (direct.outcome !== "readable") {
    throw Object.assign(new Error(`Tile request failed (HTTP ${direct.status ?? "network"}).`), {
      code: "TILE_FAILED",
    });
  }
  return { bytes: direct.bytes };
}

async function probeSizeFor(url, headers) {
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

function disposeClient() {
  if (client) {
    client.dispose();
    client = null;
  }
}

function reportProgress(current, total, message) {
  viewCtx.currentProgress = { current, total, message };
  update();
}

function makeClient() {
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
function pickLevel(image) {
  let best = null;
  let bestArea = -1;
  for (const level of image.levels) {
    const size = level.imageSize;
    const area = size ? size.x * size.y : -1;
    if (area >= bestArea) {
      best = level;
      bestArea = area;
    }
  }
  return best ?? { index: 0 };
}

async function drawTile(client2, ctx2d, tile) {
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

async function runJob(url) {
  const token = ++jobToken;
  controller.dispatch(nextEvent("start-discovery", { transport: "direct" }));
  update();
  try {
    client = makeClient();
    const catalog = await client.start(url);
    if (token !== jobToken) return;
    const image = catalog.images[0];
    const via = activeTransport === PROXY_LABEL ? "proxy" : "direct";
    controller.dispatch(
      nextEvent("images-found", { imageCount: catalog.images.length, transport: via }),
    );
    controller.dispatch(nextEvent("image-chosen"));
    const level = pickLevel(image);
    controller.dispatch(nextEvent("level-chosen"));
    controller.dispatch(nextEvent("preflight-ok", { transport: via }));
    update();

    const plan = await client.plan(image.id, level.index);
    if (token !== jobToken) return;
    const canvas = document.getElementById("rendering-canvas");
    if (!canvas) throw Object.assign(new Error("no rendering canvas"), { code: "WORKER_FAILED" });
    const width = plan.canvas ? plan.canvas.x : 0;
    const height = plan.canvas ? plan.canvas.y : 0;
    if (!(width > 0 && height > 0 && width * height <= 268435456)) {
      throw Object.assign(new Error("The image size could not be determined."), {
        code: "PLAN_INVALID",
      });
    }
    canvas.width = width;
    canvas.height = height;
    const ctx2d = canvas.getContext("2d");
    ctx2d.clearRect(0, 0, width, height);

    const total = plan.tiles.length;
    reportProgress(0, total, `Downloading ${total} tiles…`);
    let done = 0;
    let failed = null;
    const queue = [...plan.tiles];
    async function tileWorker() {
      while (queue.length && !failed) {
        const tile = queue.shift();
        try {
          await drawTile(client, ctx2d, tile);
        } catch (error) {
          failed = error;
          return;
        }
        if (token !== jobToken) return;
        done += 1;
        reportProgress(done, total, `Downloading ${total} tiles…`);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, Math.max(1, total)) }, tileWorker),
    );
    if (failed) throw failed;
    if (token !== jobToken) return;

    controller.dispatch(nextEvent("save-start"));
    reportProgress(total, total, "Encoding PNG…");
    const blob = await new Promise((resolve, reject) => {
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
    controller.dispatch(nextEvent("save-done"));
    update();
  } catch (error) {
    if (token !== jobToken) return;
    const code = (error && error.code) || "DISCOVERY_FAILED";
    controller.dispatch(
      nextEvent("fail", {
        error: {
          code,
          category: code === "NO_IMAGE_FOUND" ? "discovery" : "transport",
          retryable: error?.retryable ?? code !== "NO_IMAGE_FOUND",
          message:
            (error && error.message) || "Could not download this zoomable image.",
          transport: activeTransport ?? "direct",
          phase: code === "NO_IMAGE_FOUND" ? "discovery" : "acquisition",
        },
      }),
    );
    update();
  } finally {
    if (token === jobToken) {
      disposeClient();
    }
  }
}

const appContainer = typeof document !== "undefined" ? document.getElementById("app") : null;

let viewCtx = {
  capabilities: {
    extensionAvailable: false,
    nativeAvailable: false,
    browserCanSave: true,
  },
  originClean: true,
};

export function update() {
  if (!appContainer) return;
  const state = controller.getState();
  if (activeTransport && !state.transport) {
    state.transport = activeTransport;
  }
  renderView(
    appContainer,
    state,
    {
      onSubmitUrl(url) {
        if (!isAllowedSourceUrl(url)) {
          controller.dispatch(
            nextEvent("fail", {
              error: {
                code: "INVALID_URL",
                category: "validation",
                retryable: false,
                message: "Please enter a valid web address starting with https://",
              },
            }),
          );
          update();
          return;
        }
        runJob(url);
      },
      onCancel() {
        jobToken += 1;
        disposeClient();
        controller.dispatch(nextEvent("cancel"));
        update();
      },
      onReset() {
        jobToken += 1;
        disposeClient();
        sessionId = `sess:web-${Date.now()}`;
        controller.reset(sessionId);
        currentSeq = 0;
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
        activeTransport = null;
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
    },
    viewCtx,
  );
}

if (appContainer) {
  document.getElementById("dz-nav-btn-extension")?.addEventListener("click", () => showExtensionGuidance());
  document.getElementById("dz-nav-btn-desktop")?.addEventListener("click", () => showDesktopAppGuidance());
  update();
}

export { controller };
