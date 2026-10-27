import {
  createAttemptPermissions,
  DezoomifyError,
  InternalError,
  loadTileImage,
  originOfUrl,
  PolicyDeniedError,
} from "@dezoomify/browser-runtime";
import { createBrowserApplication } from "@dezoomify/browser-runtime/application";
import {
  getLocale,
  jobPageTitle,
  pickLocale,
  setLocale,
  suggestedNameFor,
} from "@dezoomify/shared-ui";
import type { ResourceRead } from "@dezoomify/wasm-bindings";
import { browser as api } from "wxt/browser";
import { createExtensionFetcher } from "../runtime/fetch.ts";
import { saveExtensionBlob, saveExtensionUrl } from "./download.ts";
import { createSourceAccess } from "./source-access.ts";
import { createResourceFetcher } from "./transport.ts";

setLocale(pickLocale(navigator.languages?.length ? navigator.languages : navigator.language));
document.documentElement.lang = getLocale();

const TESTING = import.meta.env.MODE === "testing";
const sourceTabParam = new URLSearchParams(location.hash.slice(1)).get("sourceTabId");
const parsedId =
  sourceTabParam !== null && /^\d+$/.test(sourceTabParam) ? Number(sourceTabParam) : -1;
const sourceTabId = Number.isSafeInteger(parsedId) && parsedId >= 0 ? parsedId : null;
const IDLE_ICON = {
  16: "icons/icon16-grey.png",
  48: "icons/icon48-grey.png",
  128: "icons/icon128-grey.png",
};
const ACTIVE_ICON = { 16: "icons/icon16.png", 48: "icons/icon48.png", 128: "icons/icon128.png" };
const testGrantedOrigins = new Set<string>();
let source: ReturnType<typeof createSourceAccess> | undefined;
let indicator = "";
export const EXTENSION_JOB_BASE_TITLE = "Dezoomify job";

const wasm = import(/* @vite-ignore */ new URL("wasm/dezoomify-wasm.js", location.href).href).then(
  async (module) => {
    await module.default();
    return module;
  },
);
function syncIndicator(active: boolean, failed: boolean) {
  if (sourceTabId === null || indicator === `${active}:${failed}`) return;
  indicator = `${active}:${failed}`;
  void api.action
    .setIcon({ tabId: sourceTabId, path: active || failed ? ACTIVE_ICON : IDLE_ICON })
    .catch(() => {});
  void api.action
    .setBadgeText({ tabId: sourceTabId, text: failed ? "!" : active ? "•" : "" })
    .catch(() => {});
}

