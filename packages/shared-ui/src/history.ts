// Job history ledger: last-20 jobs with their full addresses.
//
// The implementation lives in `@dezoomify/app-model` (host-neutral, no host
// globals, no I/O); this module re-exports it so existing shared-UI
// consumers keep working. Hosts inject a key-value store (localStorage,
// sessionStorage, or an in-memory map) and render through `view.tsx`. Each
// entry keeps the full source address plus its origin for display. History
// never leaves the device; clearing removes every entry.
export {
  HISTORY_MAX,
  HISTORY_KEY_WEBSITE,
  HISTORY_KEY_DESKTOP,
  HISTORY_KEY_EXTENSION,
  historyOriginOf,
  toHistoryEntry,
  pushHistory,
  parseHistoryJson,
  serializeHistory,
  loadHistory,
  saveHistory,
  clearHistory,
} from "@dezoomify/app-model";
export type { HistoryDetails, HistoryEntry, HistoryStore } from "@dezoomify/app-model";
