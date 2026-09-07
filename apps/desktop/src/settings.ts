// Minimal desktop settings: validated bounds, local persistence, CLI parity.
//
// Fields:
// - output dir (native dir picker; text input plus Browse button)
// - compression 0-100, default 5 (JPEG quality 100-x, PNG tier)
// - max-width / max-height caps, optional positive ints
// - retries, default 3 (0 allowed = no retries), bounded 0-100
// - cache-dir, optional resume cache (tile bodies only, never headers)
// - user headers (-H, trusted, origin-scoped, never logged)
//
// Persistence is the webview local file (localStorage key
// `dezoomify.desktop.settings.v1`), validated on load with fail-closed to
// defaults. No Tauri store plugin is required. Header values never enter
// logs, diagnostics, or cache keys; use describeSettingsForLog.
//
// Keep erasable syntax only so node type-stripping can read this file. No
// imports from apps/web, apps/extension, or browser-runtime. No fetch/XHR.

export interface DesktopSettings {
  readonly outputDir: string | null;
  readonly compression: number;
  readonly maxWidth: number | null;
  readonly maxHeight: number | null;
  readonly retries: number;
  readonly cacheDir: string | null;
  readonly headers: Readonly<Record<string, string>>;
}

export const SETTINGS_STORAGE_KEY = "dezoomify.desktop.settings.v1" as const;
export const DEFAULT_COMPRESSION = 5 as const;
export const DEFAULT_RETRIES = 3 as const;
export const MAX_RETRIES = 100 as const;
export const MAX_DIMENSION = 1000000 as const;
export const MAX_PATH_LEN = 4096 as const;
export const MAX_HEADERS = 32 as const;

export function defaultSettings(): DesktopSettings {
  return {
    outputDir: null,
    compression: DEFAULT_COMPRESSION,
    maxWidth: null,
    maxHeight: null,
    retries: DEFAULT_RETRIES,
    cacheDir: null,
    headers: {},
  };
}

const HEADER_NAME_RE = /^[a-z0-9!#$%&'*+\-.^_`|~]+$/;

function isValidHeaderName(name: string): boolean {
  if (name.length === 0 || name.length > 128) return false;
  return HEADER_NAME_RE.test(name);
}

export interface HeadersParse {
  readonly headers: Record<string, string>;
  readonly errors: Array<string>;
}

// Parse `-H "Name: value"` lines (one per line, blank lines ignored, last
// wins). Errors fail closed with a message; valid entries are still
// returned so the UI can show both.
export function parseHeadersText(text: string): HeadersParse {
  const headers: Record<string, string> = {};
  const errors: Array<string> = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    if (colon < 0) {
      errors.push(`headers line ${i + 1}: expected "Name: value"`);
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!isValidHeaderName(name)) {
      errors.push(`headers line ${i + 1}: bad header name`);
      continue;
    }
    if (value.length > 4096) {
      errors.push(`headers line ${i + 1}: value too long`);
      continue;
    }
    if (value.includes("\r") || value.includes("\n") || value.includes("\0")) {
      errors.push(`headers line ${i + 1}: value must not contain CR/LF/NUL`);
      continue;
    }
    headers[name] = value;
    if (Object.keys(headers).length > MAX_HEADERS) {
      errors.push(`too many headers (max ${MAX_HEADERS})`);
      break;
    }
  }
  return { headers, errors };
}

export function headersToText(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name]) => `${name}: …`)
    .join("\n");
}

// Raw header text with values (for editing only; never log this string).
export function headersToEditableText(headers: Readonly<Record<string, string>>): string {
  return Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n");
}

export interface SettingsValidation {
  readonly ok: boolean;
  readonly settings: DesktopSettings | null;
  readonly errors: Array<string>;
}

function parseOptionalDir(raw: unknown, field: string, errors: Array<string>): string | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    errors.push(`${field} must be a string path`);
    return undefined;
  }
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (trimmed.length > MAX_PATH_LEN) {
    errors.push(`${field} too long (max ${MAX_PATH_LEN} bytes)`);
    return undefined;
  }
  if (trimmed.includes("\0")) {
    errors.push(`${field} must not contain NUL`);
    return undefined;
  }
  return trimmed;
}

function parseOptionalDimension(
  raw: unknown,
  field: string,
  errors: Array<string>,
): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw <= 0 || raw > MAX_DIMENSION) {
      errors.push(`${field} must be 1..=${MAX_DIMENSION}`);
      return undefined;
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n <= 0 || n > MAX_DIMENSION) {
      errors.push(`${field} must be 1..=${MAX_DIMENSION}`);
      return undefined;
    }
    return n;
  }
  errors.push(`${field} must be a positive integer`);
  return undefined;
}

