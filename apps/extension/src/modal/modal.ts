/**
 * In-tab modal job runner (extension redesign).
 *
 * Runs inside the `chrome.runtime.getURL` iframe (`modal/modal.html`) that
 * the content loader mounts in the SAME tab the user clicked. It drives the
 * canonical shared-ui `renderView` geometry (vendored `../vendor/`
 * theme + view: `dz-*` classes only, no visual fork) through the same code
 * paths as the in-tab runtime (run/discover/planLevel/
 * assemble/save + native handoff offer):
 *
 * - candidates arrive from the loader handshake (`dz-modal-candidates`;
 *   in-tab performance timeline + the background pre-injection collector);
 * - wasm discovery core inline, largest image + largest fitting level
 *   (`pickLevel`, `BROWSER_MAX_PLAN_TILES` guard);
 * - tab-origin session fetch (`createSessionFetcher` with
 *   `credentials: "include"`; tab origin pre-granted, other origins only via
 *   an explicit permission prompt; never the metadata CORS proxy);
 * - origin-clean canvas gate exactly like `page.ts` assemble: readable bytes
 *   keep the canvas clean (per-tile `getImageData` sample); a tainted canvas
 *   finishes as display-only (visible canvas/`<img>` ordinary display,
 *   right-click save, no byte save) and NEVER sees a pixel read, `toBlob`,
 *   or `toDataURL` afterwards;
 * - clean saves fire a blob-anchor download (no `downloads` permission);
 * - close/Cancel disposes the run, revokes tracked object URLs, and asks the
 *   loader to detach (which restores the grey action icon via the background).
 *
 * Ships verbatim as `modal/modal.js` with no bundler (see
 * `package-store.sh`), so this is plain JavaScript + JSDoc. All strings
 * reach the DOM via `textContent` (or the view's own escaping), never markup.
 */

import { createSessionFetcher, originOf } from "../runtime/fetch.js";
import { validateCandidateUrl, redactUrlForLabel } from "../runtime/candidates.js";
import { requestNativeHandoff, NATIVE_HOST_NAME } from "../runtime/nativeHandoff.js";
import { pickLevel, BROWSER_MAX_PLAN_TILES } from "../vendor/limits.js";
import { renderView } from "../vendor/view.js";
import init, * as wasm from "../wasm/dezoomify-wasm.js";

type JsonObject = Record<string, unknown>;
type ModalContext = JsonObject & { imageCount?: number; failure?: unknown };
type JobContextExtra = { url?: string; progress?: { current: number; total: number }; rest?: JsonObject };
type ImageLevel = { index: number; width?: number; height?: number };
type CatalogImage = { id: string; levels: ImageLevel[] };
type Catalog = { images: CatalogImage[] };
type Tile = { uri: string; x: number; y: number; w?: number; h?: number; processing?: string | null };
type TilePlan = { kind?: string; uri?: string; canvas: { x: number; y: number }; tiles: Tile[] };
type RankedCandidate = { url: string; format: unknown };
type ErrorLike = { code?: unknown; message?: unknown };
type NativeMessage = JsonObject & { ok?: boolean; type?: string; code?: string };
type ExtensionApi = {
  runtime?: { sendNativeMessage?(host: string, message: JsonObject): Promise<NativeMessage> };
  permissions?: { contains?(request: { origins: string[] }): Promise<boolean>; request?(request: { origins: string[]; permissions?: string[] }): Promise<boolean> };
  cookies?: { getAll(request: { url: string }): Promise<Array<{ name: string; value: string }>> };
};

// Tile pacing mirrors the extension page and the browser tile policy
// (tile-policy `BROWSER_CAPABILITY_MAX_CONCURRENCY` 6): sequential starts
// with a short per-host stagger, so one job never floods the site.
const MODAL_TILE_MIN_INTERVAL_MS = 50;

const hostGlobal = globalThis as typeof globalThis & { browser?: ExtensionApi; chrome?: ExtensionApi };
const api = hostGlobal.browser ?? hostGlobal.chrome;

