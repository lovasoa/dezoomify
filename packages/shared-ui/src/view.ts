// Modern accessible Shared UI view renderer.
// Binds host-neutral DOM components to the shared controller and app integration.

import type { ControllerState, StructuredError, AppCapabilities } from "./controller.ts";
import { renderAppChoice } from "./controller.ts";
import {
  renderTransportLabel,
  renderSaveGuidance,
  renderProgress,
  renderCompletion,
  formatElapsed,
  formatRemaining,
  getDezoomifyLogoSvg,
} from "./components.ts";

export interface ViewCallbacks {
  onSubmitUrl(url: string): void;
  onCancel(): void;
  onReset(): void;
  /** Retry the same URL without clearing it (failed-section Try again). Optional for backward compatibility. */
  onRetrySameUrl?(): void;
  onSave(): void;
  onSelectImage?(index: number): void;
  onSelectLevel?(level: number): void;
  onOpenExternalLink?(url: string): void;
  onCopyShareLink?(): void;
}

export interface JobActivity {
  url?: string;
  startedAt?: number;
  now?: number;
  /** Short human description of the current step (one line). */
  stepLabel?: string;
  /** Secondary one-line detail (e.g. which transport is in use). */
  detail?: string;
  pendingRequests?: number;
  completedRequests?: number;
  failedRequests?: number;
  /** Age of the longest currently-pending request, ms. */
  longestPendingMs?: number;
  /** Per-request timeout applied to every HTTP request, ms. */
  timeoutMs?: number;
  /** Last time visible progress was made, ms epoch. */
  lastProgressAt?: number;
  /** Capped technical log lines (oldest first). Never rendered unescaped. */
  log?: string[];
}

export interface ViewContext {
  capabilities?: AppCapabilities;
  currentProgress?: { current: number; total: number; message?: string };
  completedInfo?: { width: number; height: number; mime: string; blobUrl?: string };
  originClean?: boolean;
  jobActivity?: JobActivity;
  /** Prefilled URL (e.g. restored from a legacy `#url` hash). */
  initialUrl?: string;
  /**
   * Auto-choice notice (todo 4.3): local-only aux, never a protocol event.
   * The pipeline auto-saves images[0] at the largest fitting level; the job
   * view renders this honestly from controller imageCount plus these dims.
   * No picker is offered.
   */
  imageChoice?: { width?: number; height?: number; tiles?: number };
}

export interface ModalHost {
  document: Document;
}

