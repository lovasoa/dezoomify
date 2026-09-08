// Desktop settings panel (todo 2.2 split from main.tsx).
// Minimal settings draft plus the settings section inside the single status
// card. State arrives through explicit env params, so this module owns no
// job state. File move, no behavior change.
import { t } from "@dezoomify/shared-ui";
import {
  describeSettingsForLog,
  parseHeadersText,
  pickDirectory,
  saveSettings,
  validateSettings,
} from "./settings.ts";
import type { DesktopSettings } from "./settings.ts";

// --- Minimal settings (task 3.5) ---

// Read the current settings draft from the panel inputs when present,
// otherwise the last persisted settings. Always validated fail-closed;
// callers must not start a job when `ok` is false. Header values are never
// logged; only describeSettingsForLog leaves this layer.
export function getEffectiveSettings(
  root: Element | null,
  fallback: DesktopSettings,
): { ok: boolean; settings: DesktopSettings | null; errors: Array<string> } {
  if (typeof document === "undefined" || !root) {
    const validated = validateSettings({
      outputDir: fallback.outputDir,
      outputFormat: fallback.outputFormat,
      compression: fallback.compression,
      maxWidth: fallback.maxWidth,
      maxHeight: fallback.maxHeight,
      retries: fallback.retries,
      networkProfile: fallback.networkProfile,
      cacheDir: fallback.cacheDir,
      headers: { ...fallback.headers },
    });
    if (!validated.ok || !validated.settings) return { ok: false, settings: null, errors: validated.errors };
    return { ok: true, settings: validated.settings, errors: [] };
  }
  const panel = document.getElementById("dz-desktop-settings");
  if (!panel) {
    return { ok: true, settings: fallback, errors: [] };
  }
  const readInput = (id: string): string => {
    const el = panel.querySelector(`#${id}`) as HTMLInputElement | HTMLTextAreaElement | null;
    return el && typeof el.value === "string" ? el.value : "";
  };
  const headersRaw = readInput("dz-settings-headers");
  const parsedHeaders = parseHeadersText(headersRaw);
  const raw = {
    outputDir: readInput("dz-settings-output-dir"),
    outputFormat: readInput("dz-settings-output-format") || fallback.outputFormat,
    compression: readInput("dz-settings-compression"),
    maxWidth: readInput("dz-settings-max-width"),
    maxHeight: readInput("dz-settings-max-height"),
    retries: readInput("dz-settings-retries"),
    networkProfile: readInput("dz-settings-network-profile") || fallback.networkProfile,
    cacheDir: readInput("dz-settings-cache-dir"),
    headers: parsedHeaders.headers,
  };
  const errors: Array<string> = [...parsedHeaders.errors];
  const validated = validateSettings(raw);
  for (const e of validated.errors) errors.push(e);
  if (!validated.ok || !validated.settings) return { ok: false, settings: null, errors };
  return { ok: true, settings: validated.settings, errors: [] };
}


export interface SettingsPanelEnv {
  root: Element | null;
  getSettings: () => DesktopSettings;
  setSettings: (settings: DesktopSettings) => void;
  setError: (error: string | null) => void;
  pushLog: (line: string) => void;
  update: () => void;
}

// Persist the panel draft when valid; show validation errors otherwise.
// Invalid drafts never overwrite the last good persisted payload.
export function persistSettingsFromPanel(env: SettingsPanelEnv): void {
  const effective = getEffectiveSettings(env.root, env.getSettings());
  if (!effective.ok || !effective.settings) {
    env.setError(effective.errors.join("; ") || "Invalid settings.");
    env.update();
    return;
  }
  env.setError(null);
  env.setSettings(effective.settings);
  const saveErrors = saveSettings(effective.settings);
  if (saveErrors.length > 0) {
    env.setError(saveErrors.join("; "));
  } else {
    env.pushLog(`Settings saved: ${describeSettingsForLog(effective.settings)}`);
  }
  env.update();
}


export function resetDesktopSettings(env: SettingsPanelEnv): void {
  const fresh = validateSettings(null);
  const settings = fresh.settings ?? env.getSettings();
  env.setSettings(settings);
  env.setError(null);
  saveSettings(settings);
  env.pushLog("Settings reset to defaults");
  env.update();
}


// Minimal settings panel: simple section inside the single status card,
// re-applied after every render by stable id. Skips re-render while focus
// sits inside the panel so typing never loses focus. All values validate
// fail-closed; header values never enter logs or diagnostics.
//
// Accessibility: region labelled by its heading, every input wrapped in an
// explicit label (name + control), browse buttons carry distinct aria-labels
// so the two "Browse" actions stay distinguishable, and validation errors
// use role="alert" with aria-live assertive. All controls are native and Tab
// reachable with the crisp 2px focus ring.
export interface SettingsPanelView {
  root: Element | null;
  settings: DesktopSettings;
  error: string | null;
  onPersist: () => void;
  onReset: () => void;
}