function parseCompression(raw: unknown, errors: Array<string>): number | undefined {
  if (raw === undefined) return DEFAULT_COMPRESSION;
  let n: number | null = null;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw.trim());
  else {
    errors.push("compression must be 0..=100");
    return undefined;
  }
  if (n === null || !Number.isInteger(n) || n < 0 || n > 100) {
    errors.push("compression must be 0..=100");
    return undefined;
  }
  return n;
}

function parseRetries(raw: unknown, errors: Array<string>): number | undefined {
  if (raw === undefined) return DEFAULT_RETRIES;
  let n: number | null = null;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && raw.trim() !== "") n = Number(raw.trim());
  else {
    errors.push(`retries must be 0..=${MAX_RETRIES}`);
    return undefined;
  }
  if (n === null || !Number.isInteger(n) || n < 0 || n > MAX_RETRIES) {
    errors.push(`retries must be 0..=${MAX_RETRIES}`);
    return undefined;
  }
  return n;
}

function parseHeadersValue(raw: unknown, errors: Array<string>): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return {};
  if (typeof raw === "string") {
    const parsed = parseHeadersText(raw);
    for (const e of parsed.errors) errors.push(e);
    if (parsed.errors.length > 0) return undefined;
    return parsed.headers;
  }
  if (Array.isArray(raw)) {
    const parsed = parseHeadersText(
      raw.filter((v) => typeof v === "string").join("\n"),
    );
    if (raw.some((v) => typeof v !== "string")) {
      errors.push("headers must be Name: value lines");
      return undefined;
    }
    for (const e of parsed.errors) errors.push(e);
    if (parsed.errors.length > 0) return undefined;
    return parsed.headers;
  }
  if (typeof raw === "object") {
    const out: Record<string, string> = {};
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
      const name = key.trim().toLowerCase();
      if (!isValidHeaderName(name)) {
        errors.push("invalid header: bad name");
        return undefined;
      }
      if (typeof val !== "string") {
        errors.push("invalid header: value must be a string");
        return undefined;
      }
      const value = val.trim();
      if (value.length > 4096 || value.includes("\r") || value.includes("\n") || value.includes("\0")) {
        errors.push("invalid header: bad value");
        return undefined;
      }
      out[name] = value;
      if (Object.keys(out).length > MAX_HEADERS) {
        errors.push(`too many headers (max ${MAX_HEADERS})`);
        return undefined;
      }
    }
    return out;
  }
  errors.push("headers must be an object or Name: value lines");
  return undefined;
}

// Validate a raw settings object, failing closed on any invalid field.
// Unknown fields are ignored. Null/empty-string dir and dimension fields
// mean unset.
export function validateSettings(raw: unknown): SettingsValidation {
  const errors: Array<string> = [];
  if (raw === null || raw === undefined) {
    return { ok: true, settings: defaultSettings(), errors: [] };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, settings: null, errors: ["settings must be an object"] };
  }
  const obj = raw as Record<string, unknown>;
  const compression = parseCompression(obj["compression"], errors);
  const retries = parseRetries(obj["retries"], errors);
  const maxWidth = parseOptionalDimension(obj["maxWidth"] ?? obj["max_width"], "max-width", errors);
  const maxHeight = parseOptionalDimension(obj["maxHeight"] ?? obj["max_height"], "max-height", errors);
  const outputDir = parseOptionalDir(obj["outputDir"] ?? obj["output_dir"], "output dir", errors);
  const cacheDir = parseOptionalDir(
    obj["cacheDir"] ?? obj["cache_dir"] ?? obj["cache-dir"],
    "cache dir",
    errors,
  );
  const headers = parseHeadersValue(obj["headers"], errors);
  if (
    compression === undefined ||
    retries === undefined ||
    maxWidth === undefined ||
    maxHeight === undefined ||
    outputDir === undefined ||
    cacheDir === undefined ||
    headers === undefined
  ) {
    return { ok: false, settings: null, errors };
  }
  if (errors.length > 0) {
    return { ok: false, settings: null, errors };
  }
  return {
    ok: true,
    settings: {
      outputDir,
      compression,
      maxWidth,
      maxHeight,
      retries,
      cacheDir,
      headers,
    },
    errors: [],
  };
}

interface MemoryStore {
  [key: string]: string;
}

const memoryFallback: MemoryStore = {};

