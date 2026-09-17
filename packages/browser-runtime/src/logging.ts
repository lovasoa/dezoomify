/**
 * Structured interaction logging shared by every product.
 *
 * One line shape everywhere: `[<context>] [<code> ]<detail>`. A context equal
 * to the configured default (background for the extension coordinator) omits
 * its bracket, the level is carried by the console method, and an absent code
 * is omitted. Interaction milestones log at info, high-frequency per-tile and
 * per-chunk detail at debug, recoverable states at warn, and terminal failures
 * at error. Logged URLs are written in full; details are bounded.
 *
 * The module imports nothing so hosts can inline it or bundle it in isolation
 * (the extension worker imports the `./logging` subpath, never the barrel).
 * Console output is the default sink; additional sinks observe every accepted
 * entry (the graphical products forward them into the job view's log).
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

export interface LoggerOptions {
  level?: LogLevel | number;
  /** Replaces the default console sink. */
  sink?: LogSink;
  /** Context whose bracket is omitted from the line. */
  defaultContext?: string;
}

export interface Logger {
  log(level: LogLevel, code?: string, detail?: unknown): void;
  debug(code?: string, detail?: unknown): void;
  info(code?: string, detail?: unknown): void;
  warn(code?: string, detail?: unknown): void;
  error(code?: string, detail?: unknown): void;
  setLevel(level: string | number): void;
  /** Replace every sink (console is restored when omitted/not a function). */
  setSink(sink: unknown): void;
  /** Observe accepted entries without displacing the console sink. */
  addSink(sink: LogSink): void;
  levels: typeof LOG_LEVELS;
}

export function createLogger(context: string, options: LoggerOptions = {}): Logger {
  const safeContext = typeof context === "string" && context ? context : "app";
  const defaultContext = options.defaultContext ?? DEFAULT_LOG_CONTEXT;
  const prefix = safeContext === defaultContext ? "" : `[${safeContext}]`;
  let level = typeof options.level === "number" ? options.level : LOG_LEVELS[options.level ?? "info"];
  const consoleSink: LogSink = (entry) => {
    try { (globalThis.console as unknown as Record<string, ((line: string) => void) | undefined>)?.[entry.level]?.(entry.line); } catch { /* console unavailable */ }
  };
  let sinks: LogSink[] = typeof options.sink === "function" ? [options.sink] : [consoleSink];

  function setLevel(next: string | number) {
    if (typeof next === "string" && next in LOG_LEVELS) level = LOG_LEVELS[next as LogLevel];
    else if (typeof next === "number" && Number.isFinite(next)) level = next;
  }
  function setSink(next: unknown) { sinks = typeof next === "function" ? [next as LogSink] : [consoleSink]; }
  function addSink(next: LogSink) { if (typeof next === "function") sinks.push(next); }

  function log(levelName: LogLevel, code: string | undefined, detail: unknown = "") {
    try {
      const safeLevel: LogLevel = levelName in LOG_LEVELS ? levelName : "info";
      if (LOG_LEVELS[safeLevel] < level) return;
      const safeCode = typeof code === "string" ? code : "";
      let text = formatDetail(detail);
      if (text.length > LOG_MAX_CHARS) text = text.slice(0, LOG_MAX_CHARS) + "…";
      const line = [prefix, safeCode, text].filter(Boolean).join(" ");
      const entry: LogEntry = { context: safeContext, level: safeLevel, code: safeCode, detail: text, line };
      for (const sink of sinks) {
        try { sink(entry); } catch { /* one sink must not stop the others */ }
      }
    } catch { /* logging must never break the caller */ }
  }

  return {
    log,
    debug: (code, detail) => log("debug", code, detail),
    info: (code, detail) => log("info", code, detail),
    warn: (code, detail) => log("warn", code, detail),
    error: (code, detail) => log("error", code, detail),
    setLevel,
    setSink,
    addSink,
    levels: LOG_LEVELS,
  };
}