export function ensureDesktopSettingsPanel(view: SettingsPanelView): void {
  const root = view.root;
  if (typeof document === "undefined" || !root) return;
  const card = root.querySelector(".dz-card");
  if (!card) return;
  const existing = document.getElementById("dz-desktop-settings");
  if (existing && existing.contains(document.activeElement)) return;
  existing?.remove();

  const doc = root.ownerDocument;
  const panel = doc.createElement("section");
  panel.id = "dz-desktop-settings";
  panel.className = "dz-view-body dz-desktop-settings";
  panel.setAttribute("aria-label", "Job options");

  const hidden = (id: string, value: string): HTMLInputElement => {
    const input = doc.createElement("input");
    input.type = "hidden";
    input.id = id;
    input.value = value;
    panel.appendChild(input);
    return input;
  };
  const outputDir = hidden("dz-settings-output-dir", view.settings.outputDir ?? "");
  const maxWidth = hidden("dz-settings-max-width", view.settings.maxWidth === null ? "" : String(view.settings.maxWidth));
  const maxHeight = hidden("dz-settings-max-height", view.settings.maxHeight === null ? "" : String(view.settings.maxHeight));
  const cacheDir = hidden("dz-settings-cache-dir", view.settings.cacheDir ?? "");

  const formatSelect = doc.createElement("select");
  formatSelect.id = "dz-settings-output-format";
  formatSelect.hidden = true;
  for (const option of ["png", "jpeg", "tiff", "zif", "webp", "iiif-dir"]) {
    const el = doc.createElement("option");
    el.value = option;
    el.selected = option === view.settings.outputFormat;
    formatSelect.appendChild(el);
  }
  panel.appendChild(formatSelect);
  const networkSelect = doc.createElement("select");
  networkSelect.id = "dz-settings-network-profile";
  networkSelect.hidden = true;
  for (const option of ["maximum", "balanced", "gentle"]) {
    const el = doc.createElement("option");
    el.value = option;
    el.selected = option === view.settings.networkProfile;
    networkSelect.appendChild(el);
  }
  panel.appendChild(networkSelect);

  const strip = doc.createElement("div");
  strip.className = "dz-quick-options";
  const quickSelect = (label: string, value: string, options: Array<[string, string]>, onChange: (value: string) => void) => {
    const wrap = doc.createElement("label");
    wrap.className = "dz-quick-option";
    const title = doc.createElement("span");
    title.textContent = label;
    const select = doc.createElement("select");
    select.setAttribute("aria-label", label);
    for (const [id, text] of options) {
      const option = doc.createElement("option");
      option.value = id;
      option.textContent = text;
      option.selected = id === value;
      select.appendChild(option);
    }
    select.addEventListener("change", () => onChange(select.value));
    wrap.append(title, select);
    strip.appendChild(wrap);
  };

  const destination = doc.createElement("div");
  destination.className = "dz-quick-option";
  const destinationLabel = doc.createElement("span");
  destinationLabel.textContent = "Save to";
  const destinationButton = doc.createElement("button");
  destinationButton.type = "button";
  destinationButton.className = "dz-quick-button";
  destinationButton.textContent = outputDir.value ? outputDir.value.split(/[\\/]/).filter(Boolean).pop() ?? "Chosen folder" : "Ask each time";
  destinationButton.title = outputDir.value || "Choose a starting folder for the save dialog";
  destinationButton.addEventListener("click", () => {
    void pickDirectory(outputDir.value || null).then((picked) => {
      if (!picked) return;
      outputDir.value = picked;
      destinationButton.textContent = picked.split(/[\\/]/).filter(Boolean).pop() ?? "Chosen folder";
      destinationButton.title = picked;
      view.onPersist();
    });
  });
  destination.append(destinationLabel, destinationButton);
  strip.appendChild(destination);

  quickSelect("Format", view.settings.outputFormat, [
    ["png", "PNG"], ["jpeg", "JPEG"], ["tiff", "TIFF"], ["webp", "WebP"], ["zif", "ZIF"], ["iiif-dir", "IIIF folder"],
  ], (value) => {
    formatSelect.value = value;
    view.onPersist();
  });
  const sizeValue = view.settings.maxWidth === null && view.settings.maxHeight === null
    ? "full"
    : view.settings.maxWidth === 3840 && view.settings.maxHeight === null ? "3840"
      : view.settings.maxWidth === 2048 && view.settings.maxHeight === null ? "2048" : "custom";
  quickSelect("Size", sizeValue, [["full", "Full resolution"], ["3840", "Up to 4K"], ["2048", "Up to 2K"], ["custom", "Custom…"]], (value) => {
    if (value === "full") { maxWidth.value = ""; maxHeight.value = ""; }
    if (value === "3840" || value === "2048") { maxWidth.value = value; maxHeight.value = ""; }
    if (value !== "custom") view.onPersist();
    else settingsDialog.showModal();
  });
  quickSelect("Network", view.settings.networkProfile, [["maximum", "Maximum"], ["balanced", "Balanced"], ["gentle", "Gentle"]], (value) => {
    networkSelect.value = value;
    view.onPersist();
  });

  const settingsDialog = doc.createElement("dialog");
  settingsDialog.className = "dz-settings-dialog";
  settingsDialog.setAttribute("aria-labelledby", "dz-settings-dialog-title");
  const moreButton = doc.createElement("button");
  moreButton.type = "button";
  moreButton.id = "dz-settings-title";
  moreButton.className = "dz-settings-more";
  moreButton.setAttribute("aria-label", "More settings");
  moreButton.textContent = "⚙";
  moreButton.addEventListener("click", () => settingsDialog.showModal());
  strip.appendChild(moreButton);

  const sheet = doc.createElement("div");
  sheet.className = "dz-settings-sheet";
  const sheetHead = doc.createElement("div");
  sheetHead.className = "dz-settings-sheet-head";
  const heading = doc.createElement("h2");
  heading.id = "dz-settings-dialog-title";
  heading.textContent = "Advanced settings";
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "dz-settings-close";
  close.textContent = "Done";
  close.addEventListener("click", () => settingsDialog.close());
  sheetHead.append(heading, close);
  sheet.appendChild(sheetHead);

  const makeRow = (title: string, description: string, control: HTMLElement): void => {
    const row = doc.createElement("div");
    row.className = "dz-preference-row";
    const copy = doc.createElement("div");
    const label = doc.createElement("strong");
    label.textContent = title;
    const desc = doc.createElement("span");
    desc.textContent = description;
    copy.append(label, desc);
    row.append(copy, control);
    sheet.appendChild(row);
  };

  const compressionWrap = doc.createElement("div");
  compressionWrap.className = "dz-slider-control";
  const compression = doc.createElement("input");
  compression.id = "dz-settings-compression";
  compression.type = "range";
  compression.min = "0";
  compression.max = "100";
  compression.value = String(view.settings.compression);
  const compressionValue = doc.createElement("output");
  compressionValue.textContent = compression.value;
  compression.addEventListener("input", () => { compressionValue.textContent = compression.value; });
  compression.addEventListener("change", () => view.onPersist());
  compressionWrap.append(compression, compressionValue);
  makeRow("Compression", "Higher values make smaller files but take longer.", compressionWrap);

  const sizeInputs = doc.createElement("div");
  sizeInputs.className = "dz-size-control";
  const widthInput = doc.createElement("input");
  widthInput.type = "number";
  widthInput.min = "1";
  widthInput.max = "1000000";
  widthInput.placeholder = "Width";
  widthInput.value = maxWidth.value;
  const heightInput = doc.createElement("input");
  heightInput.type = "number";
  heightInput.min = "1";
  heightInput.max = "1000000";
  heightInput.placeholder = "Height";
  heightInput.value = maxHeight.value;
  for (const input of [widthInput, heightInput]) input.addEventListener("change", () => {
    maxWidth.value = widthInput.value;
    maxHeight.value = heightInput.value;
    view.onPersist();
  });
  sizeInputs.append(widthInput, doc.createTextNode("×"), heightInput);
  makeRow("Custom dimensions", "Leave either value empty to preserve the original proportion.", sizeInputs);

  const retries = doc.createElement("input");
  retries.id = "dz-settings-retries";
  retries.className = "dz-number-control";
  retries.type = "number";
  retries.min = "0";
  retries.max = "100";
  retries.value = String(view.settings.retries);
  retries.addEventListener("change", () => view.onPersist());
  makeRow("Retries", "Try failed image tiles again before keeping a partial result.", retries);

  const cacheButton = doc.createElement("button");
  cacheButton.type = "button";
  cacheButton.className = "dz-compact-action";
  cacheButton.textContent = cacheDir.value ? "Change…" : "Choose…";
  cacheButton.addEventListener("click", () => {
    void pickDirectory(cacheDir.value || null).then((picked) => {
      if (!picked) return;
      cacheDir.value = picked;
      view.onPersist();
    });
  });
  makeRow("Resume cache", "Reuse tiles after an interrupted save.", cacheButton);

  const headersDetails = doc.createElement("details");
  headersDetails.className = "dz-headers-disclosure";
  const headersSummary = doc.createElement("summary");
  headersSummary.textContent = "Request headers";
  const headersHint = doc.createElement("p");
  headersHint.textContent = "For protected viewers. Sent only to the image origin and never logged.";
  const headers = doc.createElement("textarea");
  headers.id = "dz-settings-headers";
  headers.rows = 3;
  headers.placeholder = "Referer: https://example.com/viewer";
  headers.value = Object.entries(view.settings.headers).map(([name, value]) => `${name}: ${value}`).join("\n");
  headers.addEventListener("change", () => view.onPersist());
  headersDetails.append(headersSummary, headersHint, headers);
  sheet.appendChild(headersDetails);

  if (view.error) {
    const error = doc.createElement("p");
    error.id = "dz-settings-error";
    error.setAttribute("role", "alert");
    error.textContent = view.error;
    sheet.appendChild(error);
  }
  const reset = doc.createElement("button");
  reset.type = "button";
  reset.className = "dz-settings-reset";
  reset.textContent = t("desktop.settings.reset");
  reset.addEventListener("click", () => view.onReset());
  sheet.appendChild(reset);
  settingsDialog.appendChild(sheet);
  panel.append(strip, settingsDialog);
  card.appendChild(panel);
}
