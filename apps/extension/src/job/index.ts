import { createAttemptPermissions, loadTileImage, originOfUrl } from "@dezoomify/browser-runtime";
import { createBrowserApplication } from "@dezoomify/browser-runtime/application";
import { jobPageTitle, suggestedNameFor } from "@dezoomify/shared-ui";
import type { ResourceRead } from "@dezoomify/wasm-bindings";
import { browser as api } from "wxt/browser";
import { createExtensionFetcher } from "../runtime/fetch.ts";
import { saveExtensionBlob } from "./download.ts";
import { createSourceAccess } from "./source-access.ts";
import { createResourceFetcher } from "./transport.ts";

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
  partial: "prompt",
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
    return {
      async inputs() {
        if (!source) {
          if (sourceTabId === null)
            throw {
              code: "DISCOVERY_FAILED",
              blocked_reason: "source-document-lost",
              phase: "discovery",
              message: "Could not find the source tab for this job.",
              retryable: false,
            };
          const tab = await api.tabs.get(sourceTabId);
          context.signal.throwIfAborted();
          if (typeof tab.url !== "string" || originOfUrl(tab.url) === "")
            throw {
              code: "DISCOVERY_FAILED",
              blocked_reason: "source-document-lost",
              phase: "discovery",
              message: "The source tab no longer has a readable web page.",
              retryable: false,
            };
          source = createSourceAccess(api, { tabId: sourceTabId, documentUrl: tab.url });
          installTestAccess();
        }
        const scan = await source.scan(context.signal);
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
          throw {
            code: "no-candidates",
            message: "No image references were found on this page.",
            retryable: true,
          };
        return scan.inputs;
      },
      fetchResource: (request, signal, interaction) => {
        if (!fetchResource) return Promise.reject(new Error("The source has not been scanned."));
        return fetchResource(request, signal, interaction);
      },
      loadDisplayImage: (url, signal) => loadTileImage(url, { signal }),
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
    return (async () => {
      const scan = await bound.scan();
      const expected = value.scenario === "cookie-session" ? "/protected/artwork.dzi" : "/fetch/";
      const input = scan.inputs.find((candidate) => candidate.url.includes(expected));
      if (!input) throw new Error(`direct scan did not find ${expected}`);
      const url =
        value.scenario === "cookie-session"
          ? new URL("/__source-access-proof", bound.documentUrl).href
          : input.url;
      const result = await bound.fetch({ uri: url, headers: [] }, new AbortController().signal);
      return {
        ok: true,
        documentUrl: scan.documentUrl,
        candidates: scan.inputs.length,
        bytes: result.bytes.byteLength,
      };
    })().catch((error: unknown) => ({
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
  app.dispose();
  syncIndicator(false, false);
  source?.dispose();
});
void app.run(source?.documentUrl ?? "");