const root = document.getElementById("dz-job-app");
if (!root) throw new Error("The job page is unavailable.");
const app = createBrowserApplication({
  root,
  product: "extension",
  version: api.runtime.getManifest().version,
  wasm: () => wasm,
  openSource: () => {
    if (sourceTabId !== null) void api.tabs.update(sourceTabId, { active: true });
  },
  onStatus(presentation, url) {
    document.title = presentation.phase === "job" ? jobPageTitle(url) : EXTENSION_JOB_BASE_TITLE;
    syncIndicator(presentation.phase === "job", presentation.phase === "failed");
  },
  onComplete() {
    if (TESTING)
      void api.runtime.sendMessage({ type: "dezoomify-test-job-complete" }).catch(() => {});
  },
  capabilities(context) {
    const permissionApi = {
      contains: ({ origins }: { origins: string[] }) =>
        TESTING
          ? Promise.resolve(
              origins.every((pattern) => testGrantedOrigins.has(pattern.slice(0, -2))),
            )
          : api.permissions.contains({ origins }),
      request: ({ origins }: { origins: string[] }) => {
        if (!TESTING) return api.permissions.request({ origins });
        for (const pattern of origins) testGrantedOrigins.add(pattern.slice(0, -2));
        return Promise.resolve(true);
      },
    };
    const permissions = createAttemptPermissions(permissionApi, context.permission);
    const fetcher = createExtensionFetcher({
      diagnostics: context.diagnostics,
      hasPermission: (origin) => permissionApi.contains({ origins: [`${origin}/*`] }),
    });
    let downloadId: number | undefined;
    let fetchResource: ReturnType<typeof createResourceFetcher> | undefined;
    let observe: ReturnType<ReturnType<typeof createSourceAccess>["observations"]> | undefined;
    return {
      async inputs() {
        if (!source) {
          if (sourceTabId === null)
            throw new PolicyDeniedError({
              blocked_reason: "source-document-lost",
              transport: "browser-session",
              detail: "could not find the source tab for this job",
            });
          const tab = await api.tabs.get(sourceTabId);
          context.signal.throwIfAborted();
          if (typeof tab.url !== "string" || originOfUrl(tab.url) === "")
            throw new PolicyDeniedError({
              blocked_reason: "source-document-lost",
              transport: "browser-session",
              detail: "the source tab no longer has a readable web page",
            });
          source = createSourceAccess(api, { tabId: sourceTabId, documentUrl: tab.url });
          installTestAccess();
        }
        const scan = await source.scan(context.signal);
        observe = source.observations({
          hasPermission: (origin) => permissionApi.contains({ origins: [`${origin}/*`] }),
          ensurePermission: (origin, signal) => permissions.ensure(origin, signal),
          scanned(snapshot) {
            context.diagnostics.record("debug", "frame-scan", {
              document_url: snapshot.documentUrl,
              candidates: snapshot.inputs.length,
              overflow: snapshot.overflow,
              ...snapshot.memory,
            });
          },
          failed(frame, error) {
            context.diagnostics.record("warn", "frame-scan-failed", {
              frame_id: frame.frameId,
              document_url: frame.documentUrl,
              error,
            });
          },
        });
        context.signal.throwIfAborted();
        context.view.sourceUrl = source.documentUrl;
        context.activity.state.url = source.documentUrl;
        context.diagnostics.context({
          input: source.documentUrl,
          source_tab: sourceTabId,
          source_origin: source.origin,
          scan: {
            document_url: scan.documentUrl,
            candidates: scan.inputs.length,
            overflow: scan.overflow,
            memory: scan.memory,
          },
        });
        for (const [index, input] of scan.inputs.entries())
          context.diagnostics.record("debug", "scan-candidate", {
            index,
            url: input.url,
            kind: input.kind,
            supplied_bytes: input.contents?.length ?? 0,
          });
        fetchResource = createResourceFetcher({
          diagnostics: context.diagnostics,
          sourceAccess: source,
          extensionTransport: {
            async fetchResource(request, signal, interaction): Promise<ResourceRead> {
              const origin = new URL(request.uri).origin;
              if (!(await permissionApi.contains({ origins: [`${origin}/*`] }))) {
                if (interaction === "forbidden") return { kind: "needs-access", origin };
                await permissions.ensure(origin, signal);
              }
              const result = await fetcher.fetchResource(request, signal);
              return {
                kind: "response",
                response: { bytes: result.bytes, final_uri: result.finalUri },
              };
            },
          },
        });
        if (scan.inputs.length === 0)
          throw new DezoomifyError({
            kind: "no-image-found",
            detail: "no image references were found on this page",
          });
        return scan.inputs;
      },
      fetchResource: (request, signal, interaction) => {
        if (!fetchResource) return Promise.reject(new Error("The source has not been scanned."));
        return fetchResource(request, signal, interaction);
      },
      fetchPreview: (request, signal) => {
        if (!fetchResource) return Promise.reject(new Error("The source has not been scanned."));
        return fetchResource.preview(request, signal);
      },
      async recoverDiscovery(error) {
        if (!["discovery-failed", "malformed-metadata", "no-image-found"].includes(error.kind))
          return undefined;
        const image = await source?.loadedImage(context.signal);
        const url = image?.url ?? (await source?.imageDownloadLink(context.signal));
        if (!url) return undefined;
        context.diagnostics.record("warn", "discovery-fallback", error);
        context.diagnostics.record("info", "source-image", { url, ...image });
        downloadId = await saveExtensionUrl(api.downloads, url, undefined, context.signal);
        context.view.outputKey = String(downloadId);
        context.view.discoveryFallback = error;
        return {
          canvas: image ? { width: image.width, height: image.height } : undefined,
          disposition: "browser-save-initiated",
        };
      },
      observe: (interaction, signal) => observe?.(interaction, signal) ?? Promise.resolve([]),
      dispose: () => source?.releaseTiles(),
      loadDisplayImage: (url, signal) => loadTileImage(url, { signal }),
      loadViewerTile: (request, extent, signal) => {
        if (!source)
          throw new InternalError(
            "Viewer tile acquisition started before scanning the source document",
          );
        return source.loadViewerTile(request, extent, signal);
      },
      canvas: () => document.createElement("canvas"),
      async save(blob, width, height, signal, title) {
        downloadId = await saveExtensionBlob(
          api.downloads,
          blob,
          suggestedNameFor(width, height, "png", title),
          signal,
        );
        signal.throwIfAborted();
        context.view.outputKey = String(downloadId);
        context.diagnostics.record("info", "save-confirmed", {
          download_id: downloadId,
          width,
          height,
          bytes: blob.size,
        });
        return "browser-save-initiated" as const;
      },
      async openOutput() {
        if (downloadId !== undefined) await api.downloads.open(downloadId);
      },
      async revealOutput() {
        if (downloadId !== undefined) await api.downloads.show(downloadId);
      },
      transport: () => "browser-session",
    };
  },
});