export function openModal(
  hostDocument: Document,
  title: string,
  subtitle: string,
  contentHtml: string,
): void {
  hostDocument.querySelector(".dz-modal-backdrop")?.remove();

  const backdrop = hostDocument.createElement("div");
  backdrop.className = "dz-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "dz-modal-title");

  const card = hostDocument.createElement("div");
  card.className = "dz-modal-card";

  const closeBtn = hostDocument.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "dz-modal-close";
  closeBtn.setAttribute("aria-label", "Close dialog");
  closeBtn.title = "Close";
  closeBtn.textContent = "×";

  const titleEl = hostDocument.createElement("h2");
  titleEl.id = "dz-modal-title";
  titleEl.className = "dz-modal-title";
  titleEl.textContent = title;

  const subtitleEl = hostDocument.createElement("p");
  subtitleEl.className = "dz-modal-subtitle";
  subtitleEl.textContent = subtitle;

  const body = hostDocument.createElement("div");
  body.className = "dz-modal-body";
  body.innerHTML = contentHtml;

  const actions = hostDocument.createElement("div");
  actions.className = "dz-modal-actions";
  const okBtn = hostDocument.createElement("button");
  okBtn.type = "button";
  okBtn.className = "dz-btn-tactile dz-modal-ok";
  okBtn.setAttribute("style", "min-width: 100px;");
  okBtn.textContent = "Got it";
  actions.appendChild(okBtn);

  card.append(closeBtn, titleEl, subtitleEl, body, actions);

  const close = () => {
    backdrop.remove();
    hostDocument.removeEventListener("keydown", onKeyDown);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  closeBtn.addEventListener("click", close);
  okBtn.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  hostDocument.addEventListener("keydown", onKeyDown);

  backdrop.appendChild(card);
  hostDocument.body.appendChild(backdrop);
}

export interface PlatformHints {
  userAgent?: string;
  platform?: string;
}

function detectPlatform(hints?: PlatformHints): { name: string; file: string; label: string } {
  const ua = (hints?.userAgent ?? "").toLowerCase();
  const platform = (hints?.platform ?? "").toLowerCase();
  if (ua.includes("win") || platform.includes("win")) {
    return { name: "Windows", file: ".msi / .exe", label: "Save for Windows" };
  }
  if (ua.includes("mac") || platform.includes("mac")) {
    return { name: "macOS", file: ".dmg", label: "Save for macOS" };
  }
  if (ua.includes("linux") || platform.includes("linux")) {
    return { name: "Linux", file: ".AppImage / .deb", label: "Save for Linux" };
  }
  return { name: "All Platforms", file: "latest releases", label: "Save Native App" };
}

export function showDesktopAppGuidance(hostDocument: Document, hints?: PlatformHints): void {
  const p = detectPlatform(hints);
  openModal(
    hostDocument,
    "Dezoomify Desktop App",
    "High-performance native application for gigapixel museum artworks and local scans",
    `
      <div class="dz-modal-download-box">
        <div style="font-size: 0.9rem; color: var(--dz-text-muted);">
          No installer ships yet. A future installer for ${escapeHtml(p.name)} will appear on
          <a href="https://github.com/lovasoa/dezoomify/releases" target="_blank" rel="noopener">GitHub Releases</a>.
        </div>
      </div>

      <div class="dz-modal-section">
        <div class="dz-modal-section-title">Why use the Desktop App?</div>
        <ul class="dz-modal-list">
          <li><strong>Handles Larger Artworks:</strong> A browser tab can only hold a certain amount of picture. The desktop app assembles the image in memory (up to its 8 GiB canvas limit, needing matching free memory) and writes the finished output to disk.</li>
          <li><strong>Saves the Finished Picture:</strong> Each run saves one job to one output file on your computer.</li>
          <li><strong>When the Website Cannot Finish:</strong> The website stops the job with an error and points to the desktop app for the full-size image.</li>
        </ul>
      </div>

      <div class="dz-modal-section">
        <div class="dz-modal-section-title">How to use it</div>
        <div class="dz-modal-steps">
          <div class="dz-modal-step">
            <span class="dz-modal-step-num">1</span>
            <div>No installer ships yet; a future installer for ${escapeHtml(p.name)} will appear on our GitHub Releases page.</div>
          </div>
          <div class="dz-modal-step">
            <span class="dz-modal-step-num">2</span>
            <div>Launch Dezoomify and paste your zoomable image or manifest URL.</div>
          </div>
          <div class="dz-modal-step">
            <span class="dz-modal-step-num">3</span>
            <div>Select your desired resolution and destination folder to save the complete composite image.</div>
          </div>
        </div>
      </div>

      <div class="dz-modal-cli-box">
        <div class="dz-modal-cli-header">
          <strong>Need automation? Try the Dezoomify CLI</strong>
        </div>
        <p class="dz-modal-cli-desc">
          The CLI provides headless, scriptable single-job saving ideal for automated pipelines and server environments without a GUI.
        </p>
        <div class="dz-modal-cli-links">
          <a href="https://github.com/lovasoa/dezoomify/releases/latest" target="_blank" rel="noopener" class="dz-btn-secondary" style="height: 32px; font-size: 0.85rem;">
            Save CLI from GitHub Releases
          </a>
          <code style="font-family: var(--dz-font-mono); font-size: 0.82rem; padding: 0.35rem 0.6rem; background: rgba(0,0,0,0.04); border-radius: 4px; border: 1px solid var(--dz-surface-border);">
            cargo install dezoomify-cli
          </code>
        </div>
      </div>
    `
  );
}

export function showExtensionGuidance(hostDocument: Document): void {
  openModal(
    hostDocument,
    "Dezoomify Browser Extension",
    "Automatic viewer discovery for password-protected digital archives and complex pages",
    `
      <div class="dz-modal-stores">
        <a href="https://chromewebstore.google.com/detail/dezoomify/iapjjopjejpelnfdonefbffahmcndfbm" target="_blank" rel="noopener" class="dz-btn-store">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <circle cx="12" cy="12" r="4"></circle>
            <line x1="21.17" y1="8" x2="12" y2="8"></line>
            <line x1="3.95" y1="6.06" x2="8.54" y2="14"></line>
            <line x1="10.88" y1="21.94" x2="15.46" y2="14"></line>
          </svg>
          <div>
            <div style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8;">Available on</div>
            <div style="font-weight: 700; font-size: 0.98rem;">Chrome Web Store</div>
          </div>
        </a>
        <div class="dz-btn-store" aria-disabled="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 2a10 10 0 0 1 10 10c0 5.52-4.48 10-10 10S2 17.52 2 12c0-2.5 1-4.8 2.6-6.5C7.2 9 8 13 12 14c0-2 1-3.5 2.5-4.5C13 8 11.5 6 12 2z"></path>
          </svg>
          <div>
            <div style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8;">Firefox version</div>
            <div style="font-weight: 700; font-size: 0.98rem;">On its way</div>
          </div>
        </div>
      </div>

      <div class="dz-modal-section">
        <div class="dz-modal-section-title">Why use the Browser Extension?</div>
        <ul class="dz-modal-list">
          <li><strong>Signed-In Pages:</strong> While you look at a zoomable image, it can find the image behind the viewer automatically, including on pages where you are signed in, such as library portals, museum subscriptions, and academic archives.</li>
          <li><strong>Easy to Use:</strong> Press the Dezoomify button in the browser toolbar and pick the image to save, or send the job to the desktop app if the image is very large.</li>
          <li><strong>Private:</strong> It only looks at the page you pointed it at, only after you pressed the button. It does not watch your browsing in the background.</li>
        </ul>
      </div>

      <div class="dz-modal-section">
        <div class="dz-modal-section-title">How to use it in 3 steps</div>
        <div class="dz-modal-steps">
          <div class="dz-modal-step">
            <span class="dz-modal-step-num">1</span>
            <div>Install the extension from the Chrome Web Store. The Firefox version is on its way.</div>
          </div>
          <div class="dz-modal-step">
            <span class="dz-modal-step-num">2</span>
            <div>Navigate to the museum or library page displaying your artwork, logging in if needed.</div>
          </div>
          <div class="dz-modal-step">
            <span class="dz-modal-step-num">3</span>
            <div>Click the Dezoomify icon in your browser toolbar to automatically detect and extract the full-resolution image!</div>
          </div>
        </div>
      </div>
    `
  );
}

export type ViewPhase =
  | "idle"
  | "job"
  | "display-only"
  | "completed"
  | "failed"
  | "cancelled"
  | "generic";

export function getPhaseForStatus(status: ControllerState["status"]): ViewPhase {
  switch (status) {
    case "idle":
      return "idle";
    case "discovering":
    case "choosing-image":
    case "choosing-level":
    case "preflighting":
    case "downloading":
    case "saving":
      return "job";
    case "display-only":
      return "display-only";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      return "generic";
  }
}

export function renderView(
  container: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  // Ensure the card container is stable across updates
  let card = container.querySelector<HTMLElement>(".dz-card");
  if (!card) {
    container.innerHTML = "";
    card = container.ownerDocument.createElement("div");
    card.className = "dz-card";
    container.appendChild(card);
  }

  // Header with authentic title & icon (mounted once)
  let header = card.querySelector<HTMLElement>(".dz-header");
  if (!header) {
    header = container.ownerDocument.createElement("div");
    header.className = "dz-header";
    header.innerHTML = `
      <h1 class="dz-title">
        <span>Dezoomify</span>
        ${getDezoomifyLogoSvg(28)}
      </h1>
    `;
    card.prepend(header);
  }

  // Major view phase management:
  // Transition between different screens (idle -> job -> completed/failed) mounts
  // new body elements once with entrance animation. Within an active job, fine-grained
  // in-place updates mutate existing nodes, guaranteeing that animations do not
  // re-trigger, open details do not snap shut, and the screen NEVER flickers or blinks.
  const phase = getPhaseForStatus(state.status);
  const currentPhase = card.dataset.viewPhase;

  if (currentPhase !== phase) {
    card.querySelectorAll(".dz-view-body").forEach((el) => el.remove());
    card.dataset.viewPhase = phase;

    switch (phase) {
      case "idle":
        mountInputSection(card, state, callbacks, ctx);
        break;

      case "job":
        mountJobSection(card, state, callbacks, ctx);
        break;

      case "display-only":
        mountDisplayOnlySection(card, state, callbacks, ctx);
        break;

      case "completed":
        mountCompletedSection(card, state, callbacks, ctx);
        break;

      case "failed":
        mountFailedSection(card, state, callbacks, ctx);
        break;

      case "cancelled":
        mountCancelledSection(card, state, callbacks, ctx);
        break;

      default:
        mountGenericState(card, state, callbacks, ctx);
        break;
    }
  } else {
    // Same phase: mutate existing DOM elements in place
    switch (phase) {
      case "idle":
        updateInputSection(card, ctx);
        break;
      case "job":
        updateJobSection(card, state, callbacks, ctx);
        break;
      case "failed":
        updateFailedSection(card, state, callbacks, ctx);
        break;
    }
  }
}

function escapeHtml(value: string): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateMiddle(value: string, max = 90): string {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

/** The website a request is waiting on, for plain-language messages. */
function hostFromUrl(url: string | undefined): string {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "the server";
  }
}

function updateInputSection(
  card: HTMLElement,
  ctx?: ViewContext,
): void {
  const input = card.querySelector<HTMLInputElement>("#dz-url-input");
  if (input && !input.value && ctx?.initialUrl) {
    input.value = ctx.initialUrl;
    const clearBtn = card.querySelector<HTMLButtonElement>("#dz-btn-clear");
    if (clearBtn) clearBtn.style.display = "flex";
  }
}

function mountInputSection(
  parent: HTMLElement,
  _state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const body = parent.ownerDocument.createElement("div");
  body.className = "dz-view-body dz-fade-in";

  // Description
  const desc = parent.ownerDocument.createElement("div");
  desc.className = "dz-description";
  desc.innerHTML = `
    <p>
      <strong>Dezoomify</strong> allows you to save
      <abbr title="Large images in which you can navigate inside a webpage.">zoomable images</abbr>.
      Enter the <abbr title="Uniform Resource Locator, the address of a webpage">URL</abbr>
      of such an image in the text field below. The image will be saved at maximal resolution.
      You can then right-click on the image, and choose "Save As" in order to save it as a PNG file on your computer.
      If it doesn't work, read our <a href="./help/troubleshooting.html" target="_blank" rel="noopener">troubleshooting guide</a>.
      If you want more information, read our <a href="https://github.com/lovasoa/dezoomify#dezoomify" target="_blank" rel="noopener">project page</a>.
    </p>
    <p class="dz-license-text">
      This script is released under the <a href="http://www.gnu.org/licenses/gpl.html" target="_blank" rel="noopener">GPL</a>.
      <a href="http://github.com/lovasoa/dezoomify" target="_blank" rel="noopener">See the source code</a>.
      <a href="./terms.html" target="_blank" rel="noopener">We decline any responsibility for an illegal use of this software</a>.
    </p>
  `;
  body.appendChild(desc);

  const form = parent.ownerDocument.createElement("form");
  form.className = "dz-form";
  form.onsubmit = (e) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>("#dz-url-input");
    const url = input?.value.trim() ?? "";
    if (!url) {
      input?.focus();
      return;
    }
    callbacks.onSubmitUrl(url);
  };

  // Full-width URL input row
  const wrapper = parent.ownerDocument.createElement("div");
  wrapper.className = "dz-input-wrapper";
  const prefilled = escapeHtml(ctx?.initialUrl ?? "");
  wrapper.innerHTML = `
    <input
      type="url"
      id="dz-url-input"
      class="dz-input"
      placeholder="URL of the webpage containing your image"
      required
      autofocus
      value="${prefilled}"
      aria-label="URL of the webpage containing your zoomable image"
    />
    <button type="button" class="dz-input-clear" id="dz-btn-clear" title="Clear input" aria-label="Clear input">&times;</button>
  `;

  const inputEl = wrapper.querySelector<HTMLInputElement>("#dz-url-input");
  const clearBtn = wrapper.querySelector<HTMLButtonElement>("#dz-btn-clear");
  if (inputEl && clearBtn) {
    const syncClear = () => {
      clearBtn.style.display = inputEl.value ? "flex" : "none";
    };
    inputEl.addEventListener("input", syncClear);
    syncClear();
    clearBtn.addEventListener("click", () => {
      inputEl.value = "";
      clearBtn.style.display = "none";
      inputEl.focus();
    });
  }
  form.appendChild(wrapper);

  // Discovery detects the image format automatically from the URL and page
  // contents; the submit path carries no manual format override.
  // Centered Tactile "Dezoomify !" Button
  const btnRow = parent.ownerDocument.createElement("div");
  btnRow.className = "dz-button-row";

  const submitBtn = parent.ownerDocument.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "dz-btn-tactile";
  submitBtn.innerHTML = `<span>Dezoomify !</span>`;
  btnRow.appendChild(submitBtn);
  form.appendChild(btnRow);

  body.appendChild(form);
  parent.appendChild(body);
}

