// Web application entry point (browser ES module, no build step).
// Direct-first fetch, automatic eligible metadata-proxy fallback, then the
// shared discovery classifier gates every later transition. Generic pages
// without a zoomable signal fail with NO_IMAGE_FOUND and never show tile
// progress.
import { createController } from "../../../packages/shared-ui/src/controller.js";
import { renderView, showDesktopAppGuidance, showExtensionGuidance } from "../../../packages/shared-ui/src/view.js";
import { classifyDiscovery } from "./discovery.js";

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;
let activeTransport = null;

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

async function fetchDirect(url, signal) {
  try {
    const res = await fetch(url, { signal, credentials: "omit" });
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
      return { ok: false, status: res.status, code: "PROXY_ERROR" };
    }
    const bytes = await res.arrayBuffer();
    return { ok: true, status: 200, bytes, contentType: res.headers.get("content-type") || undefined };
  } catch {
    if (signal?.aborted) return { ok: false, status: 0, code: "TRANSPORT_CANCELLED" };
    return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
  }
}

async function fetchMetadata(url, signal) {
  activeTransport = "Direct from your browser";
  const direct = await fetchDirect(url, signal);
  if (direct.outcome === "network-error" && isProxyEligible(url)) {
    activeTransport = "Metadata proxy";
    const proxied = await fetchViaProxy(url, signal);
    return { via: "proxy", result: proxied };
  }
  return { via: "direct", result: direct };
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
        controller.dispatch(nextEvent("start-discovery", { transport: "direct" }));
        update();

        fetchMetadata(url).then(
          (res) => {
            const verdict = classifyDiscovery(url, res);
            if (!verdict.found) {
              if (verdict.cancelled) {
                controller.dispatch(nextEvent("cancel"));
                update();
                return;
              }
              controller.dispatch(nextEvent("fail", { error: verdict.error }));
              update();
              return;
            }
            const via = verdict.via ?? res.via;
            controller.dispatch(nextEvent("images-found", { imageCount: 1, transport: via }));
            controller.dispatch(nextEvent("image-chosen"));
            controller.dispatch(nextEvent("level-chosen"));
            controller.dispatch(nextEvent("preflight-ok", { transport: via }));
            // Placeholder while the browser runtime gains a real tile plan.
            // Never fabricate a tile count: 1 of 1 only marks the stub stage.
            viewCtx.currentProgress = { current: 1, total: 1, message: "Reading image tiles..." };
            update();
          },
          (err) => {
            controller.dispatch(
              nextEvent("fail", {
                error: {
                  code: "DISCOVERY_FAILED",
                  category: "discovery",
                  retryable: true,
                  message: (err && err.message) || "Could not find a zoomable image at this address.",
                },
              }),
            );
            update();
          },
        );
      },
      onCancel() {
        controller.dispatch(nextEvent("cancel"));
        update();
      },
      onReset() {
        sessionId = `sess:web-${Date.now()}`;
        controller.reset(sessionId);
        currentSeq = 0;
        viewCtx.currentProgress = undefined;
        viewCtx.completedInfo = undefined;
        activeTransport = null;
        update();
      },
      onSave() {
        alert("Image ready to save! In full runtime, this initiates downloading the final image file.");
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
