import {
  type ClientHints,
  createPreviewControls,
  createTileThrottle,
  createWebFetcher,
  isProxyEligible,
  loadTileImage,
  saveBlobViaAnchor,
  setCanvasVisible,
} from "@dezoomify/browser-runtime";
import { createBrowserApplication } from "@dezoomify/browser-runtime/application";
import {
  HISTORY_KEY_WEBSITE,
  jobPageTitle,
  showDesktopAppGuidance,
  showExtensionGuidance,
  suggestedNameFor,
} from "@dezoomify/shared-ui";
import { RATE_LIMITED_BY_SITE_MESSAGE, SITE_BUSY_MESSAGE } from "./discovery.ts";
import { buildHash, looksLikeUsableUrl, parseHash } from "./hash.ts";
import { createProxyTransport, PROXY_METADATA_MAX_BYTES } from "./proxyTransport.ts";

const preview = createPreviewControls();
const proxyTransport = createProxyTransport(fetch, {
  protocolVersion: 1,
  maxBytes: PROXY_METADATA_MAX_BYTES,
});
const memory = new Map<string, string>();
const historyStore = {
  getItem(key: string) {
    try {
      return localStorage.getItem(key);
    } catch {
      return memory.get(key) ?? null;
    }
  },
  setItem(key: string, value: string) {
    try {
      localStorage.setItem(key, value);
    } catch {
      memory.set(key, value);
    }
  },
  removeItem(key: string) {
    try {
      localStorage.removeItem(key);
    } catch {}
    memory.delete(key);
  },
};
const wasm = import("@dezoomify/wasm-bindings").then(async (module) => {
  await module.default();
  return module;
});
const root = document.getElementById("app");

const app = root
  ? createBrowserApplication({
      root,
      product: "website",
      wasm: () => wasm,
      partial: "discard",
      resetToIdle: true,
      history: { store: historyStore, key: HISTORY_KEY_WEBSITE },
      onStart(url) {
        window.location.hash = buildHash(url);
        setCanvasVisible(document, false);
        preview.resetTransform(document);
      },
      onReset() {
        history.replaceState(null, "", `${location.pathname}${location.search}`);
        setCanvasVisible(document, false);
        preview.resetTransform(document);
      },
      onStatus(presentation, url) {
        document.title = presentation.phase === "job" ? jobPageTitle(url) : "Dezoomify";
      },
      capabilities(context) {
        const throttle = createTileThrottle();
        const hooks = {
          onRequestStart: () => context.activity.noteRequestStart(),
          onRequestEnd: (id: number, ok: boolean) => context.activity.noteRequestEnd(id, ok),
          onUpdate: context.update,
        };
        const fetcher = createWebFetcher({
          diagnostics: context.diagnostics,
          proxyTransport,
          isProxyEligible,
          hooks,
          messages: {
            rateLimitedBySite: RATE_LIMITED_BY_SITE_MESSAGE,
            siteBusy: SITE_BUSY_MESSAGE,
            discoveryFailed: () => "No zoomable image was found at this address.",
          },
          throttle: (url) => throttle.throttle(url),
        });
        let blobUrl: string | undefined;
        let saveName: string | undefined;
        return {
          inputs: async (url) => [{ url }],
          async fetchResource(request, signal) {
            const result = await fetcher.fetchResource(request, signal);
            return {
              kind: "response",
              response: { bytes: result.bytes, final_uri: result.finalUri },
            };
          },
          loadDisplayImage: (url, signal) => loadTileImage(url, { signal, hooks }),
          canvas() {
            const canvas = document.getElementById("rendering-canvas");
            return canvas instanceof HTMLCanvasElement ? canvas : document.createElement("canvas");
          },
          showCanvas() {
            setCanvasVisible(document, true);
            preview.resetTransform(document);
          },
          save(blob, width, height, signal, title) {
            signal.throwIfAborted();
            if (blobUrl) URL.revokeObjectURL(blobUrl);
            blobUrl = URL.createObjectURL(blob);
            saveName = suggestedNameFor(width, height, "png", title);
            return "browser-save-ready";
          },
          saveOutput() {
            if (blobUrl && saveName) saveBlobViaAnchor(document, blobUrl, saveName);
          },
          transport: () => fetcher.getActiveTransport(),
          dispose() {
            if (blobUrl) URL.revokeObjectURL(blobUrl);
          },
        };
      },
    })
  : undefined;

if (app) {
  preview.initControls(document);
  document
    .getElementById("dz-nav-btn-extension")
    ?.addEventListener("click", () => showExtensionGuidance(document));
  document.getElementById("dz-nav-btn-desktop")?.addEventListener("click", () =>
    showDesktopAppGuidance(document, {
      userAgent: navigator.userAgent,
      platform: (navigator as unknown as ClientHints & { platform?: string }).platform,
    }),
  );
  const openHash = () => {
    const url = parseHash(location.hash);
    if (url && url !== app.currentUrl() && looksLikeUsableUrl(url)) app.submit(url);
  };
  window.addEventListener("hashchange", openHash);
  window.addEventListener("beforeunload", app.dispose);
  openHash();
}

export const currentPresentation = () => app?.presentation();
export const update = () => app?.update();