function defaultStepFor(status: ControllerState["status"]): string {
  switch (status) {
    case "discovering":
      return "Finding the zoomable image…";
    case "choosing-image":
      return "Image found; picking the best one…";
    case "choosing-level":
      return "Choosing the highest resolution…";
    case "preflighting":
      return "Checking the image size…";
    case "downloading":
      return "Saving image tiles…";
    case "saving":
      return "Assembling the final picture…";
    default:
      return "Working…";
  }
}

/**
 * Mount the live job view into the status card.
 * Mounted only ONCE upon entering the active job phase.
 * All subsequent ticks, progress reports, and step changes
 * execute `updateJobSection` to mutate existing DOM elements in place.
 * This guarantees zero flashing, no animation restarts, and preserves
 * user-opened details, clipboard feedback, and text selection.
 */
function mountJobSection(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const sec = parent.ownerDocument.createElement("div");
  sec.className = "dz-view-body dz-job-section dz-fade-in";
  sec.setAttribute("role", "status");
  sec.setAttribute("aria-live", "polite");

  // Keep latest callbacks accessible on the element without listener churn
  (sec as unknown as { _callbacks: ViewCallbacks })._callbacks = callbacks;

  sec.innerHTML = `
    <p class="dz-source-line" id="dz-job-source-line" style="display: none;">
      Working on <span class="dz-source-url" id="dz-job-source-url"></span>
    </p>
    <div class="dz-progress-header">
      <span class="dz-progress-status">
        <span class="dz-pulse" aria-hidden="true"></span>
        <span class="dz-progress-step-text" id="dz-job-step-text"></span>
      </span>
      <span class="dz-progress-percent" id="dz-job-percent"></span>
    </div>
    <div class="dz-progress-track dz-indeterminate" id="dz-job-track" role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">
      <div class="dz-progress-bar" id="dz-job-bar" style="width: 35%;"></div>
    </div>
    <p class="dz-tile-counts" id="dz-job-counts"></p>
    <p class="dz-job-detail" id="dz-job-images" style="display: none;">
      <span id="dz-job-images-text"></span>
      <button type="button" class="dz-btn-secondary" id="dz-job-change">Change</button>
    </p>
    <p class="dz-job-detail" id="dz-job-change-hint" style="display: none;"></p>
    <div class="dz-pending-box" id="dz-job-pending-box" style="display: none;">
      <div class="dz-pending-line">
        <span id="dz-job-pending-status"></span>
        <span class="dz-pending-time" id="dz-job-pending-time"></span>
      </div>
      <div class="dz-remaining-track" aria-hidden="true">
        <div class="dz-remaining-bar" id="dz-job-remaining-bar" style="width: 0%;"></div>
      </div>
    </div>
    <p class="dz-reassure" id="dz-job-reassure" style="display: none;"></p>
    <p class="dz-job-detail" id="dz-job-detail" style="display: none;"></p>
    <div class="dz-progress-controls">
      <span class="dz-transport-badge" id="dz-job-transport">Direct from your browser</span>
      <div class="dz-job-actions">
        <button type="button" class="dz-btn-secondary" id="dz-btn-share" style="display: none;">Copy shareable link</button>
        <button type="button" class="dz-btn-secondary" id="dz-btn-cancel">Cancel</button>
      </div>
    </div>
    <details class="dz-details" id="dz-job-details">
      <summary class="dz-summary">
        <span>Technical details &amp; logs</span>
        <svg class="dz-summary-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="dz-diagnostics" id="dz-job-diagnostics"></div>
      <div class="dz-diagnostics dz-log" id="dz-job-log" style="display: none;"></div>
    </details>
  `;

  sec.querySelector("#dz-btn-cancel")?.addEventListener("click", () => {
    const cb = (sec as unknown as { _callbacks: ViewCallbacks })._callbacks;
    cb?.onCancel();
  });
  sec.querySelector("#dz-btn-share")?.addEventListener("click", () => {
    const cb = (sec as unknown as { _callbacks: ViewCallbacks })._callbacks;
    cb?.onCopyShareLink?.();
  });
  sec.querySelector("#dz-job-change")?.addEventListener("click", () => {
    const hint = sec.querySelector<HTMLElement>("#dz-job-change-hint");
    if (hint) hint.style.display = hint.style.display === "none" ? "" : "none";
  });

  parent.appendChild(sec);
  updateJobSection(parent, state, callbacks, ctx);
}

