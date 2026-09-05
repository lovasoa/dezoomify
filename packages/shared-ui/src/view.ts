// Modern accessible Shared UI view renderer.
// Binds host-neutral DOM components to the shared controller and app integration.

import type { ControllerState, StructuredError, AppCapabilities } from "./controller.ts";
import { renderAppChoice } from "./controller.ts";
import {
  renderTransportLabel,
  renderSaveGuidance,
  renderProgress,
  renderCompletion,
  getDezoomifyLogoSvg,
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

export const ALL_DEZOOMERS = [
  { id: "auto", name: "Select automatically", description: "Select automatically based on URL and page contents" },
  { id: "zoomify", name: "Zoomify", description: "Zoomify tiles" },
  { id: "seadragon", name: "Seadragon (Deep Zoom Image)", description: "Deep Zoom Image (.dzi)" },
  { id: "iipimage", name: "IIPImage", description: "IIPImage protocol" },
  { id: "xlimage", name: "XLimage", description: "XLimage protocol" },
  { id: "topviewer", name: "TopViewer", description: "TopViewer JSON" },
  { id: "krpano", name: "krpano", description: "krpano panorama and high-resolution viewers" },
  { id: "iiif", name: "IIIF", description: "International Image Interoperability Framework" },
  { id: "fsi", name: "FSI", description: "FSI Viewer" },
  { id: "lizardtech", name: "LizardTech ImageServer", description: "LizardTech ImageServer" },
  { id: "vls", name: "VLS", description: "Virtual Light Stage viewer" },
  { id: "generic", name: "Generic dezoomer", description: "Custom URL tile template" },
  { id: "arts-culture", name: "Arts & Culture", description: "Google Arts & Culture" },
  { id: "hungaricana", name: "Hungaricana", description: "Hungaricana digital library" },
  { id: "arcgis", name: "ArcGIS MapServer", description: "ArcGIS MapServer tiles" },
  { id: "wmts", name: "WMTS", description: "Web Map Tile Service" },
  { id: "pnav", name: "pnav", description: "pnav image viewer" },
];

export function openModal(title: string, subtitle: string, contentHtml: string): void {
  if (typeof document === "undefined") return;
  document.querySelector(".dz-modal-backdrop")?.remove();

  const backdrop = document.createElement("div");
  backdrop.className = "dz-modal-backdrop";
  backdrop.setAttribute("role", "dialog");
  backdrop.setAttribute("aria-modal", "true");
  backdrop.setAttribute("aria-labelledby", "dz-modal-title");

  const card = document.createElement("div");
  card.className = "dz-modal-card";
  card.innerHTML = `
    <button type="button" class="dz-modal-close" aria-label="Close dialog" title="Close">&times;</button>
    <h2 id="dz-modal-title" class="dz-modal-title">${title}</h2>
    <p class="dz-modal-subtitle">${subtitle}</p>
    <div class="dz-modal-body">${contentHtml}</div>
    <div class="dz-modal-actions">
      <button type="button" class="dz-btn-tactile dz-modal-ok" style="min-width: 100px;">Got it</button>
    </div>
  `;

  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKeyDown);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };

  card.querySelector(".dz-modal-close")?.addEventListener("click", close);
  card.querySelector(".dz-modal-ok")?.addEventListener("click", close);
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) close();
  });
  document.addEventListener("keydown", onKeyDown);

  backdrop.appendChild(card);
  document.body.appendChild(backdrop);
}

function detectPlatform(): { name: string; file: string; label: string } {
  if (typeof navigator === "undefined") {
    return { name: "All Platforms", file: "latest releases", label: "Download Native App" };
  }
  const ua = (navigator.userAgent || "").toLowerCase();
  const platform = (navigator.platform || "").toLowerCase();
  if (ua.includes("win") || platform.includes("win")) {
    return { name: "Windows", file: ".msi / .exe", label: "Download for Windows" };
  }
  if (ua.includes("mac") || platform.includes("mac")) {
    return { name: "macOS", file: ".dmg", label: "Download for macOS" };
  }
  if (ua.includes("linux") || platform.includes("linux")) {
    return { name: "Linux", file: ".AppImage / .deb", label: "Download for Linux" };
  }
  return { name: "All Platforms", file: "latest releases", label: "Download Native App" };
}

