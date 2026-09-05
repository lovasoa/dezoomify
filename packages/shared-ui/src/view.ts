// Modern accessible Shared UI view renderer.
// Binds host-neutral DOM components to the shared controller and app integration.

import type { ControllerState, StructuredError, AppCapabilities } from "./controller.ts";
import { renderAppChoice } from "./controller.ts";
import {
  renderTransportLabel,
  renderSaveGuidance,
  renderProgress,
  renderCompletion,
} from "./components.ts";

export interface ViewCallbacks {
  onSubmitUrl(url: string, dezoomer?: string): void;
  onCancel(): void;
  onReset(): void;
  onSave(): void;
  onSelectImage?(index: number): void;
  onSelectLevel?(level: number): void;
  onOpenExternalLink?(url: string): void;
}

export interface ViewContext {
  capabilities?: AppCapabilities;
  supportedDezoomers?: { id: string; name: string; description?: string }[];
  currentProgress?: { current: number; total: number; message?: string };
  completedInfo?: { width: number; height: number; mime: string; blobUrl?: string };
  originClean?: boolean;
}

const DEFAULT_DEZOOMERS = [
  { id: "auto", name: "Select automatically", description: "Detects the viewer format automatically (recommended for 99% of sites)" },
  { id: "zoomify", name: "Zoomify", description: "Zoomify tiles (ImageProperties.xml)" },
  { id: "seadragon", name: "Deep Zoom / Seadragon", description: "Deep Zoom Image (.dzi)" },
  { id: "iiif", name: "IIIF", description: "International Image Interoperability Framework" },
  { id: "krpano", name: "krpano", description: "krpano panoramic and high-resolution viewers" },
  { id: "iipimage", name: "IIPImage", description: "IIPImage protocol (?FIF=...)" },
  { id: "topviewer", name: "TopViewer", description: "TopViewer JSON" },
  { id: "xlimage", name: "XLimage", description: "XLimage protocol" },
  { id: "fsi", name: "FSI Viewer", description: "FSI server" },
  { id: "lizardtech", name: "LizardTech", description: "LizardTech ImageServer" },
  { id: "vls", name: "VLS", description: "Virtual Light Stage viewer" },
  { id: "generic", name: "Generic / Custom template", description: "Custom URL tile template with {x}, {y}, {z}" },
];

export function renderView(
  container: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  container.innerHTML = "";

  // Main card
  const card = document.createElement("div");
  card.className = "dz-card";
  container.appendChild(card);

  // Header / Hero
  const header = document.createElement("div");
  header.className = "dz-header";
  header.innerHTML = `
    <h1 class="dz-title">Dezoomify</h1>
    <p class="dz-subtitle">Download high-resolution zoomable images with maximum quality</p>
  `;
  card.appendChild(header);

  // Body content based on state
  switch (state.status) {
    case "idle":
    case "discovering":
      renderInputSection(card, state, callbacks, ctx);
      break;

    case "downloading":
      renderProgressSection(card, state, callbacks, ctx);
      break;

    case "display-only":
      renderDisplayOnlySection(card, state, callbacks, ctx);
      break;

    case "completed":
      renderCompletedSection(card, state, callbacks, ctx);
      break;

    case "failed":
      renderFailedSection(card, state, callbacks, ctx);
      break;

    case "cancelled":
      renderCancelledSection(card, state, callbacks, ctx);
      break;

    default:
      renderGenericState(card, state, callbacks, ctx);
      break;
  }

  // Footer is rendered outside the card for clean separation
  renderFooter(container);
}