function readStoredText(): string | null {
  try {
    const ls = (globalThis as Record<string, unknown>)["localStorage"] as
      | { getItem?: (key: string) => string | null }
      | undefined;
    if (ls && typeof ls.getItem === "function") {
      return ls.getItem(SETTINGS_STORAGE_KEY);
    }
  } catch {
    // Storage unavailable; fall through to the memory fallback.
  }
  return memoryFallback[SETTINGS_STORAGE_KEY] ?? null;
}

function writeStoredText(text: string): void {
  try {
    const ls = (globalThis as Record<string, unknown>)["localStorage"] as
      | { setItem?: (key: string, value: string) => void }
      | undefined;
    if (ls && typeof ls.setItem === "function") {
      ls.setItem(SETTINGS_STORAGE_KEY, text);
      return;
    }
  } catch {
    // Storage unavailable; fall through to the memory fallback.
  }
  memoryFallback[SETTINGS_STORAGE_KEY] = text;
}

// Load persisted settings, validated with fail-closed to defaults on any
// invalid or unreadable payload.
export function loadSettings(): DesktopSettings {
  const raw = readStoredText();
  if (!raw) return defaultSettings();
  try {
    const parsed: unknown = JSON.parse(raw);
    const validated = validateSettings(parsed);
    if (validated.ok && validated.settings) return validated.settings;
    return defaultSettings();
  } catch {
    return defaultSettings();
  }
}

// Persist validated settings only. Returns validation errors without
// persisting when invalid (fail closed, keeps the last good payload).
export function saveSettings(settings: DesktopSettings): Array<string> {
  const validated = validateSettings({
    outputDir: settings.outputDir,
    compression: settings.compression,
    maxWidth: settings.maxWidth,
    maxHeight: settings.maxHeight,
    retries: settings.retries,
    cacheDir: settings.cacheDir,
    headers: { ...settings.headers },
  });
  if (!validated.ok || !validated.settings) return validated.errors;
  try {
    writeStoredText(JSON.stringify(validated.settings));
  } catch {
    return ["could not persist settings"];
  }
  return [];
}

// Payload for the `start_job` Tauri command (snake_case, null for unset).
// Header values travel here; never pass this object to logs.
export function settingsToInvokeArgs(settings: DesktopSettings): Record<string, unknown> {
  return {
    compression: settings.compression,
    retries: settings.retries,
    max_width: settings.maxWidth,
    max_height: settings.maxHeight,
    output_dir: settings.outputDir,
    cache_dir: settings.cacheDir,
    headers: { ...settings.headers },
  };
}

// Redacted one-line summary for logs and diagnostics: numeric fields plus
// presence flags and header names only. Never header values.
export function describeSettingsForLog(settings: DesktopSettings): string {
  const names = Object.keys(settings.headers).sort();
  const maxWidth = settings.maxWidth === null ? "none" : String(settings.maxWidth);
  const maxHeight = settings.maxHeight === null ? "none" : String(settings.maxHeight);
  const outputDir = settings.outputDir === null ? "unset" : "set";
  const cacheDir = settings.cacheDir === null ? "unset" : "set";
  return (
    `compression=${settings.compression} retries=${settings.retries} ` +
    `max_width=${maxWidth} max_height=${maxHeight} output_dir=${outputDir} ` +
    `cache_dir=${cacheDir} headers=${names.length} [${names.join(",")}]`
  );
}

// Native directory picker via the Tauri dialog plugin (`dialog:allow-open`).
// Returns the chosen directory or null when unavailable, denied, or
// cancelled. Never throws. Falls back to null (manual entry) outside Tauri.
export async function pickDirectory(current: string | null): Promise<string | null> {
  const internals = (globalThis as Record<string, unknown>)["__TAURI_INTERNALS__"] as
    | { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> }
    | undefined;
  const invoke = internals?.invoke;
  if (typeof invoke !== "function") return null;
  const attempts: Array<Record<string, unknown>> = [
    { directory: true, multiple: false },
    { directory: true },
  ];
  for (const options of attempts) {
    try {
      const raw = await invoke("plugin:dialog|open", {
        ...options,
        ...(current ? { defaultPath: current } : {}),
      });
      if (typeof raw === "string" && raw.length > 0) return raw;
      if (Array.isArray(raw) && typeof raw[0] === "string" && (raw[0] as string).length > 0) {
        return raw[0] as string;
      }
      if (raw !== null && typeof raw === "object") {
        const obj = raw as Record<string, unknown>;
        for (const key of ["path", "filePath", "directory", "value"]) {
          const v = obj[key];
          if (typeof v === "string" && v.length > 0) return v;
        }
      }
      // Cancelled (null) stops further attempts.
      if (raw === null || raw === undefined) return null;
    } catch {
      // Try the next shape, then fall back to manual entry.
    }
  }
  return null;
}