/**
 * Perform targeted in-place DOM updates on the mounted job section.
 */
function updateJobSection(
  card: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const sec = card.querySelector<HTMLElement>(".dz-job-section");
  if (!sec) return;

  (sec as unknown as { _callbacks: ViewCallbacks })._callbacks = callbacks;

  const activity = ctx?.jobActivity ?? {};
  const current = ctx?.currentProgress?.current ?? 0;
  const total = ctx?.currentProgress?.total ?? 0;
  const determinate = total > 0;
  const pct = determinate ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
  const transport = state.transport ? renderTransportLabel(state.transport) : "Direct from your browser";
  const step = activity.stepLabel || ctx?.currentProgress?.message || defaultStepFor(state.status);
  const now = activity.now ?? Date.now();
  const startedAt = activity.startedAt ?? now;
  const elapsedMs = Math.max(0, now - startedAt);
  const elapsed = formatElapsed(elapsedMs);
  const pending = activity.pendingRequests ?? 0;
  const completed = activity.completedRequests ?? 0;
  const failed = activity.failedRequests ?? 0;
  const longestPending = activity.longestPendingMs ?? 0;
  const timeoutMs = activity.timeoutMs ?? 30000;
  const lastProgressAt = activity.lastProgressAt ?? startedAt;
  const stalledMs = Math.max(0, now - lastProgressAt);
  const showPending = pending > 0 && (elapsedMs >= 2000 || longestPending >= 2000);
  const showStalled = stalledMs >= 10000 && state.status !== "saving";
  const sourceUrl = activity.url ? truncateMiddle(activity.url, 90) : "";

  // 1. Source Line
  const sourceLine = sec.querySelector<HTMLElement>("#dz-job-source-line");
  const sourceUrlEl = sec.querySelector<HTMLElement>("#dz-job-source-url");
  if (sourceLine && sourceUrlEl) {
    if (sourceUrl) {
      sourceLine.style.display = "";
      sourceLine.title = activity.url ?? "";
      if (sourceUrlEl.textContent !== sourceUrl) {
        sourceUrlEl.textContent = sourceUrl;
      }
    } else {
      sourceLine.style.display = "none";
    }
  }

  // 2. Step Label & Percent/Elapsed
  const stepEl = sec.querySelector<HTMLElement>("#dz-job-step-text");
  if (stepEl && stepEl.textContent !== step) {
    stepEl.textContent = step;
  }

  const percentEl = sec.querySelector<HTMLElement>("#dz-job-percent");
  if (percentEl) {
    const percentText = determinate ? `${pct}%` : (elapsed || "");
    if (percentEl.textContent !== percentText) {
      percentEl.textContent = percentText;
    }
  }

  // 3. Track and Bar
  const track = sec.querySelector<HTMLElement>("#dz-job-track");
  const bar = sec.querySelector<HTMLElement>("#dz-job-bar");
  if (track && bar) {
    track.setAttribute("aria-valuenow", String(pct));
    track.setAttribute("aria-label", step);
    if (determinate) {
      track.classList.remove("dz-indeterminate");
      bar.style.width = `${pct}%`;
    } else {
      track.classList.add("dz-indeterminate");
      bar.style.width = "35%";
    }
  }

  // 4. Counts
  const countsEl = sec.querySelector<HTMLElement>("#dz-job-counts");
  if (countsEl) {
    const countsText = determinate
      ? `${current} of ${total} tiles${elapsed ? ` · ${elapsed} elapsed` : ""}`
      : elapsed
        ? `${elapsed} elapsed`
        : "";
    if (countsEl.textContent !== countsText) {
      countsEl.textContent = countsText;
    }
  }

  // 4b. Catalog auto-choice notice (todo 4.3): honest step without a picker.
  // Uses existing controller imageCount, never a new protocol event. WxH and
  // tile counts come from local ViewContext.imageChoice when known.
  const imagesEl = sec.querySelector<HTMLElement>("#dz-job-images");
  const imagesText = sec.querySelector<HTMLElement>("#dz-job-images-text");
  const changeHint = sec.querySelector<HTMLElement>("#dz-job-change-hint");
  const choiceCount = state.imageCount ?? 0;
  if (imagesEl && imagesText) {
    if (choiceCount > 0) {
      const choiceWidth = ctx?.imageChoice?.width ?? ctx?.completedInfo?.width ?? 0;
      const choiceHeight = ctx?.imageChoice?.height ?? ctx?.completedInfo?.height ?? 0;
      const choiceTiles = ctx?.imageChoice?.tiles ?? (determinate ? total : 0);
      const noun = choiceCount === 1 ? "1 image" : `${choiceCount} images`;
      let suffix = ".";
      if (choiceWidth > 0 && choiceHeight > 0 && choiceTiles > 0) {
        suffix = ` (${choiceWidth}×${choiceHeight}, ${choiceTiles} tiles).`;
      } else if (choiceWidth > 0 && choiceHeight > 0) {
        suffix = ` (${choiceWidth}×${choiceHeight}).`;
      } else if (choiceTiles > 0) {
        suffix = ` (${choiceTiles} tiles).`;
      }
      const notice = `Found ${noun}, saving largest that fits${suffix}`;
      if (imagesText.textContent !== notice) imagesText.textContent = notice;
      imagesEl.style.display = "";
      if (changeHint) {
        const hint = "The website saves the first image automatically. To choose a different image, use the desktop app.";
        if (changeHint.textContent !== hint) changeHint.textContent = hint;
      }
    } else {
      imagesEl.style.display = "none";
      if (changeHint) changeHint.style.display = "none";
    }
  }

  // 5. Pending section
  const pendingBox = sec.querySelector<HTMLElement>("#dz-job-pending-box");
  const pendingStatus = sec.querySelector<HTMLElement>("#dz-job-pending-status");
  const pendingTime = sec.querySelector<HTMLElement>("#dz-job-pending-time");
  const remainingBar = sec.querySelector<HTMLElement>("#dz-job-remaining-bar");
  if (pendingBox) {
    if (showPending) {
      pendingBox.style.display = "";
      if (pendingStatus) {
        const text = `${pending} request${pending === 1 ? "" : "s"} in flight${completed > 0 ? ` · ${completed} done` : ""}${failed > 0 ? ` · ${failed} failed, retrying` : ""}`;
        if (pendingStatus.textContent !== text) {
          pendingStatus.textContent = text;
        }
      }
      if (pendingTime) {
        const timeText = `${formatElapsed(longestPending)} waiting · ${formatRemaining(longestPending, timeoutMs)}`;
        if (pendingTime.textContent !== timeText) {
          pendingTime.textContent = timeText;
        }
      }
      if (remainingBar) {
        const remainingPct = Math.max(0, Math.min(100, Math.round((longestPending / timeoutMs) * 100)));
        remainingBar.style.width = `${remainingPct}%`;
      }
    } else {
      pendingBox.style.display = "none";
    }
  }

  // 6. Stalled Reassurance
  const reassureEl = sec.querySelector<HTMLElement>("#dz-job-reassure");
  if (reassureEl) {
    reassureEl.style.display = showStalled ? "" : "none";
    const reassureText = `Still working, ${hostFromUrl(activity.url)} is slow to answer. You can wait, or cancel and try again later.`;
    if (reassureEl.textContent !== reassureText) {
      reassureEl.textContent = reassureText;
    }
  }

  // 7. Detail
  const detailEl = sec.querySelector<HTMLElement>("#dz-job-detail");
  if (detailEl) {
    if (activity.detail) {
      detailEl.style.display = "";
      if (detailEl.textContent !== activity.detail) {
        detailEl.textContent = activity.detail;
      }
    } else {
      detailEl.style.display = "none";
    }
  }

  // 8. Transport badge & Action buttons
  const transportEl = sec.querySelector<HTMLElement>("#dz-job-transport");
  if (transportEl && transportEl.textContent !== transport) {
    transportEl.textContent = transport;
  }

  const shareBtn = sec.querySelector<HTMLElement>("#dz-btn-share");
  if (shareBtn) {
    shareBtn.style.display = callbacks.onCopyShareLink ? "" : "none";
  }

  // 9. Diagnostics & Logs (preserved in-place, keeping details open state intact)
  const diagEl = sec.querySelector<HTMLElement>("#dz-job-diagnostics");
  if (diagEl) {
    const diagText = diagnosticsText(state, ctx, elapsedMs, timeoutMs);
    if (diagEl.textContent !== diagText) {
      diagEl.textContent = diagText;
    }
  }

  const logEl = sec.querySelector<HTMLElement>("#dz-job-log");
  if (logEl) {
    if (activity.log && activity.log.length > 0) {
      logEl.style.display = "";
      const logText = activity.log.slice(-20).join("\n");
      if (logEl.textContent !== logText) {
        logEl.textContent = logText;
      }
    } else {
      logEl.style.display = "none";
    }
  }
}