function installTestAccess() {
  if (!TESTING || !source) return;
  const bound = source;
  (
    window as Window & { __DEZOOMIFY_TEST_SOURCE_ACCESS__?: unknown }
  ).__DEZOOMIFY_TEST_SOURCE_ACCESS__ = {
    async scan() {
      const scan = await bound.scan();
      return {
        documentUrl: scan.documentUrl,
        count: scan.inputs.length,
        firstUrl: scan.inputs[0]?.url ?? scan.documentUrl,
      };
    },
    async fetch(url: string) {
      const result = await bound.fetch({ uri: url, headers: [] }, new AbortController().signal);
      return { byteLength: result.bytes.byteLength };
    },
  };
  void api.runtime
    .sendMessage({ type: "dezoomify-test-source-ready", sourceTabId })
    .catch(() => {});
}

function testScenarioPath(scenario: unknown): string {
  if (typeof scenario === "string" && scenario.startsWith("loaded-image")) return "/loaded-image";
  if (scenario === "recursive-iframe") return "/recursive-iframe";
  if (typeof scenario === "string" && scenario.startsWith("memory-openseadragon-"))
    return "/memory-openseadragon.html";
  if (typeof scenario === "string" && scenario.startsWith("memory-openlayers-"))
    return "/memory-openlayers.html";
  if (scenario === "cookie-session") return "/protected/artwork.dzi";
  if (scenario === "retry") return "/fixtures/failures/retry-approval/retry.dzi";
  if (typeof scenario === "string" && scenario.startsWith("fixtures/")) return `/${scenario}/`;
  return "/extension-inputs/";
}

async function testSourceAccess(bound: NonNullable<typeof source>, scenario: unknown) {
  const scan = await bound.scan();
  const expected = testScenarioPath(scenario);
  const input = scan.inputs.find((candidate) => candidate.url.includes(expected));
  if (!input) throw new Error(`direct scan did not find ${expected}`);
  const url =
    scenario === "cookie-session"
      ? new URL("/__source-access-proof", bound.documentUrl).href
      : input.url;
  const result = await bound.fetch({ uri: url, headers: [] }, new AbortController().signal);
  return {
    ok: true,
    documentUrl: scan.documentUrl,
    candidates: scan.inputs.length,
    bytes: result.bytes.byteLength,
  };
}

api.runtime.onMessage.addListener((message: unknown) => {
  if (!message || typeof message !== "object" || !("type" in message)) return;
  const value = message as Record<string, unknown>;
  if (value.type === "dz.toolbar-click" && value.sourceTabId === sourceTabId) {
    if (app.active()) app.cancel();
    return;
  }
  if (!TESTING || !source) return;
  const bound = source;
  if (value.type === "dezoomify-test-source-access")
    return testSourceAccess(bound, value.scenario).catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  if (value.type === "dezoomify-test-source-navigation")
    return source.scan().then(
      () => ({ ok: false, code: "source-access-stayed-live" }),
      (error: unknown) => ({
        ok: false,
        code:
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "unknown-error",
        blocked_reason:
          error && typeof error === "object" && "blocked_reason" in error
            ? error.blocked_reason
            : undefined,
      }),
    );
});
api.permissions.onRemoved.addListener((removed) => {
  for (const origin of removed.origins ?? [])
    testGrantedOrigins.delete(origin.replace(/\/\*$/, ""));
});
window.addEventListener("beforeunload", () => {
  void app.dispose();
  syncIndicator(false, false);
  source?.dispose();
});
void app.run(source?.documentUrl ?? "");
