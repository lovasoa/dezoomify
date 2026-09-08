// GENERATED from packages/shared-ui/src/history.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/shared-ui/src/history.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

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

/** Origin (`scheme://host[:port]`, lowercased host) derived from a source address. Empty when unparseable or non-http(s). */
export function historyOriginOf(url        )         {
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

/** Build one ledger entry keeping the full source address. */
export function toHistoryEntry(url        , details                )                      {
  const origin = historyOriginOf(url);
  if (origin === "") return null;
  const trimmed = String(url ?? "").trim();
  if (trimmed === "" || trimmed.length > 2048) return null;
  const entry               = {
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
export function pushHistory(entries                     , entry              )                      {
  const list = Array.isArray(entries) ? entries.slice() : [];
  const kept = list.filter((item) => {
    if (!item || typeof item !== "object") return false;
    return !((item                ).url === entry.url);
  });
  kept.unshift(entry);
  return kept.slice(0, HISTORY_MAX);
}

function isValidEntry(raw         )                      {
  if (!raw || typeof raw !== "object") return false;
  const entry = raw                           ;
  if (typeof entry["origin"] !== "string" || (entry["origin"]          ) === "") return false;
  try {
    const parsed = new URL(entry["origin"]          );
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (typeof entry["url"] !== "string" || (entry["url"]          ).trim() === "") return false;
  try {
    const parsedUrl = new URL((entry["url"]          ).trim());
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") return false;
  } catch {
    return false;
  }
  if (typeof entry["at"] !== "number" || !Number.isFinite(entry["at"]          )) return false;
  for (const key of ["width", "height"]         ) {
    const value = entry[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || (value          ) <= 0)) {
      return false;
    }
  }
  if (entry["format"] !== undefined && typeof entry["format"] !== "string") return false;
  return true;
}

/** Parse stored JSON into validated entries (fail-closed: bad payloads yield an empty list). */
export function parseHistoryJson(text                           )                      {
  if (typeof text !== "string" || text.trim() === "") return [];
  try {
    const parsed          = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    const out                      = [];
    for (const item of parsed) {
      if (isValidEntry(item)) {
        const entry               = {
          origin: (item                ).origin,
          url: String((item                ).url).trim(),
          at: Math.floor((item                ).at),
        };
        const typed = item                ;
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

export function serializeHistory(entries                     )         {
  const list = Array.isArray(entries) ? entries.slice(0, HISTORY_MAX) : [];
  return JSON.stringify(list);
}

/** Load validated history from a store. Never throws: storage errors yield an empty list. */
export function loadHistory(store                                 , key        )                      {
  if (!store || typeof store.getItem !== "function") return [];
  try {
    return parseHistoryJson(store.getItem(key));
  } catch {
    return [];
  }
}

/** Persist history to a store. Best-effort: storage errors are swallowed so jobs never break. */
export function saveHistory(
  store                                 ,
  key        ,
  entries                     ,
)       {
  if (!store || typeof store.setItem !== "function") return;
  try {
    store.setItem(key, serializeHistory(entries));
  } catch {
    // History persistence must never break a job.
  }
}

/** Remove all history from a store. Best-effort like the save path. */
export function clearHistory(store                                 , key        )       {
  if (!store || typeof store.removeItem !== "function") return;
  try {
    store.removeItem(key);
  } catch {
    // Clearing must never throw.
  }
}