export function showDesktopAppGuidance(): void {
  const p = detectPlatform();
  openModal(
    "Dezoomify Desktop App",
    "High-performance native application for gigapixel museum artworks and local scans",
    `
      <div class="dz-modal-download-box">
        <a class="dz-btn-download-primary" href="https://github.com/lovasoa/dezoomify/releases/latest" target="_blank" rel="noopener">
          <span>${p.label}</span>
          <span style="font-size: 0.82rem; font-weight: 400; opacity: 0.85;">(${p.file} from GitHub Releases)</span>
        </a>
        <div style="margin-top: 0.65rem; font-size: 0.85rem; color: var(--dz-text-muted);">
          Also available for Windows, macOS, and Linux on
          <a href="https://github.com/lovasoa/dezoomify/releases" target="_blank" rel="noopener">GitHub Releases &rarr;</a>
        </div>
      </div>

      <div class="dz-modal-section">
        <div class="dz-modal-section-title">Why use the Desktop App?</div>
        <ul class="dz-modal-list">
          <li><strong>Handles Gigapixel Artworks:</strong> Web browsers enforce strict memory limits (often 2 GB per tab). The Desktop App runs natively on your machine to assemble arbitrarily large gigapixel images with zero memory ceilings.</li>
          <li><strong>Lossless &amp; High-Quality Exports:</strong> Direct export to uncompressed TIFF, high-quality PNG, or JPEG without browser blob allocation limits.</li>
          <li><strong>Multi-Threaded Performance:</strong> Downloads and composites tiles in parallel using native multi-core CPU scheduling.</li>
        </ul>
      </div>

      <div class="dz-modal-section">
        <div class="dz-modal-section-title">How to use it</div>
        <div class="dz-modal-steps">
          <div class="dz-modal-step">
            <span class="dz-modal-step-num">1</span>
            <div>Download the native installer for ${p.name} from our GitHub Releases page.</div>
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
          <strong>Need automation or batch processing? Try the Dezoomify CLI</strong>
        </div>
        <p class="dz-modal-cli-desc">
          The CLI provides headless, scriptable downloading ideal for automated pipelines, server environments, or batch downloading hundreds of artworks from lists without a GUI.
        </p>
        <div class="dz-modal-cli-links">
          <a href="https://github.com/lovasoa/dezoomify/releases/latest" target="_blank" rel="noopener" class="dz-btn-secondary" style="height: 32px; font-size: 0.85rem;">
            Download CLI from GitHub Releases
          </a>
          <code style="font-family: var(--dz-font-mono); font-size: 0.82rem; padding: 0.35rem 0.6rem; background: rgba(0,0,0,0.04); border-radius: 4px; border: 1px solid var(--dz-surface-border);">
            cargo install dezoomify-cli
          </code>
        </div>
      </div>
    `
  );
}

