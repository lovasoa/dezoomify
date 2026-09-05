// GENERATED from packages/shared-ui/src/view.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/shared-ui/src/view.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Modern accessible Shared UI view renderer.
// Binds host-neutral DOM components to the shared controller and app integration.

import { renderAppChoice } from "./controller.js";
import {
  renderTransportLabel,
  renderSaveGuidance,
  renderProgress,
  renderCompletion,
  formatElapsed,
  formatRemaining,
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

export function openModal(title        , subtitle        , contentHtml        )       {
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

  const onKeyDown = (e               ) => {
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

function detectPlatform()                                                {
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

export function showDesktopAppGuidance()       {
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

export function showExtensionGuidance()       {
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

export function getPhaseForStatus(status                           )            {
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
  container             ,
  state                 ,
  callbacks               ,
  ctx              ,
)       {
  // Ensure the card container is stable across updates
  let card = container.querySelector             (".dz-card");
  if (!card) {
    container.innerHTML = "";
    card = document.createElement("div");
    card.className = "dz-card";
    container.appendChild(card);
  }

  // Header with authentic title & icon (mounted once)
  let header = card.querySelector             (".dz-header");
  if (!header) {
    header = document.createElement("div");
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

function escapeHtml(value        )         {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function truncateMiddle(value        , max = 90)         {
  const s = String(value ?? "");
  if (s.length <= max) return s;
  const half = Math.floor((max - 1) / 2);
  return `${s.slice(0, half)}…${s.slice(s.length - half)}`;
}

/** The website a request is waiting on, for plain-language messages. */
function hostFromUrl(url                    )         {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "the server";
  }
}

function updateInputSection(
  card             ,
  ctx              ,
)       {
  const input = card.querySelector                  ("#dz-url-input");
  if (input && !input.value && ctx?.initialUrl) {
    input.value = ctx.initialUrl;
    const clearBtn = card.querySelector                   ("#dz-btn-clear");
    if (clearBtn) clearBtn.style.display = "flex";
  }
}

function mountInputSection(
  parent             ,
  _state                 ,
  callbacks               ,
  ctx              ,
)       {
  const body = document.createElement("div");
  body.className = "dz-view-body dz-fade-in";

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
      If it doesn't work, read our <a href="https://dezoomify.ophir.dev/help/troubleshooting.html" target="_blank" rel="noopener">troubleshooting guide</a>.
      If you want more information, read our <a href="https://github.com/lovasoa/dezoomify#dezoomify" target="_blank" rel="noopener">project page</a>.
    </p>
    <p class="dz-license-text">
      This script is released under the <a href="http://www.gnu.org/licenses/gpl.html" target="_blank" rel="noopener">GPL</a>.
      <a href="http://github.com/lovasoa/dezoomify" target="_blank" rel="noopener">See the source code</a>.
      <a href="https://dezoomify.ophir.dev/terms.html" target="_blank" rel="noopener">We decline any responsibility for an illegal use of this software</a>.
    </p>
  `;
  body.appendChild(desc);

  const form = document.createElement("form");
  form.className = "dz-form";
  form.onsubmit = (e) => {
    e.preventDefault();
    const input = form.querySelector                  ("#dz-url-input");
    const selectedFormat = form.querySelector                  ("input[name='dz-format']:checked");
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

  const inputEl = wrapper.querySelector                  ("#dz-url-input");
  const clearBtn = wrapper.querySelector                   ("#dz-btn-clear");
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

  // Progressive Disclosure: Collapsible Format Selector
  const dezoomers = ctx?.supportedDezoomers ?? ALL_DEZOOMERS;
  const details = document.createElement("details");
  details.className = "dz-format-details";
  details.innerHTML = `
    <summary class="dz-format-summary">
      <div class="dz-format-summary-indicator">
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
  submitBtn.innerHTML = `<span>Dezoomify !</span>`;
  btnRow.appendChild(submitBtn);
  form.appendChild(btnRow);

  body.appendChild(form);
  parent.appendChild(body);
}

function defaultStepFor(status                           )         {
  switch (status) {
    case "discovering":
      return "Finding the zoomable image…";
    case "choosing-image":
      return "Image found — picking the best one…";
    case "choosing-level":
      return "Choosing the highest resolution…";
    case "preflighting":
      return "Checking the image size…";
    case "downloading":
      return "Downloading image tiles…";
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
  parent             ,
  state                 ,
  callbacks               ,
  ctx              ,
)       {
  const sec = document.createElement("div");
  sec.className = "dz-view-body dz-job-section dz-fade-in";
  sec.setAttribute("role", "status");
  sec.setAttribute("aria-live", "polite");

  // Keep latest callbacks accessible on the element without listener churn
  (sec                                            )._callbacks = callbacks;

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
    const cb = (sec                                            )._callbacks;
    cb?.onCancel();
  });
  sec.querySelector("#dz-btn-share")?.addEventListener("click", () => {
    const cb = (sec                                            )._callbacks;
    cb?.onCopyShareLink?.();
  });

  parent.appendChild(sec);
  updateJobSection(parent, state, callbacks, ctx);
}

/**
 * Perform targeted in-place DOM updates on the mounted job section.
 */
function updateJobSection(
  card             ,
  state                 ,
  callbacks               ,
  ctx              ,
)       {
  const sec = card.querySelector             (".dz-job-section");
  if (!sec) return;

  (sec                                            )._callbacks = callbacks;

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
  const sourceLine = sec.querySelector             ("#dz-job-source-line");
  const sourceUrlEl = sec.querySelector             ("#dz-job-source-url");
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
  const stepEl = sec.querySelector             ("#dz-job-step-text");
  if (stepEl && stepEl.textContent !== step) {
    stepEl.textContent = step;
  }

  const percentEl = sec.querySelector             ("#dz-job-percent");
  if (percentEl) {
    const percentText = determinate ? `${pct}%` : (elapsed || "");
    if (percentEl.textContent !== percentText) {
      percentEl.textContent = percentText;
    }
  }

  // 3. Track and Bar
  const track = sec.querySelector             ("#dz-job-track");
  const bar = sec.querySelector             ("#dz-job-bar");
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
  const countsEl = sec.querySelector             ("#dz-job-counts");
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

  // 5. Pending section
  const pendingBox = sec.querySelector             ("#dz-job-pending-box");
  const pendingStatus = sec.querySelector             ("#dz-job-pending-status");
  const pendingTime = sec.querySelector             ("#dz-job-pending-time");
  const remainingBar = sec.querySelector             ("#dz-job-remaining-bar");
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
  const reassureEl = sec.querySelector             ("#dz-job-reassure");
  if (reassureEl) {
    reassureEl.style.display = showStalled ? "" : "none";
    const reassureText = `Still working, ${hostFromUrl(activity.url)} is slow to answer. You can wait, or cancel and try again later.`;
    if (reassureEl.textContent !== reassureText) {
      reassureEl.textContent = reassureText;
    }
  }

  // 7. Detail
  const detailEl = sec.querySelector             ("#dz-job-detail");
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
  const transportEl = sec.querySelector             ("#dz-job-transport");
  if (transportEl && transportEl.textContent !== transport) {
    transportEl.textContent = transport;
  }

  const shareBtn = sec.querySelector             ("#dz-btn-share");
  if (shareBtn) {
    shareBtn.style.display = callbacks.onCopyShareLink ? "" : "none";
  }

  // 9. Diagnostics & Logs (preserved in-place, keeping details open state intact)
  const diagEl = sec.querySelector             ("#dz-job-diagnostics");
  if (diagEl) {
    const diagText = diagnosticsText(state, ctx, elapsedMs, timeoutMs);
    if (diagEl.textContent !== diagText) {
      diagEl.textContent = diagText;
    }
  }

  const logEl = sec.querySelector             ("#dz-job-log");
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
  state                 ,
  ctx              ,
  elapsedMs         ,
  timeoutMs         ,
)         {
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
  parent             ,
  state                 ,
  callbacks               ,
  ctx              ,
)       {
  const sec = parent.querySelector(".dz-job-section");
  if (!sec) {
    mountJobSection(parent, state, callbacks, ctx);
  } else {
    updateJobSection(parent, state, callbacks, ctx);
  }
}

function mountDisplayOnlySection(
  parent             ,
  _state                 ,
  callbacks               ,
  ctx              ,
)       {
  const guidance = renderSaveGuidance(false);
  const section = document.createElement("div");
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

function mountCompletedSection(
  parent             ,
  _state                 ,
  callbacks               ,
  ctx              ,
)       {
  const info = ctx?.completedInfo;
  const isClean = ctx?.originClean ?? true;
  const summary = info ? renderCompletion(info.width, info.height, info.mime) : "Your image is ready.";
  const guidance = renderSaveGuidance(isClean);

  const section = document.createElement("div");
  section.className = "dz-view-body dz-completed-section dz-fade-in";
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
      ${callbacks.onCopyShareLink ? `<button type="button" class="dz-btn-secondary" id="dz-btn-share">Copy shareable link</button>` : ""}
      <button type="button" class="dz-btn-secondary" id="dz-btn-another">Dezoomify another image</button>
    </div>
  `;

  section.querySelector("#dz-btn-save")?.addEventListener("click", () => callbacks.onSave());
  section.querySelector("#dz-btn-share")?.addEventListener("click", () => callbacks.onCopyShareLink?.());
  section.querySelector("#dz-btn-another")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(section);
}

function mountFailedSection(
  parent             ,
  state                 ,
  callbacks               ,
  _ctx              ,
)       {
  const error                  = state.error ?? {
    code: "UNKNOWN",
    category: "unknown",
    retryable: true,
    message: "Dezoomify could not find or download the zoomable image at this address.",
  };

  const section = document.createElement("div");
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
        <p class="dz-error-message" id="dz-error-message">${error.message}</p>
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
        <a class="dz-guidance-item" href="https://dezoomify.ophir.dev/help/finding-the-image-address.html" target="_blank" rel="noopener">
          <div class="dz-guidance-item-header">
            <svg class="dz-guidance-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <span class="dz-guidance-item-title">Help &amp; URL Extraction &rarr;</span>
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
      <div class="dz-diagnostics" id="dz-error-diagnostics">Code: ${error.code}\nCategory: ${error.category}\nRetryable: ${error.retryable}\nTransport: ${error.transport ?? "direct"}\nPhase: ${error.phase ?? "discovery"}\nMessage: ${error.message}</div>
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

function updateFailedSection(
  card             ,
  state                 ,
  _callbacks               ,
  _ctx              ,
)       {
  const sec = card.querySelector             (".dz-error-section");
  if (!sec) return;
  const error                  = state.error ?? {
    code: "UNKNOWN",
    category: "unknown",
    retryable: true,
    message: "Dezoomify could not find or download the zoomable image at this address.",
  };
  const msgEl = sec.querySelector             ("#dz-error-message");
  if (msgEl && msgEl.textContent !== error.message) {
    msgEl.textContent = error.message;
  }
  const diagEl = sec.querySelector             ("#dz-error-diagnostics");
  if (diagEl) {
    const text = `Code: ${error.code}\nCategory: ${error.category}\nRetryable: ${error.retryable}\nTransport: ${error.transport ?? "direct"}\nPhase: ${error.phase ?? "discovery"}\nMessage: ${error.message}`;
    if (diagEl.textContent !== text) {
      diagEl.textContent = text;
    }
  }
}

function mountCancelledSection(
  parent             ,
  _state                 ,
  callbacks               ,
  _ctx              ,
)       {
  const section = document.createElement("div");
  section.className = "dz-view-body dz-notice-section dz-fade-in";
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

function mountGenericState(
  parent             ,
  state                 ,
  callbacks               ,
  _ctx              ,
)       {
  const div = document.createElement("div");
  div.className = "dz-view-body dz-fade-in";
  div.style.padding = "1rem 0";
  div.innerHTML = `
    <p style="color: var(--dz-text-secondary)">Status: <strong>${state.status}</strong></p>
    <button type="button" class="dz-btn-secondary" id="dz-btn-reset">Reset</button>
  `;
  div.querySelector("#dz-btn-reset")?.addEventListener("click", () => callbacks.onReset());
  parent.appendChild(div);
}
