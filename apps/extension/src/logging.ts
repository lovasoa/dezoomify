/**
 * Structured interaction logging shared by the extension contexts.
 *
 * One line shape everywhere: `[<context>] [<code> ]<detail>`. The context
 * bracket is omitted for the default `background` context, the level is
 * carried by the console method, and an absent code is omitted.
 * Contexts are `background` (the coordinator/service worker), `job` (the
 * dedicated job tab), and `worker` (the WASM session worker). Interaction
 * milestones log at info, high-frequency per-tile/per-chunk detail at debug,
 * recoverable states at warn, and terminal failures at error. Logged URLs are
 * written in full; details are bounded.
 *
 * The module intentionally imports nothing so `background/index.ts` can inline
 * it into the classic Firefox artifact without resolving a module graph.
 */

export const LOG_LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
export type LogLevel = keyof typeof LOG_LEVELS;
export const LOG_MAX_CHARS = 500;
export const DEFAULT_LOG_CONTEXT = "background";

export interface LogEntry {
  context: string;
  level: LogLevel;
  code: string;
  detail: string;
  line: string;
}
export type LogSink = (entry: LogEntry) => void;

/** Bound a logged detail to one line-friendly string. */
export function formatDetail(detail: unknown): string {
  if (detail === undefined || detail === null) return "";
  if (typeof detail === "string") return detail;
  try { if (typeof detail === "object") return JSON.stringify(detail) ?? ""; } catch { /* fall through */ }
  return String(detail);
}

export interface Logger {
  log(level: LogLevel, code?: string, detail?: unknown): void;
  debug(code?: string, detail?: unknown): void;
  info(code?: string, detail?: unknown): void;
  warn(code?: string, detail?: unknown): void;
  error(code?: string, detail?: unknown): void;
  setLevel(level: string | number): void;
  setSink(sink: unknown): void;
  levels: typeof LOG_LEVELS;
}

/**
 * @param {string} context short context name used in the line prefix
 * @param {{ level?: LogLevel | number, sink?: LogSink }} [options]
 */
export function createLogger(context: string, options: { level?: LogLevel | number; sink?: LogSink } = {}): Logger {
  const safeContext = typeof context === "string" && context ? context : "extension";
  const prefix = safeContext === DEFAULT_LOG_CONTEXT ? "" : `[${safeContext}]`;
  let level = typeof options.level === "number" ? options.level : LOG_LEVELS[options.level ?? "info"];
  let sink: LogSink | null = options.sink ?? null;

  function setLevel(next: string | number) {
    if (typeof next === "string" && next in LOG_LEVELS) level = LOG_LEVELS[next as LogLevel];
    else if (typeof next === "number" && Number.isFinite(next)) level = next;
  }
  function setSink(next: unknown) { sink = typeof next === "function" ? next as LogSink : null; }

  function log(levelName: LogLevel, code: string | undefined, detail: unknown = "") {
    try {
      const safeLevel: LogLevel = levelName in LOG_LEVELS ? levelName : "info";
      if (LOG_LEVELS[safeLevel] < level) return;
      const safeCode = typeof code === "string" ? code : "";
      let text = formatDetail(detail);
      if (text.length > LOG_MAX_CHARS) text = text.slice(0, LOG_MAX_CHARS) + "…";
      const line = [prefix, safeCode, text].filter(Boolean).join(" ");
      const entry: LogEntry = { context: safeContext, level: safeLevel, code: safeCode, detail: text, line };
      if (sink) { try { sink(entry); } catch {} }
      else { try { (globalThis.console as unknown as Record<string, ((line: string) => void) | undefined>)?.[safeLevel]?.(entry.line); } catch {} }
    } catch {}
  }

  return {
    log,
    debug: (code, detail) => log("debug", code, detail),
    info: (code, detail) => log("info", code, detail),
    warn: (code, detail) => log("warn", code, detail),
    error: (code, detail) => log("error", code, detail),
    setLevel,
    setSink,
    levels: LOG_LEVELS,
  };
}
