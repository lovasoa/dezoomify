// Shared job history ledger: last-20 jobs with their full addresses.
// Pure and host-neutral: hosts inject a key-value store (localStorage,
// sessionStorage, or an in-memory map) and a clock. History never leaves the
// device. Products share recording, enrichment, and removal through createHistory.
//
// Entries keep the full source address plus its origin for display. Only
// http(s) addresses are kept; everything else is dropped fail-closed.

import type {
  Error as JobError,
  Output,
  Progress,
  SavedOutput,
  SavedOutputState,
} from "@dezoomify/wasm-bindings";
import { causeOf, isJobError } from "./failure.ts";

export const HISTORY_MAX = 20;

export type HistoryStatus =
  | "started"
  | "completed"
  | "partial"
  | "preview"
  | "failed"
  | "cancelled";

export const HISTORY_KEY_WEBSITE = "dezoomify.history.v2";

export const HISTORY_KEY_DESKTOP = "dezoomify.desktop.history.v2";

export interface HistoryEntry {
  origin: string;
  url: string;
  width?: number;
  height?: number;
  format?: string;
  title?: string;
  status?: HistoryStatus;
  savedOutput?: SavedOutput;
  at: number;
}

/** Ephemeral file state never becomes a persisted job outcome. */
export interface HistoryRow extends HistoryEntry {
  outputState?: SavedOutputState | "checking" | "unavailable";
  opening?: boolean;
  outputError?: JobError;
}

export interface HistoryOutputs {
  inspect(saved: SavedOutput): Promise<SavedOutputState>;
  open(saved: SavedOutput): Promise<void>;
  forget(saved: SavedOutput): Promise<void>;
  onChange(): void;
}

export interface HistoryStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Origin (`scheme://host[:port]`, lowercased host) for a source address. Empty when unparseable or non-http(s). */
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
  title?: string;
  status?: HistoryStatus;
  savedOutput?: SavedOutput;
  /** Host clock reading for the entry; the ledger itself never reads a clock. */
  at: number;
}

function savedOutputOf(raw: unknown): SavedOutput | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const value = raw as SavedOutput;
  if (
    typeof value.id !== "string" ||
    !value.id ||
    value.id.length > 128 ||
    typeof value.filename !== "string" ||
    !value.filename ||
    value.filename.length > 512
  )
    return undefined;
  return { id: value.id, filename: value.filename };
}

function outputError(error: unknown): JobError {
  return isJobError(error) ? error : { kind: "internal", detail: String(error).slice(0, 512) };
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
    at: Math.floor(details.at),
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
  if (typeof details.title === "string" && details.title.trim() !== "") {
    entry.title = details.title.trim().slice(0, 512);
  }
  if (details.status) entry.status = details.status;
  const saved = savedOutputOf(details.savedOutput);
  if (saved) entry.savedOutput = saved;
  return entry;
}

