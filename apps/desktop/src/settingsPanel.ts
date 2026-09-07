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
      outputFormat: (fallback as unknown as { outputFormat?: string }).outputFormat,
      compression: fallback.compression,
      maxWidth: fallback.maxWidth,
      maxHeight: fallback.maxHeight,
      retries: fallback.retries,
      cacheDir: fallback.cacheDir,
      headers: { ...fallback.headers },
      crop: (fallback as unknown as { crop?: string | null }).crop ?? null,
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
    // The output format picker lives in the aux panel (radio group), not in
    // this settings form: preserve the persisted choice here so saving
    // download settings never clobbers the chosen encoder.
    outputFormat: (fallback as unknown as { outputFormat?: string }).outputFormat,
    compression: readInput("dz-settings-compression"),
    maxWidth: readInput("dz-settings-max-width"),
    maxHeight: readInput("dz-settings-max-height"),
    retries: readInput("dz-settings-retries"),
    cacheDir: readInput("dz-settings-cache-dir"),
    headers: parsedHeaders.headers,
    crop: readInput("dz-settings-crop"),
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
  const panel = doc.createElement("div");
  panel.id = "dz-desktop-settings";
  panel.className = "dz-view-body dz-desktop-settings";
  panel.setAttribute("role", "region");
  panel.setAttribute("aria-labelledby", "dz-settings-title");

  const title = doc.createElement("h2");
  title.className = "dz-notice-title";
  title.id = "dz-settings-title";
  title.textContent = t("desktop.settings.title");
  const desc = doc.createElement("p");
  desc.className = "dz-notice-message";
  desc.textContent = t("desktop.settings.desc");
  panel.append(title, desc);

  const form = doc.createElement("div");
  form.className = "dz-settings-form";

  function addLabeledInput(
    id: string,
    label: string,
    value: string,
    opts: { inputMode?: string; placeholder?: string; type?: string },
  ): HTMLInputElement {
    const wrap = doc.createElement("label");
    wrap.className = "dz-settings-field";
    wrap.setAttribute("for", id);
    const span = doc.createElement("span");
    span.textContent = label;
    const input = doc.createElement("input");
    input.id = id;
    input.name = id;
    input.type = opts.type ?? "text";
    input.className = "dz-input";
    if (opts.inputMode) input.inputMode = opts.inputMode;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.value = value;
    input.addEventListener("change", () => view.onPersist());
    wrap.append(span, input);
    form.appendChild(wrap);
    return input;
  }

  const outputInput = addLabeledInput(
    "dz-settings-output-dir",
    t("desktop.settings.outputDir"),
    view.settings.outputDir ?? "",
    { placeholder: "/home/you/Pictures" },
  );
  const compressionInput = addLabeledInput(
    "dz-settings-compression",
    t("desktop.settings.compression"),
    String(view.settings.compression),
    { inputMode: "numeric" },
  );
  const maxWidthInput = addLabeledInput(
    "dz-settings-max-width",
    t("desktop.settings.maxWidth"),
    view.settings.maxWidth === null ? "" : String(view.settings.maxWidth),
    { inputMode: "numeric", placeholder: t("desktop.settings.emptyLargest") },
  );
  const maxHeightInput = addLabeledInput(
    "dz-settings-max-height",
    t("desktop.settings.maxHeight"),
    view.settings.maxHeight === null ? "" : String(view.settings.maxHeight),
    { inputMode: "numeric", placeholder: t("desktop.settings.emptyLargest") },
  );
  const retriesInput = addLabeledInput(
    "dz-settings-retries",
    t("desktop.settings.retries"),
    String(view.settings.retries),
    { inputMode: "numeric" },
  );
  const cacheInput = addLabeledInput(
    "dz-settings-cache-dir",
    t("desktop.settings.cacheDir"),
    view.settings.cacheDir ?? "",
    { placeholder: "/home/you/.cache/dezoomify" },
  );
  const cropInput = addLabeledInput(
    "dz-settings-crop",
    t("desktop.settings.crop"),
    (view.settings as unknown as { crop?: string | null }).crop ?? "",
    { placeholder: t("desktop.settings.cropPlaceholder") },
  );
  void compressionInput;
  void maxWidthInput;
  void maxHeightInput;
  void retriesInput;
  void cropInput;

  function addBrowseButton(forInput: HTMLInputElement, label: string): void {
    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "dz-btn-secondary";
    btn.textContent = t("desktop.settings.browse");
    btn.setAttribute("aria-label", label);
    btn.addEventListener("click", () => {
      void pickDirectory(forInput.value || null).then((picked) => {
        if (picked) {
          forInput.value = picked;
          view.onPersist();
          try {
            forInput.focus();
          } catch {
            // Focus restore is best effort.
          }
        } else {
          try {
            btn.focus();
          } catch {
            // Keep focus where it is when the picker cancels.
          }
        }
      });
    });
    form.appendChild(btn);
  }
  addBrowseButton(outputInput, t("desktop.settings.browseOutput"));
  addBrowseButton(cacheInput, t("desktop.settings.browseCache"));

  const headersDetails = doc.createElement("details");
  headersDetails.className = "dz-details";
  headersDetails.open = true;
  const headersSummary = doc.createElement("summary");
  headersSummary.className = "dz-summary";
  headersSummary.textContent = t("desktop.settings.headersAdv");
  const headersLabel = doc.createElement("label");
  headersLabel.className = "dz-settings-field";
  headersLabel.setAttribute("for", "dz-settings-headers");
  const headersSpan = doc.createElement("span");
  headersSpan.textContent = t("desktop.settings.headersLabel");
  const headersInput = doc.createElement("textarea");
  headersInput.id = "dz-settings-headers";
  headersInput.name = "dz-settings-headers";
  headersInput.className = "dz-input";
  headersInput.rows = 3;
  headersInput.placeholder = "Referer: https://example.com/viewer";
  headersInput.value = Object.entries(view.settings.headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
  headersInput.addEventListener("change", () => view.onPersist());
  headersLabel.append(headersSpan, headersInput);
  headersDetails.append(headersSummary, headersLabel);
  form.appendChild(headersDetails);

  panel.appendChild(form);

  if (view.error) {
    const err = doc.createElement("p");
    err.className = "dz-notice-message";
    err.id = "dz-settings-error";
    err.setAttribute("role", "alert");
    err.setAttribute("aria-live", "assertive");
    err.textContent = view.error;
    panel.appendChild(err);
  }

  const row = doc.createElement("div");
  row.className = "dz-actions-row";
  const resetBtn = doc.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "dz-btn-secondary";
  resetBtn.textContent = t("desktop.settings.reset");
  resetBtn.addEventListener("click", () => view.onReset());
  row.appendChild(resetBtn);
  panel.appendChild(row);

  card.appendChild(panel);
}