function diagnosticsText(
  state: ControllerState,
  ctx?: ViewContext,
  elapsedMs?: number,
  timeoutMs?: number,
): string {
  const a = ctx?.jobActivity ?? {};
  const p = ctx?.currentProgress;
  const lines = [
    `Status: ${state.status}`,
    `Transport: ${state.transport ?? "direct"}`,
    `Elapsed: ${Math.round((elapsedMs ?? 0) / 1000)} s`,
    `Per-request timeout: ${Math.round((timeoutMs ?? a.timeoutMs ?? 30000) / 1000)} s`,
    `Requests: ${a.pendingRequests ?? 0} pending, ${a.completedRequests ?? 0} done, ${a.failedRequests ?? 0} failed`,
  ];
  if (p) lines.push(`Tiles: ${p.current} of ${p.total}`);
  if (a.url) lines.push(`Source: ${a.url}`);
  return lines.join("\n");
}

function renderProgressSection(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const sec = parent.querySelector(".dz-job-section");
  if (!sec) {
    mountJobSection(parent, state, callbacks, ctx);
  } else {
    updateJobSection(parent, state, callbacks, ctx);
  }
}

function mountDisplayOnlySection(
  parent: HTMLElement,
  _state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const guidance = renderSaveGuidance(false);
  const section = parent.ownerDocument.createElement("div");
  section.className = "dz-view-body dz-notice-section dz-fade-in";
  section.innerHTML = `
    <div class="dz-notice-header">
      <svg class="dz-notice-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <div>
        <h2 class="dz-notice-title">Display-Only Preview</h2>
        <p class="dz-notice-message">${guidance}</p>
      </div>
    </div>
  `;

  if (ctx?.capabilities) {
    const appChoice = renderAppChoice(ctx.capabilities);
    const guidanceBox = parent.ownerDocument.createElement("p");
    guidanceBox.className = "dz-notice-guidance";
    guidanceBox.textContent = appChoice;
    section.appendChild(guidanceBox);
  }

  const actions = parent.ownerDocument.createElement("div");
  actions.className = "dz-actions-row";
  actions.innerHTML = `
    <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Start over</button>
  `;
  actions.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  section.appendChild(actions);

  parent.appendChild(section);
}