/** Insert one entry at the front, deduped by full address, capped at HISTORY_MAX. */
export function pushHistory(
  entries: Array<HistoryEntry>,
  entry: HistoryEntry,
): Array<HistoryEntry> {
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
  if (typeof entry.origin !== "string" || (entry.origin as string) === "") return false;
  try {
    const parsed = new URL(entry.origin as string);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (typeof entry.url !== "string" || (entry.url as string).trim() === "") return false;
  try {
    const parsedUrl = new URL((entry.url as string).trim());
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (
    typeof entry.at !== "number" ||
    !Number.isFinite(entry.at) ||
    Number.isNaN(new Date(entry.at).getTime())
  )
    return false;
  for (const key of ["width", "height"] as const) {
    const value = entry[key];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || (value as number) <= 0)
    ) {
      return false;
    }
  }
  if (entry.format !== undefined && typeof entry.format !== "string") return false;
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
        if (typeof typed.title === "string") entry.title = typed.title.trim().slice(0, 512);
        const saved = savedOutputOf(typed.savedOutput);
        if (saved) entry.savedOutput = saved;
        if (
          ["started", "completed", "partial", "preview", "failed", "cancelled"].includes(
            typed.status ?? "",
          )
        ) {
          entry.status = typed.status;
        }
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
export function loadHistory(
  store: HistoryStore | null | undefined,
  key: string,
): Array<HistoryEntry> {
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

/** A local ledger shared by products. Updates never resurrect removed or replaced entries. */
export function createHistory(
  store: HistoryStore | undefined,
  key: string,
  now: () => number,
  outputs?: HistoryOutputs,
) {
  let entries = loadHistory(store, key);
  const files = new Map<string, Pick<HistoryRow, "outputState" | "opening" | "outputError">>();
  let refreshing: Promise<void> | undefined;
  const contains = (id: string) => entries.some((entry) => entry.savedOutput?.id === id);
  function persist(previous: HistoryEntry[]): void {
    saveHistory(store, key, entries);
    for (const entry of previous) {
      const saved = entry.savedOutput;
      if (saved && !contains(saved.id)) {
        files.delete(saved.id);
        void Promise.resolve()
          .then(() => outputs?.forget(saved))
          .catch(() => {});
      }
    }
  }
  function update(entry: HistoryEntry | null, details: Partial<HistoryDetails>): void {
    if (!entry) return;
    const index = entries.findIndex((item) => item.url === entry.url && item.at === entry.at);
    if (index < 0) return;
    const previous = entries[index];
    const next = toHistoryEntry(previous.url, { ...previous, ...details, at: previous.at });
    if (
      !next ||
      !(Object.keys(next) as Array<keyof HistoryEntry>).some((field) =>
        field === "savedOutput"
          ? next.savedOutput?.id !== previous.savedOutput?.id ||
            next.savedOutput?.filename !== previous.savedOutput?.filename
          : next[field] !== previous[field],
      )
    )
      return;
    const old = entries;
    entries = entries.map((item, i) => (i === index ? next : item));
    persist(old);
  }
  return {
    entries: (): HistoryRow[] =>
      entries.map((entry) => ({
        ...entry,
        ...(entry.savedOutput ? files.get(entry.savedOutput.id) : {}),
      })),
    start(url: string): HistoryEntry | null {
      const entry = toHistoryEntry(url, { at: now(), status: "started" });
      if (entry) {
        const previous = entries;
        entries = pushHistory(entries, entry);
        persist(previous);
      }
      return entry;
    },
    update,
    progress(entry: HistoryEntry | null, progress: Progress): void {
      update(entry, {
        ...(progress.title ? { title: progress.title } : {}),
        ...(progress.selected
          ? { width: progress.selected.width, height: progress.selected.height }
          : {}),
      });
    },
    complete(entry: HistoryEntry | null, output: Output, savedOutput?: SavedOutput | null): void {
      update(entry, {
        status:
          output.disposition === "display-only"
            ? "preview"
            : output.missing.length === 0
              ? "completed"
              : "partial",
        ...(output.canvas ? { width: output.canvas.width, height: output.canvas.height } : {}),
        format: output.format,
        ...(savedOutput ? { savedOutput } : {}),
      });
    },
    remove(entry: HistoryEntry): void {
      const previous = entries;
      entries = entries.filter((item) => item.url !== entry.url || item.at !== entry.at);
      persist(previous);
    },
    clear(): void {
      const previous = entries;
      entries = [];
      persist(previous);
      clearHistory(store, key);
    },
    /** At most two independent checks; callers render first and never await this in the job path. */
    refresh(): Promise<void> {
      const provider = outputs;
      if (!provider) return Promise.resolve();
      if (refreshing) return refreshing;
      const checked = new Set<string>();
      function next() {
        const saved = entries
          .map((entry) => entry.savedOutput)
          .find((saved) => saved && !checked.has(saved.id));
        if (saved) checked.add(saved.id);
        return saved;
      }
      const worker = async () => {
        for (let saved = next(); saved; saved = next()) {
          if (!files.has(saved.id)) files.set(saved.id, { outputState: "checking" });
          const before = files.get(saved.id);
          try {
            const outputState = await provider.inspect(saved);
            if (contains(saved.id) && files.get(saved.id) === before)
              files.set(saved.id, { ...files.get(saved.id), outputState, outputError: undefined });
          } catch (error) {
            if (contains(saved.id) && files.get(saved.id) === before)
              files.set(saved.id, {
                ...files.get(saved.id),
                outputState: "unavailable",
                outputError: outputError(error),
              });
          }
          provider.onChange();
        }
      };
      refreshing = Promise.all([worker(), worker()])
        .then(() => {})
        .finally(() => {
          refreshing = undefined;
        });
      return refreshing;
    },
    async open(entry: HistoryEntry): Promise<void> {
      const saved = entry.savedOutput;
      if (!outputs || !saved || !contains(saved.id) || files.get(saved.id)?.opening) return;
      files.set(saved.id, { ...files.get(saved.id), opening: true, outputError: undefined });
      outputs.onChange();
      try {
        await outputs.open(saved);
        if (contains(saved.id)) files.set(saved.id, { outputState: "available" });
      } catch (error) {
        if (contains(saved.id)) {
          const state = files.get(saved.id);
          files.set(
            saved.id,
            isJobError(error) && causeOf(error).kind === "output-not-found"
              ? { outputState: "deleted" }
              : {
                  ...state,
                  outputState:
                    !state?.outputState || state.outputState === "checking"
                      ? "unavailable"
                      : state.outputState,
                  opening: false,
                  outputError: outputError(error),
                },
          );
        }
      }
      outputs.onChange();
    },
  };
}
