// Job history ledger (todo 5.2): last-20 jobs with their full addresses.
//
// Pure and host-neutral: no host globals, no I/O. Hosts inject a
// key-value store (localStorage, sessionStorage, or an in-memory map) and
// render through `view.ts`. Each entry keeps the full source address plus
// its origin for display. History never leaves the device; clearing removes
// every entry.
//
// This module is erasable-syntax-only TypeScript so
// `scripts/sync-web-js.mjs` can mirror it to `history.js` exactly like the
// other shared-ui modules. Keep it framework-free: shared UI stays vanilla.

export const HISTORY_MAX = 20;

export const HISTORY_KEY_WEBSITE = "dezoomify.history.v2";

export const HISTORY_KEY_DESKTOP = "dezoomify.desktop.history.v2";

export const HISTORY_KEY_EXTENSION = "dezoomify.ext.history.v2";

export interface HistoryEntry {
  origin: string;
  url: string;
  width?: number;
  height?: number;
  format?: string;
  at: number;
}

export interface HistoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Origin (`scheme://host[:port]`, lowercased host) derived from a source address. Empty when unparseable or non-http(s). */
export function historyOriginOf(url: string): string {
  try {
    const parsed = new URL(String(url ?? "").trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    const host = parsed.hostname.toLowerCase();
    if (host === "") return "";
    const defaultPort = parsed.protocol === "https:" ? "443" : "80";
    const port = parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : "";
    return `${parsed.protocol}//${host}${port}`;
  } catch {
    return "";
  }
}

export interface HistoryDetails {
  width?: number;
  height?: number;
  format?: string;
  at?: number;
}

/** Build one ledger entry keeping the full source address. */
export function toHistoryEntry(url: string, details: HistoryDetails): HistoryEntry | null {
  const origin = historyOriginOf(url);
  if (origin === "") return null;
  const trimmed = String(url ?? "").trim();
  if (trimmed === "" || trimmed.length > 2048) return null;
  const entry: HistoryEntry = {
    origin,
    url: trimmed,
    at: typeof details.at === "number" && Number.isFinite(details.at) ? Math.floor(details.at) : Date.now(),
  };
  if (typeof details.width === "number" && Number.isFinite(details.width) && details.width > 0) {
    entry.width = Math.floor(details.width);
  }
  if (typeof details.height === "number" && Number.isFinite(details.height) && details.height > 0) {
    entry.height = Math.floor(details.height);
  }
  if (typeof details.format === "string" && details.format.trim() !== "") {
    entry.format = details.format.trim().slice(0, 32);
  }
  return entry;
}

/** Insert one entry at the front, deduped by full address, capped at HISTORY_MAX. */
export function pushHistory(entries: Array<HistoryEntry>, entry: HistoryEntry): Array<HistoryEntry> {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const kept = list.filter((item) => {
    if (!item || typeof item !== "object") return false;
    return !((item as HistoryEntry).url === entry.url);
  });
  kept.unshift(entry);
  return kept.slice(0, HISTORY_MAX);
}

function isValidEntry(raw: unknown): raw is HistoryEntry {
  if (!raw || typeof raw !== "object") return false;
  const entry = raw as Record<string, unknown>;
  if (typeof entry["origin"] !== "string" || (entry["origin"] as string) === "") return false;
  try {
    const parsed = new URL(entry["origin"] as string);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (typeof entry["url"] !== "string" || (entry["url"] as string).trim() === "") return false;
  try {
    const parsedUrl = new URL((entry["url"] as string).trim());
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (typeof entry["at"] !== "number" || !Number.isFinite(entry["at"] as number)) return false;
  for (const key of ["width", "height"] as const) {
    const value = entry[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || (value as number) <= 0)) {
      return false;
    }
  }
  if (entry["format"] !== undefined && typeof entry["format"] !== "string") return false;
  return true;
}

/** Parse stored JSON into validated entries (fail-closed: bad payloads yield an empty list). */
export function parseHistoryJson(text: string | null | undefined): Array<HistoryEntry> {
  if (typeof text !== "string" || text.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const out: Array<HistoryEntry> = [];
    for (const item of parsed) {
      if (isValidEntry(item)) {
        const entry: HistoryEntry = {
          origin: (item as HistoryEntry).origin,
          url: String((item as HistoryEntry).url).trim(),
          at: Math.floor((item as HistoryEntry).at),
        };
        const typed = item as HistoryEntry;
        if (typeof typed.width === "number") entry.width = Math.floor(typed.width);
        if (typeof typed.height === "number") entry.height = Math.floor(typed.height);
        if (typeof typed.format === "string") entry.format = typed.format;
        out.push(entry);
        if (out.length >= HISTORY_MAX) break;
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function serializeHistory(entries: Array<HistoryEntry>): string {
  const list = Array.isArray(entries) ? entries.slice(0, HISTORY_MAX) : [];
  return JSON.stringify(list);
}

/** Load validated history from a store. Never throws: storage errors yield an empty list. */
export function loadHistory(store: HistoryStore | null | undefined, key: string): Array<HistoryEntry> {
  if (!store || typeof store.getItem !== "function") return [];
  try {
    return parseHistoryJson(store.getItem(key));
  } catch {
    return [];
  }
}

/** Persist history to a store. Best-effort: storage errors are swallowed so jobs never break. */
export function saveHistory(
  store: HistoryStore | null | undefined,
  key: string,
  entries: Array<HistoryEntry>,
): void {
  if (!store || typeof store.setItem !== "function") return;
  try {
    store.setItem(key, serializeHistory(entries));
  } catch {
    // History persistence must never break a job.
  }
}

/** Remove all history from a store. Best-effort like the save path. */
export function clearHistory(store: HistoryStore | null | undefined, key: string): void {
  if (!store || typeof store.removeItem !== "function") return;
  try {
    store.removeItem(key);
  } catch {
    // Clearing must never throw.
  }
}
