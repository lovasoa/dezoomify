// Modern accessible Shared UI view renderer (Vanilla JS for browser & tests).
import { renderAppChoice } from "./controller.js";
import {
  renderTransportLabel,
  renderSaveGuidance,
  renderProgress,
  renderCompletion,
  getDezoomifyLogoSvg,
} from "./components.js";

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

export function renderView(container, state, callbacks, ctx = {}) {
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

function renderInputSection(parent, state, callbacks, ctx) {
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
    const input = form.querySelector("#dz-url-input");
    const selectedFormat = form.querySelector("input[name='dz-format']:checked");
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

  const inputEl = wrapper.querySelector("#dz-url-input");
  const clearBtn = wrapper.querySelector("#dz-btn-clear");
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

function renderProgressSection(parent, state, callbacks, ctx) {
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

function renderDisplayOnlySection(parent, _state, callbacks, ctx) {
  const guidance = renderSaveGuidance(false);
  const div = document.createElement("div");
  div.className = "dz-alert-error";
  div.style.borderColor = "#f59e0b";
  div.style.background = "linear-gradient(180deg, #fffbeb 0%, #fef3c7 100%)";
  div.innerHTML = `
    <div class="dz-alert-header">
      <svg class="dz-alert-icon" style="color: #d97706" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
      <div>
        <h3 class="dz-alert-title" style="color: #b45309">Display Only Preview</h3>
        <p class="dz-alert-message" style="color: #78350f">${guidance}</p>
      </div>
    </div>
  `;

  if (ctx?.capabilities) {
    const appChoice = renderAppChoice(ctx.capabilities);
    const guidanceBox = document.createElement("div");
    guidanceBox.style.fontSize = "0.92rem";
    guidanceBox.style.padding = "0.85rem 1.15rem";
    guidanceBox.style.background = "#ffffff";
    guidanceBox.style.borderRadius = "var(--dz-radius)";
    guidanceBox.style.border = "1px solid #fcd34d";
    guidanceBox.style.whiteSpace = "pre-line";
    guidanceBox.style.lineHeight = "1.65";
    guidanceBox.style.color = "#78350f";
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

function renderCompletedSection(parent, _state, callbacks, ctx) {
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
    <p style="margin: 0; font-size: 0.95rem; color: var(--dz-text-secondary)">${guidance}</p>
    <div class="dz-completion-actions">
      ${isClean ? `<button type="button" class="dz-btn-tactile" id="dz-btn-save" style="min-width: 180px;">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
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

function renderFailedSection(parent, state, callbacks, _ctx) {
  const error = state.error ?? {
    code: "UNKNOWN",
    category: "unknown",
    retryable: true,
    message: "Dezoomify could not find or download the zoomable image at this address.",
  };

  const alert = document.createElement("div");
  alert.className = "dz-alert-error";
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
        Browser Extension
      </span>
      <span class="dz-suggestion-desc">Finds zoomable images automatically inside webpages that need login or session cookies.</span>
    </a>
    <a class="dz-suggestion-card" href="https://dezoomify-rs.ophir.dev/" target="_blank" rel="noopener">
      <span class="dz-suggestion-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        Desktop App
      </span>
      <span class="dz-suggestion-desc">Handles gigapixel images that are too large for browser memory limits.</span>
    </a>
    <a class="dz-suggestion-card" href="https://github.com/lovasoa/dezoomify/wiki/Dezoomify-FAQ" target="_blank" rel="noopener">
      <span class="dz-suggestion-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        Frequently Asked Questions
      </span>
      <span class="dz-suggestion-desc">How to extract zoomifyImagePath or direct viewer URLs from museum & archive sites.</span>
    </a>
  `;
  alert.appendChild(suggestions);

  const details = document.createElement("details");
  details.className = "dz-details";
  details.innerHTML = `
    <summary class="dz-summary">
      <span>Technical error details & bug report</span>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
    </summary>
    <div class="dz-diagnostics">Code: ${error.code}\nCategory: ${error.category}\nRetryable: ${error.retryable}\nTransport: ${error.transport ?? "direct"}\nPhase: ${error.phase ?? "discovery"}\nMessage: ${error.message}</div>
    <div style="padding: 0.75rem 1rem; background: rgba(0,0,0,0.02); display: flex; gap: 0.5rem; font-size: 0.85rem">
      <a href="https://github.com/lovasoa/dezoomify/issues/new?template=1_bug_report.md" target="_blank" rel="noopener" style="font-weight: 600">Report a bug on GitHub &rarr;</a>
    </div>
  `;
  alert.appendChild(details);

  const actions = document.createElement("div");
  actions.style.display = "flex";
  actions.style.gap = "0.75rem";
  actions.style.marginTop = "0.5rem";
  actions.innerHTML = `
    <button type="button" class="dz-btn-tactile" id="dz-btn-try-again" style="min-width: 140px;">Try again</button>
  `;
  actions.querySelector("#dz-btn-try-again")?.addEventListener("click", () => callbacks.onReset());
  alert.appendChild(actions);

  parent.appendChild(alert);
}

function renderCancelledSection(parent, _state, callbacks, _ctx) {
  const div = document.createElement("div");
  div.className = "dz-alert-error";
  div.style.borderColor = "var(--dz-surface-border)";
  div.style.background = "var(--dz-surface-gradient)";
  div.innerHTML = `
    <h3 class="dz-alert-title" style="color: var(--dz-text-primary)">Download cancelled</h3>
    <p class="dz-alert-message">The image download was stopped.</p>
    <div style="margin-top: 0.5rem">
      <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Start over</button>
    </div>
  `;
  div.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(div);
}

function renderGenericState(parent, state, callbacks, _ctx) {
  const div = document.createElement("div");
  div.style.padding = "1rem 0";
  div.innerHTML = `
    <p style="color: var(--dz-text-secondary)">Status: <strong>${state.status}</strong></p>
    <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Reset</button>
  `;
  div.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(div);
}