function mountCompletedSection(
  parent: HTMLElement,
  _state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const info = ctx?.completedInfo;
  const isClean = ctx?.originClean ?? true;
  const summary = info ? renderCompletion(info.width, info.height, info.mime) : "Your image is ready.";
  const guidance = renderSaveGuidance(isClean);

  const section = parent.ownerDocument.createElement("div");
  section.className = "dz-view-body dz-completed-section dz-fade-in";
  section.innerHTML = `
    <div class="dz-completed-header">
      <svg class="dz-completed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <div>
        <h2 class="dz-completed-title">Save complete!</h2>
        <p class="dz-completed-summary">${summary}</p>
      </div>
    </div>
    <p class="dz-completed-guidance">${guidance}</p>
    <div class="dz-actions-row">
      ${isClean ? `<button type="button" class="dz-btn-tactile" id="dz-btn-save" style="min-width: 180px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Save image
      </button>` : ""}
      ${callbacks.onCopyShareLink ? `<button type="button" class="dz-btn-secondary" id="dz-btn-share">Copy shareable link</button>` : ""}
      <button type="button" class="dz-btn-secondary" id="dz-btn-another">Dezoomify another image</button>
    </div>
  `;

  section.querySelector("#dz-btn-save")?.addEventListener("click", () => callbacks.onSave());
  section.querySelector("#dz-btn-share")?.addEventListener("click", () => callbacks.onCopyShareLink?.());
  section.querySelector("#dz-btn-another")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(section);
}