export function showExtensionGuidance(): void {
  openModal(
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
        <a href="https://addons.mozilla.org/en-US/firefox/addon/dezoomify/" target="_blank" rel="noopener" class="dz-btn-store">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M12 2a10 10 0 0 1 10 10c0 5.52-4.48 10-10 10S2 17.52 2 12c0-2.5 1-4.8 2.6-6.5C7.2 9 8 13 12 14c0-2 1-3.5 2.5-4.5C13 8 11.5 6 12 2z"></path>
          </svg>
          <div>
            <div style="font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.04em; opacity: 0.8;">Get for</div>
            <div style="font-weight: 700; font-size: 0.98rem;">Firefox Add-ons</div>
          </div>
        </a>
      </div>

      <div class="dz-modal-section">
        <div class="dz-modal-section-title">Why use the Browser Extension?</div>
        <ul class="dz-modal-list">
          <li><strong>Password-Protected &amp; Academic Archives:</strong> Many university collections, museum subscriptions, and archive portals require you to be signed in. Web Dezoomify cannot access your cookies or session, but the extension inspects viewers directly within your active browser tab.</li>
          <li><strong>Automatic Viewer Detection:</strong> No need to inspect HTML source or search for hidden XML manifests. The extension observes viewer requests in real time as you navigate the page.</li>
          <li><strong>Private &amp; Secure:</strong> Operates locally inside your browser with granted active-tab permissions only; no credentials or session tokens ever leave your computer.</li>
        </ul>
      </div>

      <div class="dz-modal-section">
        <div class="dz-modal-section-title">How to use it in 3 steps</div>
        <div class="dz-modal-steps">
          <div class="dz-modal-step">
            <span class="dz-modal-step-num">1</span>
            <div>Install the extension from the Chrome Web Store or Firefox Add-ons.</div>
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

export function renderView(
  container: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  container.innerHTML = "";

  // Main status card
  const card = document.createElement("div");
  card.className = "dz-card";
  container.appendChild(card);

  // Header with authentic title & icon
  const header = document.createElement("div");
  header.className = "dz-header";
  header.innerHTML = `
    <h1 class="dz-title">
      <span>Dezoomify</span>
      ${getDezoomifyLogoSvg(28)}
    </h1>
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
}

function renderInputSection(
  parent: HTMLElement,
  state: ControllerState,
  callbacks: ViewCallbacks,
  ctx?: ViewContext,
): void {
  const isBusy = state.status === "discovering";

  // Description
  const desc = document.createElement("div");
  desc.className = "dz-description";
  desc.innerHTML = `
    <p>
      <strong>Dezoomify</strong> allows you to download
      <abbr title="Large images in which you can navigate inside a webpage.">zoomable images</abbr>.
      Enter the <abbr title="Uniform Resource Locator, the address of a webpage">URL</abbr>
      of such an image in the text field below. The image will be downloaded at maximal resolution.
      You can then right-click on the image, and choose "Save As" in order to save it as a PNG file on your computer.
      If it doesn't work, read our <a href="https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ" target="_blank" rel="noopener">FAQ</a>.
      If you want more information, read our <a href="https://github.com/lovasoa/dezoomify#dezoomify" target="_blank" rel="noopener">project page</a>.
    </p>
    <p class="dz-license-text">
      This script is released under the <a href="http://www.gnu.org/licenses/gpl.html" target="_blank" rel="noopener">GPL</a>.
      <a href="http://github.com/lovasoa/dezoomify" target="_blank" rel="noopener">See the source code</a>.
      <a href="https://github.com/lovasoa/dezoomify/wiki/Legal-concerns" target="_blank" rel="noopener">We decline any responsibility for an illegal use of this software</a>.
    </p>
  `;
  parent.appendChild(desc);

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

  // Full-width URL input row
  const wrapper = document.createElement("div");
  wrapper.className = "dz-input-wrapper";
  wrapper.innerHTML = `
    <input
      type="url"
      id="dz-url-input"
      class="dz-input"
      placeholder="URL of the webpage containing your image"
      required
      ${isBusy ? "disabled" : "autofocus"}
      aria-label="URL of the webpage containing your zoomable image"
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
  form.appendChild(wrapper);

  // Progressive Disclosure: Collapsible Format Selector
  const dezoomers = ctx?.supportedDezoomers ?? ALL_DEZOOMERS;
  const details = document.createElement("details");
  details.className = "dz-format-details";
  details.innerHTML = `
    <summary class="dz-format-summary">
      <div class="dz-format-summary-indicator">
        <span class="dz-format-badge"></span>
        <span id="dz-selected-format-label">Format: <strong>Select automatically</strong> (click to change)</span>
      </div>
      <svg class="dz-format-summary-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </summary>
    <div class="dz-format-content">
      <div class="dz-format-grid" id="dz-format-list"></div>
    </div>
  `;

  const formatList = details.querySelector("#dz-format-list");
  const summaryLabel = details.querySelector("#dz-selected-format-label");
  if (formatList) {
    dezoomers.forEach((fmt, idx) => {
      const label = document.createElement("label");
      label.className = `dz-format-option ${idx === 0 ? "active" : ""}`;
      label.title = fmt.description ?? fmt.name;
      label.innerHTML = `
        <input type="radio" name="dz-format" value="${fmt.id}" ${idx === 0 ? "checked" : ""} />
        <span>${fmt.name}</span>
      `;
      label.querySelector("input")?.addEventListener("change", () => {
        formatList.querySelectorAll(".dz-format-option").forEach((el) => el.classList.remove("active"));
        label.classList.add("active");
        if (summaryLabel) {
          summaryLabel.innerHTML = `Format: <strong>${fmt.name}</strong> (click to change)`;
        }
      });
      formatList.appendChild(label);
    });
  }
  form.appendChild(details);

  // Centered Tactile "Dezoomify !" Button
  const btnRow = document.createElement("div");
  btnRow.className = "dz-button-row";

  const submitBtn = document.createElement("button");
  submitBtn.type = "submit";
  submitBtn.className = "dz-btn-tactile";
  submitBtn.disabled = isBusy;
  submitBtn.innerHTML = isBusy
    ? `<span>Finding image...</span>`
    : `<span>Dezoomify !</span>`;
  btnRow.appendChild(submitBtn);
  form.appendChild(btnRow);

  // If discovering, show active indicator
  if (isBusy) {
    const searching = document.createElement("div");
    searching.className = "dz-progress-section";
    searching.innerHTML = `
      <div class="dz-progress-header">
        <span class="dz-progress-status">Analyzing page and finding image levels...</span>
        ${state.transport ? `<span class="dz-transport-badge">${renderTransportLabel(state.transport)}</span>` : ""}
      </div>
      <div class="dz-progress-controls">
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
    <div class="dz-progress-controls">
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
  const section = document.createElement("div");
  section.className = "dz-notice-section";
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
    const guidanceBox = document.createElement("p");
    guidanceBox.className = "dz-notice-guidance";
    guidanceBox.textContent = appChoice;
    section.appendChild(guidanceBox);
  }

  const actions = document.createElement("div");
  actions.className = "dz-actions-row";
  actions.innerHTML = `
    <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Start over</button>
  `;
  actions.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  section.appendChild(actions);

  parent.appendChild(section);
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

  const section = document.createElement("div");
  section.className = "dz-completed-section";
  section.innerHTML = `
    <div class="dz-completed-header">
      <svg class="dz-completed-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
        <polyline points="22 4 12 14.01 9 11.01"></polyline>
      </svg>
      <div>
        <h2 class="dz-completed-title">Download complete!</h2>
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
      <button type="button" class="dz-btn-secondary" id="dz-btn-another">Dezoomify another image</button>
    </div>
  `;

  section.querySelector("#dz-btn-save")?.addEventListener("click", () => callbacks.onSave());
  section.querySelector("#dz-btn-another")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(section);
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

  const section = document.createElement("div");
  section.className = "dz-error-section";
  section.innerHTML = `
    <div class="dz-error-header">
      <svg class="dz-error-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <div>
        <h2 class="dz-error-title">Could not dezoomify image</h2>
        <p class="dz-error-message">${error.message}</p>
      </div>
    </div>

    <div class="dz-guidance-section">
      <h3 class="dz-guidance-title">Ways to download this artwork</h3>
      <div class="dz-guidance-grid">
        <button type="button" class="dz-guidance-item" id="dz-card-extension">
          <div class="dz-guidance-item-header">
            <svg class="dz-guidance-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
            <span class="dz-guidance-item-title">Browser Extension Guide &rarr;</span>
          </div>
          <span class="dz-guidance-item-desc">For pages requiring login or session cookies. Automatically detects viewers on active pages.</span>
        </button>
        <button type="button" class="dz-guidance-item" id="dz-card-desktop">
          <div class="dz-guidance-item-header">
            <svg class="dz-guidance-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
            <span class="dz-guidance-item-title">Desktop App Guide &rarr;</span>
          </div>
          <span class="dz-guidance-item-desc">For gigapixel images that exceed browser memory limits. Processes natively on your computer.</span>
        </button>
        <a class="dz-guidance-item" href="https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ" target="_blank" rel="noopener">
          <div class="dz-guidance-item-header">
            <svg class="dz-guidance-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span class="dz-guidance-item-title">FAQ &amp; URL Extraction &rarr;</span>
          </div>
          <span class="dz-guidance-item-desc">How to extract zoomifyImagePath or direct viewer URLs from museum &amp; archive sites.</span>
        </a>
      </div>
    </div>

    <details class="dz-details">
      <summary class="dz-summary">
        <span>Technical error details &amp; bug report</span>
        <svg class="dz-summary-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>
      </summary>
      <div class="dz-diagnostics">Code: ${error.code}\nCategory: ${error.category}\nRetryable: ${error.retryable}\nTransport: ${error.transport ?? "direct"}\nPhase: ${error.phase ?? "discovery"}\nMessage: ${error.message}</div>
      <div class="dz-diagnostics-report">
        <a href="https://github.com/lovasoa/dezoomify/issues/new?template=1_bug_report.md" target="_blank" rel="noopener">Report a bug on GitHub &rarr;</a>
      </div>
    </details>

    <div class="dz-actions-row">
      <button type="button" class="dz-btn-tactile" id="dz-btn-try-again" style="min-width: 140px;">Try again</button>
    </div>
  `;

  section.querySelector("#dz-card-extension")?.addEventListener("click", () => showExtensionGuidance());
  section.querySelector("#dz-card-desktop")?.addEventListener("click", () => showDesktopAppGuidance());
  section.querySelector("#dz-btn-try-again")?.addEventListener("click", () => callbacks.onReset());

  parent.appendChild(section);
}

function renderCancelledSection(
  parent: HTMLElement,
  _state: ControllerState,
  callbacks: ViewCallbacks,
  _ctx?: ViewContext,
): void {
  const section = document.createElement("div");
  section.className = "dz-notice-section";
  section.innerHTML = `
    <h2 class="dz-notice-title" style="color: var(--dz-text-primary);">Download cancelled</h2>
    <p class="dz-notice-message">The image download was stopped.</p>
    <div class="dz-actions-row">
      <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Start over</button>
    </div>
  `;
  section.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(section);
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
    <p style="color: var(--dz-text-secondary)">Status: <strong>${state.status}</strong></p>
    <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Reset</button>
  `;
  div.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(div);
}
