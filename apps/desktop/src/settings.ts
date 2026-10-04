// Minimal desktop settings: raw values, local persistence, CLI parity.
//
// Fields:
// - output dir (native dir picker; text input plus Browse button)
// - output format (native encoder/directory picker, default auto)
// - compression 0-100, default 5 (JPEG quality 100-x, PNG tier)
// - max-width / max-height caps, optional positive ints
// - retries, default 3 (0 allowed = no retries), bounded 0-100
// - cache-dir, optional resume cache (tile bodies only, never headers)
// - user headers (-H, trusted, origin-scoped) as raw `Name: value` lines
//
// Rust is the single validator
// (`apps/desktop/src-tauri/src/settings.rs::parse_settings`): raw values
// cross IPC unchanged and typed rejection reasons flow back on save. This
// module keeps the types, shape normalization on load, and the webview
// local file (localStorage key `dezoomify.desktop.settings.v1`) with
// fail-closed to defaults. No Tauri store plugin is required. Header
// values never enter logs, diagnostics, or cache keys.
//
// Keep erasable syntax only so node type-stripping can read this file. No
// imports from apps/web, apps/extension, or browser-runtime. No fetch/XHR.

import type { OutputPreference } from "@dezoomify/wasm-bindings";
import { invoke } from "@tauri-apps/api/core";
import { downloadDir } from "@tauri-apps/api/path";

export interface DesktopSettings {
  readonly output_dir: string | null;
  readonly output_format: OutputPreference;
  readonly compression: number;
  readonly max_width: number | null;
  readonly max_height: number | null;
  readonly retries: number;
  readonly network_profile: NetworkProfile;
  readonly cache_dir: string | null;
  readonly headers: ReadonlyArray<string>;
}

export const SETTINGS_STORAGE_KEY = "dezoomify.desktop.settings.v1" as const;
export const OUTPUT_FORMATS: ReadonlyArray<DesktopSettings["output_format"]> = [
  "auto",
  "png",
  "jpeg",
  "tiff",
  "zif",
  "webp",
  "iiif-dir",
] as const;
export const DEFAULT_OUTPUT_FORMAT = "auto" as const;
export const DEFAULT_COMPRESSION = 5 as const;
export const DEFAULT_RETRIES = 3 as const;
export type NetworkProfile = "maximum" | "balanced" | "gentle";
export const NETWORK_PROFILES: ReadonlyArray<NetworkProfile> = [
  "maximum",
  "balanced",
  "gentle",
] as const;
export const DEFAULT_NETWORK_PROFILE: NetworkProfile = "maximum";
export const MAX_PATH_LEN = 4096 as const;

export function defaultSettings(): DesktopSettings {
  return {
    output_dir: null,
    output_format: DEFAULT_OUTPUT_FORMAT,
    compression: DEFAULT_COMPRESSION,
    max_width: null,
    max_height: null,
    retries: DEFAULT_RETRIES,
    network_profile: DEFAULT_NETWORK_PROFILE,
    cache_dir: null,
    headers: [],
  };
}

// Resolve the OS Downloads directory through Tauri instead of guessing a
// platform path. This is deliberately asynchronous: localStorage settings
// still render immediately, then first-run/null output paths are upgraded
// before the user starts a job. Hosts without the path plugin reject, which
// maps to null (manual entry) below.
export async function defaultOutputDirectory(): Promise<string | null> {
  try {
    const path = await downloadDir();
    return path.length > 0 && path.length <= MAX_PATH_LEN && !path.includes("\0") ? path : null;
  } catch {
    return null;
  }
}

/** Stored header lines as editable text (one raw `Name: value` per line). */
export function headersToEditableText(headers: ReadonlyArray<string>): string {
  return headers.join("\n");
}

interface MemoryStore {
  [key: string]: string;
}

const memoryFallback: MemoryStore = {};

function readStoredText(): string | null {
  try {
    const ls = (globalThis as Record<string, unknown>).localStorage as
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
    const ls = (globalThis as Record<string, unknown>).localStorage as
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

// Shape normalization only: unknown or mistyped fields fall back to
// defaults. Legacy payloads stored headers as name/value pairs or raw
// text; raw lines keep their bytes as typed. Bounds and header syntax are
// validated by Rust on use.
function normalizeHeaderLines(raw: unknown): ReadonlyArray<string> {
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  if (typeof raw === "string") return raw.split("\n");
  if (raw !== null && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, value]) => `${name}: ${value}`);
  }
  return [];
}

function normalizeSettings(raw: unknown): DesktopSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return defaultSettings();
  const obj = raw as Record<string, unknown>;
  const defaults = defaultSettings();
  return {
    output_dir: typeof obj.output_dir === "string" && obj.output_dir !== "" ? obj.output_dir : null,
    output_format: (OUTPUT_FORMATS as ReadonlyArray<string>).includes(obj.output_format as string)
      ? (obj.output_format as DesktopSettings["output_format"])
      : defaults.output_format,
    compression: typeof obj.compression === "number" ? obj.compression : defaults.compression,
    max_width: typeof obj.max_width === "number" ? obj.max_width : null,
    max_height: typeof obj.max_height === "number" ? obj.max_height : null,
    retries: typeof obj.retries === "number" ? obj.retries : defaults.retries,
    network_profile: (NETWORK_PROFILES as ReadonlyArray<string>).includes(
      obj.network_profile as string,
    )
      ? (obj.network_profile as NetworkProfile)
      : defaults.network_profile,
    cache_dir: typeof obj.cache_dir === "string" && obj.cache_dir !== "" ? obj.cache_dir : null,
    headers: normalizeHeaderLines(obj.headers),
  };
}

// Load persisted settings, fail-closed to defaults on any unreadable
// payload. Shapes are normalized here; Rust revalidates on use.
export function loadSettings(): DesktopSettings {
  const raw = readStoredText();
  if (!raw) return defaultSettings();
  try {
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return defaultSettings();
  }
}

// Persist the raw settings as typed. Rust is the single validator and its
// typed rejection reason is surfaced by the caller; a rejected save shows
// its reason and persists nothing (fail closed, keeps the last good
// payload).
export function saveSettings(settings: DesktopSettings): Array<string> {
  try {
    writeStoredText(JSON.stringify(settings));
  } catch {
    return ["could not persist settings"];
  }
  return [];
}

export function resetSettings(): DesktopSettings {
  const settings = defaultSettings();
  saveSettings(settings);
  return settings;
}

// Native directory picker via the Tauri dialog plugin (`dialog:allow-open`).
// Returns the chosen directory or null when unavailable, denied, or
// cancelled. Never throws. Hosts without the dialog plugin reject, which
// maps to null (manual entry) below.
export async function pickDirectory(current: string | null): Promise<string | null> {
  try {
    const result = await invoke("plugin:dialog|open", {
      options: { directory: true, multiple: false, ...(current ? { defaultPath: current } : {}) },
    });
    return typeof result === "string" ? result : null;
  } catch {
    return null;
  }
}
