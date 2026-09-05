// Web application entry point: wire shared controller and modern view to web integration.
import { createController } from "../../../packages/shared-ui/src/controller.ts";
import { renderView, showDesktopAppGuidance, showExtensionGuidance } from "../../../packages/shared-ui/src/view.ts";
import type { ViewContext } from "../../../packages/shared-ui/src/view.ts";
import { createWebIntegration } from "./webIntegration.ts";
import { loadWebConfig, isAllowedSourceUrl } from "./config.ts";
import { classifyDiscovery } from "./discovery.ts";

const config = loadWebConfig({
  WEBSITE_ORIGIN: typeof window !== "undefined" ? window.location.origin : "https://dezoomify.ophir.dev",
  NODE_ENV: "production",
});

let sessionId = `sess:web-${Date.now()}`;
const controller = createController(sessionId);
let currentSeq = 0;

function nextEvent(kind: string, extra: Record<string, unknown> = {}) {
  currentSeq++;
  return { seq: currentSeq, sessionId, kind, ...extra };
}

// Fallback direct / proxy stubs for browser usage
const direct = {
  async fetchResource(url: string, opts?: { headers?: Record<string, string>; signal?: AbortSignal }) {
    try {
      const res = await fetch(url, {
        headers: opts?.headers,
        signal: opts?.signal,
        credentials: "omit",
      });
      if (!res.ok) {
        return { outcome: "http-error", finalUrl: res.url, status: res.status, headers: {} };
      }
      const bytes = await res.arrayBuffer();
      return { outcome: "readable", finalUrl: res.url, status: res.status, headers: {}, bytes };
    } catch (e: any) {
      if (opts?.signal?.aborted) return { outcome: "cancelled", reason: "aborted" };
      return { outcome: "network-error", reason: String(e.message || e) };
    }
  },
};

const proxy = {
  async fetchViaProxy(targetUrl: string, opts?: { signal?: AbortSignal }) {
    try {
      const res = await fetch(config.proxyPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUrl, protocolVersion: 1 }),
        signal: opts?.signal,
        credentials: "omit",
      });
      if (!res.ok) {
        return { ok: false, status: res.status, code: "PROXY_ERROR" };
      }
      const bytes = await res.arrayBuffer();
      return { ok: true, status: 200, bytes, contentType: res.headers.get("content-type") || undefined };
    } catch {
      return { ok: false, status: 502, code: "PROXY_NETWORK_ERROR" };
    }
  },
};

let activeTransport: string | null = null;
const integration = createWebIntegration({
  direct,
  proxy,
  onTransport: (label) => {
    activeTransport = label;
    update();
  },
  capabilities: {
    extensionAvailable: false,
    nativeAvailable: false,
  },
});

const appContainer = typeof document !== "undefined" ? document.getElementById("app") : null;

let viewCtx: ViewContext = {
  capabilities: {
    extensionAvailable: false,
    nativeAvailable: false,
    browserCanSave: true,
  },
  originClean: true,
};

function update() {
  if (!appContainer) return;
  const state = controller.getState();
  if (activeTransport && !state.transport) {
    state.transport = activeTransport;
  }
  renderView(
    appContainer,
    state,
    {
      onSubmitUrl(url: string, _format?: string) {
        if (!isAllowedSourceUrl(url, config)) {
          controller.dispatch(
            nextEvent("fail", {
              error: {
                code: "INVALID_URL",
                category: "validation",
                retryable: false,
                message: "Please enter a valid web address starting with https://",
              },
            }) as any,
          );
          update();
          return;
        }

        controller.dispatch(nextEvent("start-discovery") as any);
        update();

        // Perform discovery: fetch one metadata resource, then gate every
        // later transition on the classifier. Generic pages without any
        // zoomable signal must fail here and never show tile progress.
        integration
          .fetchMetadata({ url, kind: "metadata" })
          .then((res) => {
            const verdict = classifyDiscovery(url, res as { via: string; result: unknown });
            if (!verdict.found) {
              if (verdict.cancelled) {
                controller.dispatch(nextEvent("cancel") as any);
                update();
                return;
              }
              controller.dispatch(
                nextEvent("fail", {
                  error: verdict.error ?? {
                    code: "NO_IMAGE_FOUND",
                    category: "discovery",
                    retryable: false,
                    message: "No zoomable image was found at this address.",
                    transport: (res as { via?: string }).via ?? "direct",
                    phase: "discovery",
                  },
                }) as any,
              );
              update();
              return;
            }
            const via = verdict.via ?? (res as { via: string }).via;
            controller.dispatch(nextEvent("images-found", { imageCount: 1, transport: via }) as any);
            controller.dispatch(nextEvent("image-chosen") as any);
            controller.dispatch(nextEvent("level-chosen") as any);
            controller.dispatch(nextEvent("preflight-ok", { transport: via }) as any);
            viewCtx.currentProgress = { current: 1, total: 1, message: "Reading image tiles..." };
            update();

            // TODO: replace this placeholder completion with the real tile
            // plan/download once the browser runtime drives core discovery.
            setTimeout(() => {
              controller.dispatch(nextEvent("save-start") as any);
              controller.dispatch(nextEvent("save-done") as any);
              viewCtx.completedInfo = {
                width: 4096,
                height: 3072,
                mime: "image/jpeg",
              };
              update();
            }, 600);
          })
          .catch((err) => {
            controller.dispatch(
              nextEvent("fail", {
                error: {
                  code: "DISCOVERY_FAILED",
                  category: "discovery",
                  retryable: true,
                  message: err?.message || "Could not find a zoomable image at this address.",
                },
              }) as any,
            );
            update();
          });
      },
      onCancel() {
        controller.dispatch(nextEvent("cancel") as any);
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
        // Trigger save download
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

export { controller, integration, update };