function renderInputSection(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const isBusy = state.status === "discovering";

  const form = document.createElement("form");
  form.className = "dz-form";
  form.onsubmit = (e) => {
    e.preventDefault();
    const input = form.querySelector<HTMLInputElement>("#dz-url-input");
    const selectedFormat = form.querySelector<HTMLInputElement>("input[name='dz-format']:checked");
    const url = input?.value.trim() ?? "";
    if (!url) {
      input?.focus();
      return;
    }
    callbacks.onSubmitUrl(url, selectedFormat?.value);
  };

  const inputGroup = document.createElement("div");
  inputGroup.className = "dz-input-group";

  const wrapper = document.createElement("div");
  wrapper.className = "dz-input-wrapper";
  wrapper.innerHTML = `
    <svg class="dz-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8"></circle>
      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
    </svg>
    <input
      type="url"
      id="dz-url-input"
      class="dz-input"
      placeholder="Paste image or webpage URL..."
      required
      ${isBusy ? "disabled" : "autofocus"}
      aria-label="Webpage URL containing zoomable image"
    />
    <button type="button" class="dz-input-clear" id="dz-btn-clear" title="Clear input" aria-label="Clear input">&times;</button>
  `;

  const inputEl = wrapper.querySelector<HTMLInputElement>("#dz-url-input");
  const clearBtn = wrapper.querySelector<HTMLButtonElement>("#dz-btn-clear");
  if (inputEl && clearBtn) {
    inputEl.addEventListener("input", () => {
      clearBtn.style.display = inputEl.value ? "flex" : "none";
    });
    clearBtn.addEventListener("click", () => {
      inputEl.value = "";
      clearBtn.style.display = "none";
      inputEl.focus();
    });
  }

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "dz-btn-primary";
  submitBtn.disabled = isBusy;
  submitBtn.innerHTML = isBusy
    ? `<span>Finding image...</span>`
    : `<span>Dezoomify</span>
       <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
         <polyline points="9 18 15 12 9 6"></polyline>
       </svg>`;

  inputGroup.appendChild(wrapper);
  inputGroup.appendChild(submitBtn);
  form.appendChild(inputGroup);

  // Progressive Disclosure: Collapsible Advanced Options
  const dezoomers = ctx?.supportedDezoomers ?? DEFAULT_DEZOOMERS;
  const details = document.createElement("details");
  details.className = "dz-details";
  details.innerHTML = `
    <summary class="dz-summary">
      <span>Format: Automatic (click to change)</span>
      <svg class="dz-summary-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </summary>
    <div class="dz-details-content">
      <p style="margin: 0 0 0.75rem; font-size: 0.85rem; color: var(--dz-color-text-secondary)">
        By default, Dezoomify identifies the image format automatically. Select a specific format if auto-detection fails:
      </p>
      <div class="dz-format-grid" id="dz-format-list"></div>
    </div>
  `;

  const formatList = details.querySelector("#dz-format-list");
  if (formatList) {
    dezoomers.forEach((fmt, idx) => {
      const opt = document.createElement("label");
      opt.className = `dz-format-option ${idx === 0 ? "active" : ""}`;
      opt.title = fmt.description ?? fmt.name;
      opt.innerHTML = `
        <input type="radio" name="dz-format" value="${fmt.id}" ${idx === 0 ? "checked" : ""} />
        <span>${fmt.name}</span>
      `;
      opt.querySelector("input")?.addEventListener("change", () => {
        formatList.querySelectorAll(".dz-format-option").forEach((el) => el.classList.remove("active"));
        opt.classList.add("active");
      });
      formatList.appendChild(opt);
    });
  }

  form.appendChild(details);

  if (isBusy) {
    const searching = document.createElement("div");
    searching.className = "dz-progress-section";
    searching.innerHTML = `
      <div class="dz-progress-header">
        <span class="dz-progress-status">Analyzing page and finding image levels...</span>
        ${state.transport ? `<span class="dz-transport-badge">${renderTransportLabel(state.transport)}</span>` : ""}
      </div>
      <div style="display: flex; justify-content: flex-end; margin-top: 0.5rem">
        <button type="button" class="dz-btn-secondary" id="dz-btn-cancel">Cancel</button>
      </div>
    `;
    searching.querySelector("#dz-btn-cancel")?.addEventListener("click", () => callbacks.onCancel());
    form.appendChild(searching);
  }

  parent.appendChild(form);
}