/**
 * Technical diagnostics for the collapsible error section. The plain
 * `message` is shown prominently above; `detail` (raw engine diagnostics,
 * e.g. the per-format discovery breakdown) lives only here so the first
 * thing users read stays a single actionable sentence.
 */
function errorDiagnosticsText(error: StructuredError): string {
  const base =
    `Code: ${error.code}\n` +
    `Category: ${error.category}\n` +
    `Retryable: ${error.retryable}\n` +
    `Transport: ${error.transport ?? "direct"}\n` +
    `Phase: ${error.phase ?? "discovery"}\n` +
    `Message: ${error.message}`;
  return error.detail ? `${base}\n\n${error.detail}` : base;
}

function mountFailedSection(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  _ctx?: ViewContext,
): void {
  const error: StructuredError = state.error ?? {
    code: "UNKNOWN",
    category: "unknown",
    retryable: true,
    message: "Dezoomify could not find or save the zoomable image at this address.",
  };

  const section = parent.ownerDocument.createElement("div");
  section.className = "dz-view-body dz-error-section dz-fade-in";
  section.innerHTML = `
    <div class="dz-error-header">
      <svg class="dz-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <div>
        <h2 class="dz-error-title">Could not dezoomify image</h2>
        <p class="dz-error-message" id="dz-error-message"></p>
      </div>
    </div>

    <div class="dz-guidance-section">
      <h3 class="dz-guidance-title">Ways to save this artwork</h3>
      <div class="dz-guidance-grid">
        <button type="button" class="dz-guidance-item" id="dz-card-extension">
          <div class="dz-guidance-item-header">
            <svg class="dz-guidance-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            <span class="dz-guidance-item-title">Browser Extension Guide</span>
          </div>
          <span class="dz-guidance-item-desc">For pages requiring login or session cookies. Automatically detects viewers on active pages.</span>
        </button>
        <button type="button" class="dz-guidance-item" id="dz-card-desktop">
          <div class="dz-guidance-item-header">
            <svg class="dz-guidance-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span class="dz-guidance-item-title">Desktop App Guide</span>
          </div>
          <span class="dz-guidance-item-desc">For images that exceed browser memory limits, within an 8 GiB canvas cap (needing matching free memory). Processes natively on your computer.</span>
        </button>
        <a class="dz-guidance-item" href="./help/finding-the-image-address.html" target="_blank" rel="noopener">
          <div class="dz-guidance-item-header">
            <svg class="dz-guidance-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span class="dz-guidance-item-title">Help &amp; URL Extraction</span>
          </div>
          <span class="dz-guidance-item-desc">How to find the image address on museum &amp; archive sites, and what to try when nothing is found.</span>
        </a>
      </div>
    </div>

    <details class="dz-details">
      <summary class="dz-summary">
        <span>Technical error details &amp; bug report</span>
        <svg class="dz-summary-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="dz-diagnostics" id="dz-error-diagnostics"></div>
      <div class="dz-diagnostics-report">
        <a href="https://github.com/lovasoa/dezoomify/issues/new?template=1_bug_report.md" target="_blank" rel="noopener">Report a bug on GitHub</a>
      </div>
    </details>

    <div class="dz-actions-row">
      <button type="button" class="dz-btn-tactile" id="dz-btn-try-again" style="min-width: 140px;">Try again</button>
      <button type="button" class="dz-btn-secondary" id="dz-btn-start-over">Start over</button>
    </div>
  `;
  // Diagnostics and user message are set as text content (never innerHTML):
  // engine messages must never be interpreted as markup.
  section.querySelector<HTMLElement>("#dz-error-message")!.textContent = error.message;
  section.querySelector<HTMLElement>("#dz-error-diagnostics")!.textContent =
    errorDiagnosticsText(error);

  const hostDoc = parent.ownerDocument;
  section.querySelector("#dz-card-extension")?.addEventListener("click", () => showExtensionGuidance(hostDoc));
  section.querySelector("#dz-card-desktop")?.addEventListener("click", () => showDesktopAppGuidance(hostDoc));
  section.querySelector("#dz-btn-try-again")?.addEventListener("click", () => (callbacks.onRetrySameUrl ?? callbacks.onReset)());
  section.querySelector("#dz-btn-start-over")?.addEventListener("click", () => callbacks.onReset());

  parent.appendChild(section);
}