/** @type {{ cancelRequested: boolean, seq: number, sessionId: string, token: string|null, urls: string[], started: boolean }} */
const modalState: { cancelRequested: boolean; seq: number; sessionId: string; token: string | null; urls: string[]; started: boolean } = {
  cancelRequested: false,
  seq: 0,
  sessionId: "modal-" + Date.now().toString(36),
  token: null,
  urls: [],
  started: false,
};

/** @type {string[]} object URLs created by this modal; revoked on dispose. */
const liveObjectUrls: string[] = [];

function trackObjectUrl(url: string) {
  if (typeof url === "string" && url) liveObjectUrls.push(url);
  return url;
}

function revokeObjectUrls() {
  while (liveObjectUrls.length > 0) {
    const url = liveObjectUrls.pop();
    try {
      if (url) URL.revokeObjectURL(url);
    } catch {
      // Revocation is best-effort only.
    }
  }
}

function modalToken() {
  try {
    const hash = String(location.hash ?? "");
    const match = hash.match(/token=([^&]*)/);
    if (match) return decodeURIComponent(match[1]);
  } catch {
    // No token: the loader handshake below fails closed.
  }
  return null;
}

function postToLoader(message: JsonObject) {
  try {
    window.parent.postMessage({ ...(message ?? {}), token: modalState.token }, "*");
  } catch {
    // Loader gone; detach already happened or is imminent.
  }
}

function requestClose() {
  disposeRun();
  postToLoader({ kind: "dz-modal-close" });
}

function disposeRun() {
  modalState.cancelRequested = true;
  revokeObjectUrls();
  wakeCandidatesWaiter();
}

/** Indefinite byte-confirmation waiter: resolved by the next candidates post. */
let moreCandidatesResolve: (() => void) | null = null;

function waitForMoreCandidates(): Promise<void> {
  return new Promise<void>((resolve) => {
    moreCandidatesResolve = resolve;
  });
}

function wakeCandidatesWaiter() {
  if (moreCandidatesResolve) {
    const wake = moreCandidatesResolve;
    moreCandidatesResolve = null;
    try {
      wake();
    } catch {
      // Waking is best-effort only.
    }
  }
}

function appRoot() {
  return document.getElementById("dz-modal-app");
}

function throwIfCancelled() {
  if (modalState.cancelRequested) {
    throw Object.assign(new Error("cancelled by user"), { code: "cancelled" });
  }
}

/**
 * @param {string} status shared-ui UiStatus
 * @param {any} [ctx] ViewContext
 */
function render(status: string, ctx?: ModalContext) {
  modalState.seq += 1;
  const root = appRoot();
  if (!root) return;
  renderView(
    root,
    {
      status,
      seq: modalState.seq,
      sessionId: modalState.sessionId,
      imageCount: ctx && typeof ctx.imageCount === "number" ? ctx.imageCount : 0,
      transport: "browser-session",
      ...(status === "failed" && ctx && ctx.failure ? { error: ctx.failure } : {}),
    },
    {
      onSubmitUrl: () => {},
      onCancel: () => {
        modalState.cancelRequested = true;
        wakeCandidatesWaiter();
      },
      onReset: () => {
        modalState.cancelRequested = false;
        void runDiscovery();
      },
      onRetrySameUrl: () => {
        modalState.cancelRequested = false;
        void runDiscovery();
      },
      onSave: () => {},
    },
    ctx,
  );
}

/** @param {string} step */
function jobCtx(step: string, extra?: JobContextExtra): ModalContext {
  return {
    jobActivity: {
      startedAt: Date.now() - 1000,
      stepLabel: step,
      ...(extra && extra.url ? { url: extra.url } : {}),
    },
    currentProgress: extra && extra.progress ? extra.progress : undefined,
    ...(extra && extra.rest ? extra.rest : {}),
  };
}

function tabOriginOf(url: string) {
  try {
    return originOf(url);
  } catch {
    return "";
  }
}