function renderProgressSection(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const current = ctx?.currentProgress?.current ?? 0;
  const total = ctx?.currentProgress?.total ?? 0;
  const pct = total > 0 ? Math.max(0, Math.min(100, Math.round((current / total) * 100))) : 0;
  const transport = state.transport ? renderTransportLabel(state.transport) : "Direct from your browser";

  const sec = document.createElement("div");
  sec.className = "dz-progress-section";
  sec.innerHTML = `
    <div class="dz-progress-header">
      <span class="dz-progress-status">${ctx?.currentProgress?.message ?? renderProgress(current, total)}</span>
      <span class="dz-progress-percent">${pct}%</span>
    </div>
    <div class="dz-progress-track" role="progressbar" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
      <div class="dz-progress-bar" style="width: ${pct}%"></div>
    </div>
    <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 0.5rem">
      <span class="dz-transport-badge">${transport}</span>
      <button type="button" class="dz-btn-secondary" id="dz-btn-cancel">Cancel download</button>
    </div>
  `;

  sec.querySelector("#dz-btn-cancel")?.addEventListener("click", () => callbacks.onCancel());
  parent.appendChild(sec);
}

function renderDisplayOnlySection(
  parent: HTMLElement,
  _state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const guidance = renderSaveGuidance(false);
  const div = document.createElement("div");
  div.className = "dz-alert";
  div.style.borderColor = "var(--dz-color-warning-border)";
  div.style.background = "var(--dz-color-warning-bg)";
  div.innerHTML = `
    <div class="dz-alert-header">
      <svg class="dz-alert-icon" style="color: var(--dz-color-warning)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <div>
        <h3 class="dz-alert-title" style="color: var(--dz-color-warning)">Display Only Preview</h3>
        <p class="dz-alert-message">${guidance}</p>
      </div>
    </div>
  `;

  if (ctx?.capabilities) {
    const appChoice = renderAppChoice(ctx.capabilities);
    const guidanceBox = document.createElement("div");
    guidanceBox.style.fontSize = "0.9rem";
    guidanceBox.style.padding = "0.75rem 1rem";
    guidanceBox.style.background = "var(--dz-color-surface)";
    guidanceBox.style.borderRadius = "var(--dz-radius-sm)";
    guidanceBox.style.border = "1px solid var(--dz-color-border)";
    guidanceBox.style.whiteSpace = "pre-line";
    guidanceBox.style.lineHeight = "1.6";
    guidanceBox.textContent = appChoice;
    div.appendChild(guidanceBox);
  }

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "0.75rem";
  actions.style.marginTop = "0.5rem";
  actions.innerHTML = `
    <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Start over</button>
  `;
  actions.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  div.appendChild(actions);

  parent.appendChild(div);
}

function renderCompletedSection(
  parent: HTMLElement,
  _state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const info = ctx?.completedInfo;
  const isClean = ctx?.originClean ?? true;
  const summary = info ? renderCompletion(info.width, info.height, info.mime) : "Your image is ready.";
  const guidance = renderSaveGuidance(isClean);

  const comp = document.createElement("div");
  comp.className = "dz-completion";
  comp.innerHTML = `
    <div class="dz-completion-header">
      <svg class="dz-completion-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <div>
        <h2 class="dz-completion-title">Download complete!</h2>
        <p class="dz-completion-info">${summary}</p>
      </div>
    </div>
    <p style="margin: 0; font-size: 0.9rem; color: var(--dz-color-text-secondary)">${guidance}</p>
    <div class="dz-completion-actions">
      ${isClean ? `<button type="button" class="dz-btn-primary" id="dz-btn-save">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
          <polyline points="7 10 12 15 17 10"></polyline>
          <line x1="12" y1="15" x2="12" y2="3"></line>
        </svg>
        Save image
      </button>` : ""}
      <button type="button" class="dz-btn-secondary" id="dz-btn-another">Dezoomify another image</button>
    </div>
  `;

  comp.querySelector("#dz-btn-save")?.addEventListener("click", () => callbacks.onSave());
  comp.querySelector("#dz-btn-another")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(comp);
}