function updateFailedSection(
  card: HTMLElement,
  state: ControllerState,
  _callbacks: ViewCallbacks,
  _ctx?: ViewContext,
): void {
  const sec = card.querySelector<HTMLElement>(".dz-error-section");
  if (!sec) return;
  const error: StructuredError = state.error ?? {
    code: "UNKNOWN",
    category: "unknown",
    retryable: true,
    message: "Dezoomify could not find or save the zoomable image at this address.",
  };
  const msgEl = sec.querySelector<HTMLElement>("#dz-error-message");
  if (msgEl && msgEl.textContent !== error.message) {
    msgEl.textContent = error.message;
  }
  const diagEl = sec.querySelector<HTMLElement>("#dz-error-diagnostics");
  if (diagEl) {
    const text = errorDiagnosticsText(error);
    if (diagEl.textContent !== text) {
      diagEl.textContent = text;
    }
  }
}

function mountCancelledSection(
  parent: HTMLElement,
  _state: ControllerState,
  callbacks: ViewCallbacks,
  _ctx?: ViewContext,
): void {
  const section = parent.ownerDocument.createElement("div");
  section.className = "dz-view-body dz-notice-section dz-fade-in";
  section.innerHTML = `
    <h2 class="dz-notice-title" style="color: var(--dz-text-primary);">Save cancelled</h2>
    <p class="dz-notice-message">The image save was stopped.</p>
    <div class="dz-actions-row">
      <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Start over</button>
    </div>
  `;
  section.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(section);
}

function mountGenericState(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  _ctx?: ViewContext,
): void {
  const div = parent.ownerDocument.createElement("div");
  div.className = "dz-view-body dz-fade-in";
  div.style.padding = "1rem 0";
  div.innerHTML = `
    <p style="color: var(--dz-text-secondary)">Status: <strong>${state.status}</strong></p>
    <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Reset</button>
  `;
  div.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(div);
}