function makeTabFetcher(tabOrigin: string) {
  return createSessionFetcher({
    fetchImpl: async (url, init) => {
      const started = Date.now();
      const res = await fetch(url, init);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const headers: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      Object.defineProperties(res, {
        bytes: { value: bytes, configurable: true },
        durationMs: { value: Date.now() - started, configurable: true },
      });
      return res as Response & { bytes: Uint8Array; durationMs: number };
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
    requestPermission: async (origin: string) => {
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

async function discover(sourceUrl: string, tabOrigin: string): Promise<{ session: wasm.DiscoverySession; catalog: Catalog }> {
  await init();
  const session = new wasm.DiscoverySession(sourceUrl);
  const fetcher = makeTabFetcher(tabOrigin);
  for (;;) {
    throwIfCancelled();
    const raw = session.nextNeed();
    if (!raw || raw === "null") break;
    const need = JSON.parse(raw) as { id: string; uri: string };
    try {
      const out = await fetcher.fetchResource(need.uri, { userIntent: true });
      session.provide(need.id, out.bytes, out.finalUrl || need.uri);
    } catch (e) {
      session.provideFailure(need.id, e instanceof Error ? e.message : String(e));
    }
  }
  return { session, catalog: JSON.parse(session.finish()) as Catalog };
}

async function planLevel(session: wasm.DiscoverySession, image: CatalogImage, tabOrigin: string): Promise<TilePlan> {
  // Canonical level picking (vendored limits.js, no forked area math).
  const picked = pickLevel({ levels: image.levels });
  const level = image.levels.find((candidate) => candidate.index === picked.index) ?? image.levels[0];
  let plan = JSON.parse(session.levelTiles(image.id, level.index)) as TilePlan;
  const fetcher = makeTabFetcher(tabOrigin);
  let guard = 0;
  while (plan.kind === "probe" && guard++ < 5) {
    throwIfCancelled();
    if (!plan.uri) throw new Error("probe plan has no URI");
    const out = await fetcher.fetchResource(plan.uri, { userIntent: true });
    const bmp = await createImageBitmap(new Blob([new Uint8Array(out.bytes).slice().buffer]));
    plan = JSON.parse(session.probeSubmit(image.id, level.index, bmp.width > 0, bmp.width, bmp.height)) as TilePlan;
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

/**
 * Whether a planned tile may fall back to ordinary `<img>` display when its
 * readable fetch fails. Only unprocessed tiles (`ProcessingRecipe::None`,
 * serialized as `"none"`) qualify: processed tiles require readable bytes.
 * @param {unknown} processing stable recipe id, never display text
 */
function isOrdinaryTile(processing: unknown) {
  return processing === undefined || processing === null || processing === "" || processing === "none";
}

/** @param {string} url ordinary display load, never readable bytes */
function loadOrdinaryImage(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    // Deliberately never set crossOrigin: ordinary display, no byte access.
    img.addEventListener("load", () => resolve(img), { once: true });
    img.addEventListener("error", () => reject(new Error("ordinary image failed: " + url)), { once: true });
    img.src = url;
  });
}

async function assemble(session: wasm.DiscoverySession, plan: TilePlan, tabOrigin: string, onProgress: (current: number, total: number, step: string) => void) {
  const canvas = document.createElement("canvas");
  canvas.width = plan.canvas.x;
  canvas.height = plan.canvas.y;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw Object.assign(new Error("2D canvas unavailable"), { code: "output-surface-unavailable" });
  const fetcher = makeTabFetcher(tabOrigin);
  let done = 0;
  let failedTiles = 0;
  // Taint gate (same rule as the extension page assemble): pixel reads stay
  // behind originClean. Readable session bytes keep the canvas clean; once a
  // cross-origin draw taints it, the run finishes as display-only success
  // (visible canvas, no byte save) and NEVER calls getImageData, toBlob, or
  // toDataURL on the tainted canvas again.
  let originClean = true;
  let lastStartMs = 0;
  for (const tile of plan.tiles) {
    throwIfCancelled();
    const nowStart = Date.now();
    const sinceLast = nowStart - lastStartMs;
    if (lastStartMs !== 0 && sinceLast < MODAL_TILE_MIN_INTERVAL_MS) {
      await new Promise((resolve) => setTimeout(resolve, MODAL_TILE_MIN_INTERVAL_MS - sinceLast));
    }
    lastStartMs = Date.now();
    let drawable: CanvasImageSource & { width: number; height: number } | null = null;
    let ordinary = false;
    try {
      const out = await fetcher.fetchResource(tile.uri, { userIntent: true });
      let bytes = out.bytes;
      if (tile.processing) bytes = session.applyProcessing(tile.processing, bytes);
      drawable = await createImageBitmap(new Blob([new Uint8Array(bytes).slice().buffer]));
    } catch (e) {
      if (!isOrdinaryTile(tile.processing)) {
        failedTiles += 1;
        onProgress(done + failedTiles, plan.tiles.length, "tile failed, continuing");
        continue;
      }
      // Ordinary display fallback: visible `<img>`, no byte access.
      try {
        drawable = await loadOrdinaryImage(tile.uri);
        ordinary = true;
      } catch {
        failedTiles += 1;
        onProgress(done + failedTiles, plan.tiles.length, "tile failed, continuing");
        continue;
      }
    }
    const planW = tile.w ?? drawable.width;
    const planH = tile.h ?? drawable.height;
    if (planW > 0 && planH > 0 && drawable.width > 0 && drawable.height > 0) {
      ctx.drawImage(drawable, 0, 0, drawable.width, drawable.height, tile.x, tile.y, planW, planH);
    }
    if (ordinary) {
      // An ordinary draw may taint: mark display-only WITHOUT probing reads.
      originClean = false;
      done += 1;
      onProgress(done + failedTiles, plan.tiles.length, "display-only tile " + done + " of " + plan.tiles.length);
      continue;
    }
    if (originClean) {
      try {
        ctx.getImageData(tile.x + 5, tile.y + 5, 1, 1);
        done += 1;
        onProgress(done + failedTiles, plan.tiles.length, "tile " + (done + failedTiles) + " of " + plan.tiles.length);
      } catch (taint) {
        originClean = false;
        done += 1;
        onProgress(done + failedTiles, plan.tiles.length, "display-only (canvas tainted)");
      }
    } else {
      done += 1;
      onProgress(done + failedTiles, plan.tiles.length, "display-only tile " + done + " of " + plan.tiles.length);
    }
  }
  if (!originClean) {
    return { blob: null, canvas, done, failedTiles, total: plan.tiles.length, originClean, displayOnly: true };
  }
  if (done === 0) {
    throw Object.assign(new Error("all " + plan.tiles.length + " tiles failed"), { code: "tile-failed" });
  }
  const blob = await new Promise((r) => canvas.toBlob(r, "image/png"));
  return { blob, canvas, done, failedTiles, total: plan.tiles.length, originClean, displayOnly: false };
}

function extensionForSaveFormat(format: unknown) {
  const lower = typeof format === "string" ? format.toLowerCase() : "png";
  if (lower === "jpeg" || lower === "jpg") return "jpg";
  if (lower === "tiff" || lower === "tif") return "tif";
  return "png";
}

function suggestedNameFor(width: unknown, height: unknown, format: unknown) {
  const ext = extensionForSaveFormat(format);
  const w = typeof width === "number" ? width : Number(width);
  const h = typeof height === "number" ? height : Number(height);
  if (Number.isFinite(w) && Number.isFinite(h) && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0) {
    return `dezoomify-${w}x${h}.${ext}`;
  }
  return `dezoomify.${ext}`;
}

/** Blob-anchor save (no `downloads` permission). Returns the file name. */
function save(blob: Blob, width: number, height: number) {
  const url = trackObjectUrl(URL.createObjectURL(blob));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = suggestedNameFor(width, height, "png");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  return anchor.download;
}

function rankUrls(urls: string[]): RankedCandidate[] {
  if (typeof wasm.rankCandidates !== "function") {
    return urls.map((url) => ({ url, format: null }));
  }
  try {
    const ranked = JSON.parse(wasm.rankCandidates(JSON.stringify(urls))) as unknown;
    if (Array.isArray(ranked) && ranked.every((entry) => entry && typeof entry.url === "string")) {
      return ranked as RankedCandidate[];
    }
  } catch {
    // Fall through to first-seen order below.
  }
  return urls.map((url) => ({ url, format: null }));
}

/**
 * Handoff consent dialog. Same shared modal geometry as the extension page
 * (`openModal` in shared-ui `view.ts`: one `.dz-modal-backdrop`
 * (role=dialog, aria-modal) holding a `.dz-modal-card` with close button,
 * title, subtitle, body, actions; explicit confirm/decline, Escape and
 * backdrop dismiss as decline, Tab trapped inside, focus returns to the
 * opener). All labels via `textContent`, never markup. Initial focus is the
 * decline action so an accidental Enter fails safe.
 */
function requestHandoffConsent(details: { origins: readonly string[]; cookieNames: readonly string[]; host: string; jobId: string }): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const doc = document;
    doc.querySelector(".dz-modal-backdrop")?.remove();
    const opener = doc.activeElement instanceof HTMLElement ? doc.activeElement : null;
    const origins = Array.isArray(details.origins) ? details.origins : [];
    const cookieNames = Array.isArray(details.cookieNames) ? details.cookieNames : [];

    const backdrop = doc.createElement("div");
    backdrop.className = "dz-modal-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-labelledby", "dz-handoff-title");

    const card = doc.createElement("div");
    card.className = "dz-modal-card";

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
    const settle = (value: boolean) => {
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
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settle(false);
        return;
      }
      if (e.key !== "Tab") return;
    const focusables = [...backdrop.querySelectorAll<HTMLButtonElement>("button")].filter((el) => !el.disabled);
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
 * Offer native handoff for the discovered source. The button lives in the
 * shared completed section's actions row so a re-render unmounts it with the
 * section and it can never duplicate. Explicit consent names the destination
 * origins and cookie names; values cross once in a bounded message.
 * @param {string} sourceUrl non-secret validated source
 */
function offerNativeHandoff(sourceUrl: string) {
  let origin;
  try {
    origin = new URL(sourceUrl).origin + "/";
  } catch {
    return;
  }
  const actions = document.querySelector("#dz-modal-app .dz-completed-section .dz-actions-row");
  if (!actions) return;
  if (actions.querySelector("[data-handoff]")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "dz-btn-secondary";
  button.dataset.handoff = sourceUrl;
  button.textContent = "Send to desktop app (" + origin + ")";
  button.addEventListener("click", () => {
    handoffToDesktop(sourceUrl, origin).catch(() => {});
  });
  actions.append(button);
}

/**
 * Run one consented handoff via Native Messaging + cookies permission.
 * @param {string} sourceUrl
 * @param {string} origin exact consented scope (`scheme://host[:port]/`)
 */
async function handoffToDesktop(sourceUrl: string, origin: string) {
  const sendNativeMessage = (msg: JsonObject): Promise<NativeMessage> => {
    const runtime = api && api.runtime;
    if (!runtime || typeof runtime.sendNativeMessage !== "function") {
      return Promise.reject(Object.assign(new Error("native host unavailable"), { code: "native-unavailable" }));
    }
    return runtime.sendNativeMessage(NATIVE_HOST_NAME, msg);
  };
  try {
    if (api && api.permissions && typeof api.permissions.request === "function") {
      const granted = await api.permissions.request({
        permissions: ["cookies"],
        origins: [origin + "*"],
      });
      if (!granted) return;
    }
  } catch {
    return;
  }
  let cookieNames: string[] = [];
  try {
    if (api && api.cookies && typeof api.cookies.getAll === "function") {
      const listed = await api.cookies.getAll({ url: sourceUrl });
      const names = [...new Set(listed.map((c) => c.name).filter((n) => typeof n === "string"))];
      cookieNames = names.slice(0, 64);
    }
  } catch {
    cookieNames = [];
  }
  const jobId = "job:modal-" + Date.now();
  const cookiesApi = api?.cookies;
  if (!cookiesApi) return;
  await requestNativeHandoff({
    sourceUrl,
    origins: [origin],
    cookieNames,
    jobId,
    sendNativeMessage,
    getCookies: async (scope) => {
      const all = await cookiesApi.getAll({ url: scope });
      return all.map((c) => ({ name: c.name, value: c.value }));
    },
    showConsent: (details) => requestHandoffConsent(details),
  });
}

function failState(code: string, message: string) {
  return {
    failure: { code, category: "extension", retryable: true, message },
  };
}

async function runDiscovery() {
  modalState.cancelRequested = false;
  render("discovering", jobCtx("Looking at this page…"));
  try {
    // Indefinite byte-confirmation loop: every untested candidate is probed
    // via the wasm DiscoverySession (browser-session fetch, actual response
    // bytes, never URL text) in rank order. The first candidate whose
    // catalog holds an image is detection. When the window is exhausted the
    // run waits for more candidates instead of failing; only Cancel/Escape
    // aborts via throwIfCancelled. Monitoring never times out to failure.
    const tested = new Set<string>();
    for (;;) {
      throwIfCancelled();
      const urls = modalState.urls.filter((u) => validateCandidateUrl(u).ok && !tested.has(u));
      if (urls.length === 0) {
        render(
          "discovering",
          jobCtx("Monitoring this tab… " + modalState.urls.length + " requests seen"),
        );
        await waitForMoreCandidates();
        throwIfCancelled();
        continue;
      }
      // Tab origin pre-grant: the toolbar click covers the clicked tab, so its
      // origin fetches under the existing session; anything else prompts.
      const tabOrigin = tabOriginOf(modalState.urls[0] ?? urls[0]);
      await init();
      const ranked = rankUrls(urls);
      render("discovering", jobCtx("Finding the zoomable image…", { url: redactUrlForLabel(ranked[0]?.url ?? urls[0]) }));
      let found: ({ session: wasm.DiscoverySession; catalog: Catalog; source: string }) | null = null;
      for (let i = 0; i < ranked.length; i++) {
        throwIfCancelled();
        const candidate = ranked[i];
        tested.add(candidate.url);
        render(
          "discovering",
          jobCtx("Finding the zoomable image (" + (i + 1) + "/" + ranked.length + ")…", {
            url: redactUrlForLabel(candidate.url),
          }),
        );
        try {
          const result = await discover(candidate.url, tabOrigin);
          if (result.catalog.images && result.catalog.images.length > 0) {
            found = { ...result, source: candidate.url };
            break;
          }
        } catch (e) {
          throwIfCancelled();
          // Candidate failed: keep trying the rest in rank order.
        }
      }
      if (!found) {
        render(
          "discovering",
          jobCtx("Monitoring this tab… " + modalState.urls.length + " requests seen"),
        );
        await waitForMoreCandidates();
        throwIfCancelled();
        continue;
      }
      // Byte confirmation first so the loader reveals the job UI promptly,
      // before heavy level planning and tile assembly.
      postToLoader({ kind: "dz-byte-confirmed", source: found.source });
      const { session, catalog } = found;
    const image = catalog.images[0];
    if (!image) throw Object.assign(new Error("catalog has no image"), { code: "no-image" });

    render(
      "downloading",
      jobCtx("Choosing the highest resolution…", {
        url: redactUrlForLabel(found.source),
        rest: { imageCount: catalog.images.length },
      }),
    );
    const plan = await planLevel(session, image, tabOrigin);
    throwIfCancelled();
    render(
      "downloading",
      jobCtx("Saving image tiles…", {
        url: redactUrlForLabel(found.source),
        progress: { current: 0, total: plan.tiles.length },
        rest: { imageCount: catalog.images.length },
      }),
    );
    const result = await assemble(session, plan, tabOrigin, (current, total, step) => {
      render(
        "downloading",
        jobCtx(step, {
          url: redactUrlForLabel(found.source),
          progress: { current, total },
          rest: { imageCount: catalog.images.length },
        }),
      );
    });
    throwIfCancelled();
    if (result.displayOnly || result.originClean === false) {
      // Display-only: the assembled canvas stays visible below without a
      // byte save (right-click to save where the browser supports it); the
      // desktop app stays available for a clean file.
      render("display-only", {
        jobActivity: {
          startedAt: Date.now() - 1000,
          stepLabel: "Shown below without saving",
          url: redactUrlForLabel(found.source),
        },
        imageCount: catalog.images.length,
      });
      appendDisplayCanvas(result.canvas, plan.canvas.x, plan.canvas.y);
      offerNativeHandoff(found.source);
      return;
    }
    render(
      "saving",
      jobCtx("Assembling the final picture…", {
        url: redactUrlForLabel(found.source),
        progress: { current: result.total, total: result.total },
        rest: { imageCount: catalog.images.length },
      }),
    );
    if (!(result.blob instanceof Blob)) throw Object.assign(new Error("canvas encoding returned no blob"), { code: "output-encode-failed" });
    const savedName = save(result.blob, plan.canvas.x, plan.canvas.y);
    render("completed", {
      jobActivity: { startedAt: Date.now() - 1000, url: redactUrlForLabel(found.source) },
      completedInfo: { width: plan.canvas.x, height: plan.canvas.y, mime: "image/png" },
      savedOutput: {
        name: savedName,
        width: plan.canvas.x,
        height: plan.canvas.y,
        doneTiles: result.done,
        totalTiles: result.total,
        failedTiles: result.failedTiles,
      },
      imageCount: catalog.images.length,
    });
    offerNativeHandoff(found.source);
    return;
    } // end indefinite byte-confirmation loop
  } catch (e) {
    const error = e && typeof e === "object" ? e as ErrorLike : {};
    if (error.code === "cancelled" || modalState.cancelRequested) {
      render("cancelled", jobCtx("Save cancelled"));
    } else {
      const code = typeof error.code === "string" ? error.code : "job-failed";
      render("failed", {
        ...failState(code, typeof error.message === "string" ? error.message : "Could not dezoomify image"),
        jobActivity: { startedAt: Date.now() - 1000 },
      });
      // The loader keeps the iframe visible and the background marks the
      // action as failed. This prevents fatal startup/job errors from looking
      // like an unexplained return to the grey idle state.
      postToLoader({
        kind: "dz-modal-error",
        code: String(code),
        message: "Could not dezoomify image (" + String(code) + ")",
      });
    }
  }
}

/**
 * Ordinary display of the assembled (tainted) canvas: the canvas stays
 * visible and the browser's right-click save applies where supported. The
 * canvas is NEVER pixel-read or serialized here.
 */
function appendDisplayCanvas(canvas: HTMLCanvasElement, width: number, height: number) {
  try {
    const section = document.querySelector("#dz-modal-app .dz-notice-section");
    if (!section) return;
    const label = document.createElement("p");
    label.className = "dz-notice-message";
    label.textContent = "Assembled view (" + width + " by " + height + " pixels). Right-click the image to save it.";
    canvas.style.maxWidth = "100%";
    canvas.style.height = "auto";
    section.append(label, canvas);
  } catch {
    // Display-only must never fail the job.
  }
}

function installFocusTrap() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      requestClose();
      return;
    }
    if (e.key !== "Tab") return;
    const focusables = [...document.querySelectorAll<HTMLElement>("button, a[href]")].filter((el) => !(el instanceof HTMLButtonElement) || !el.disabled);
    if (focusables.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey) {
      if (active === first || !document.contains(active)) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  });
}

function installDismiss() {
  const dismiss = document.getElementById("dz-modal-dismiss");
  if (dismiss) {
    dismiss.addEventListener("click", () => requestClose());
    dismiss.focus();
  }
}

function installHandshake() {
  window.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (!data || typeof data !== "object") return;
    const message = data as { token?: unknown; kind?: unknown; urls?: unknown[] };
    if (message.token !== modalState.token) return;
    if (message.kind === "dz-modal-candidates" && Array.isArray(message.urls)) {
      let added = false;
      for (const url of message.urls) {
        if (typeof url === "string" && validateCandidateUrl(url).ok && !modalState.urls.includes(url)) {
          modalState.urls.push(url);
          added = true;
        }
      }
      // Repeat posts accepted at any time: wake the waiter so the
      // byte-confirmation loop re-ranks the new window.
      if (added) wakeCandidatesWaiter();
      if (!modalState.started) {
        modalState.started = true;
        void runDiscovery();
      }
    }
  });
  // Announce presence: the loader answers with the merged candidates.
  postToLoader({ kind: "dz-modal-ready" });
  // Start at once so the monitoring state renders even before the first
  // candidates post; the loop waits indefinitely for candidates instead of
  // timing out to failure. Cancel/Escape still aborts via throwIfCancelled.
  if (!modalState.started) {
    modalState.started = true;
    void runDiscovery();
  }
}

modalState.token = modalToken();
installDismiss();
installFocusTrap();
installHandshake();
render("discovering", jobCtx("Looking at this page…"));