function renderFailedSection(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  _ctx?: ViewContext,
): void {
  const error: StructuredError = state.error ?? {
    code: "UNKNOWN",
    category: "unknown",
    retryable: true,
    message: "Dezoomify could not find or download the zoomable image at this address.",
  };

  const alert = document.createElement("div");
  alert.className = "dz-alert";
  alert.innerHTML = `
    <div class="dz-alert-header">
      <svg class="dz-alert-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <div>
        <h3 class="dz-alert-title">Could not dezoomify image</h3>
        <p class="dz-alert-message">${error.message}</p>
      </div>
    </div>
  `;

  const suggestions = document.createElement("div");
  suggestions.className = "dz-suggestion-grid";
  suggestions.innerHTML = `
    <a class="dz-suggestion-card" href="https://lovasoa.github.io/dezoomify-extension/" target="_blank" rel="noopener">
      <span class="dz-suggestion-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
        Try Browser Extension
      </span>
      <span class="dz-suggestion-desc">Finds zoomable images automatically inside webpages that need login or session cookies.</span>
    </a>
    <a class="dz-suggestion-card" href="https://dezoomify-rs.ophir.dev/" target="_blank" rel="noopener">
      <span class="dz-suggestion-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Try Desktop App
      </span>
      <span class="dz-suggestion-desc">Handles gigapixel images that are too large for browsers to process in memory.</span>
    </a>
    <a class="dz-suggestion-card" href="https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ" target="_blank" rel="noopener">
      <span class="dz-suggestion-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Frequently Asked Questions
      </span>
      <span class="dz-suggestion-desc">Learn how to extract direct viewer URLs from unsupported museum or archive sites.</span>
    </a>
  `;
  alert.appendChild(suggestions);

  const details = document.createElement("details");
  details.className = "dz-details";
  details.innerHTML = `
    <summary class="dz-summary">
      <span>Technical error details & bug report</span>
      <svg class="dz-summary-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </summary>
    <div class="dz-details-content">
      <div class="dz-diagnostics">Code: ${error.code}\nCategory: ${error.category}\nRetryable: ${error.retryable}\nTransport: ${error.transport ?? "direct"}\nPhase: ${error.phase ?? "discovery"}\nMessage: ${error.message}</div>
      <div style="margin-top: 0.75rem; display: flex; gap: 0.5rem; font-size: 0.85rem">
        <a href="https://github.com/lovasoa/dezoomify/issues/new?template=1_bug_report.md" target="_blank" rel="noopener" style="color: var(--dz-color-primary); font-weight: 500">Report a bug on GitHub &rarr;</a>
      </div>
    </div>
  `;
  alert.appendChild(details);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "0.75rem";
  actions.style.marginTop = "0.5rem";
  actions.innerHTML = `
    <button type="button" class="dz-btn-primary" id="dz-btn-try-again">Try again</button>
  `;
  actions.querySelector("#dz-btn-try-again")?.addEventListener("click", () => callbacks.onReset());
  alert.appendChild(actions);

  parent.appendChild(alert);
}

function renderCancelledSection(
  parent: HTMLElement,
  _state: ControllerState,
  callbacks: ViewCallbacks,
  _ctx?: ViewContext,
): void {
  const div = document.createElement("div");
  div.className = "dz-alert";
  div.style.borderColor = "var(--dz-color-border)";
  div.style.background = "var(--dz-color-bg)";
  div.innerHTML = `
    <h3 class="dz-alert-title" style="color: var(--dz-color-text-primary)">Download cancelled</h3>
    <p class="dz-alert-message">The image download was stopped.</p>
    <div style="margin-top: 0.5rem">
      <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Start over</button>
    </div>
  `;
  div.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(div);
}

function renderGenericState(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  _ctx?: ViewContext,
): void {
  const div = document.createElement("div");
  div.style.padding = "1rem 0";
  div.innerHTML = `
    <p style="color: var(--dz-color-text-secondary)">Status: <strong>${state.status}</strong></p>
    <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Reset</button>
  `;
  div.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(div);
}

function renderFooter(parent: HTMLElement): void {
  const footer = document.createElement("footer");
  footer.className = "dz-site-footer";
  footer.innerHTML = `
    <div class="dz-footer-links">
      <a href="https://github.com/lovasoa/dezoomify" target="_blank" rel="noopener">Open Source (GPL)</a>
      <a href="https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ" target="_blank" rel="noopener">FAQ & Help</a>
      <a href="https://lovasoa.github.io/dezoomify-extension/" target="_blank" rel="noopener">Browser Extension</a>
      <a href="https://dezoomify-rs.ophir.dev/" target="_blank" rel="noopener">Desktop App</a>
      <a href="https://github.com/sponsors/lovasoa/" target="_blank" rel="noopener">Support Hosting</a>
    </div>
    <div class="dz-footer-disclaimer">
      Dezoomify is a tool for accessing public zoomable images. Please respect copyright and licensing terms of source images.
    </div>
  `;
  parent.appendChild(footer);
}
