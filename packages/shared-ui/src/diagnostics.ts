import type {
  DiagnosticLevel,
  DiagnosticRecord,
  DiagnosticReport,
  DiagnosticValue,
  Progress,
} from "@dezoomify/wasm-bindings";

export type { DiagnosticLevel, DiagnosticRecord, DiagnosticReport };
export type DiagnosticFields = Record<string, DiagnosticValue>;
export const DIAGNOSTIC_MAX_BYTES = 1024 * 1024;
export const DIAGNOSTIC_MAX_RECORDS = 1000;
const FIELD_LIMIT = 4096;
const MAX_FIELDS = 48;
const MAX_GROUPS = 16;
// JSON escaping and UTF-8 use at most six bytes per UTF-16 code unit.
const size = (value: unknown) => JSON.stringify(value).length * 6;

/** Flatten bounded facts; explicitly retain Error's non-enumerable properties. */
export function diagnosticFields(
  value: unknown,
  truncated: () => void = () => {},
): DiagnosticFields {
  const out: DiagnosticFields = {};
  const seen = new Set<unknown>();
  let remaining = 8192;
  function visit(key: string, item: unknown, depth: number): void {
    key = key.slice(0, 256);
    if (Object.keys(out).length >= MAX_FIELDS) {
      truncated();
      return;
    }
    if (item === undefined || item === null || typeof item === "function") return;
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      out[key] = item;
    } else if (typeof item === "string") {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal control characters.
      const text = item.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");
      const limit = Math.max(0, Math.min(FIELD_LIMIT, remaining));
      out[key] = text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
      remaining -= Math.min(limit, text.length);
      if (text.length > limit) truncated();
    } else if (typeof item === "object") {
      if (item instanceof ArrayBuffer || ArrayBuffer.isView(item)) return;
      if (seen.has(item) || depth > 3) {
        truncated();
        return;
      }
      seen.add(item);
      const entries =
        item instanceof Error
          ? Object.entries({
              ...item,
              name: item.name,
              message: item.message,
              cause: item.cause,
              stack: item.stack,
            })
          : Object.entries(item);
      for (const [child, next] of entries.slice(0, MAX_FIELDS)) {
        if (/^(contents|body|pixels|tile_bytes|bytes)$/i.test(child) && typeof next !== "number")
          continue;
        visit(key ? `${key}.${child}` : child, next, depth + 1);
      }
      if (entries.length > MAX_FIELDS) truncated();
    }
  }
  if (value && typeof value === "object") visit("", value, 0);
  else visit("message", value, 0);
  return out;
}

export function formatDiagnosticRecord(record: DiagnosticRecord): string {
  const facts = Object.entries(record.fields)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  return `+${(record.elapsed_ms / 1000).toFixed(3)}s ${record.event}${facts ? ` ${facts}` : ""}`;
}

export function formatDiagnosticReport(report: DiagnosticReport): string {
  const fields = (facts: DiagnosticFields) =>
    Object.entries(facts)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n");
  return [
    `Dezoomify diagnostics v${report.schema_version} · ${report.id}`,
    report.outcome
      ? `Outcome: ${formatDiagnosticRecord(report.outcome)}`
      : `Status: ${report.context.phase ?? "running"}`,
    fields(report.context),
    `Counts\n${fields(report.counters)}`,
    ...report.failures.map(
      (group) =>
        `Problem (${group.count} observations): ${formatDiagnosticRecord(group.first)}${group.count > 1 ? `\nLatest: ${formatDiagnosticRecord(group.last)}` : ""}`,
    ),
    `Timeline\n${report.records.map(formatDiagnosticRecord).join("\n")}`,
    `Omitted records: ${report.omitted_records}; truncated fields: ${report.truncated_fields}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export interface DiagnosticRecorder {
  record(level: DiagnosticLevel, event: string, fields?: unknown): void;
  context(fields: unknown): void;
  count(name: string, value?: number): void;
  observe(progress: Progress): void;
  finish(event: string, fields?: unknown): void;
  report(): DiagnosticReport;
}

/** No clocks, console, storage, or job decisions live in this recorder. */
export function createDiagnosticRecorder(options: {
  id: string;
  now(): number;
  context?: unknown;
  sink?(record: DiagnosticRecord): void;
}): DiagnosticRecorder {
  const started = options.now();
  const state: DiagnosticReport = {
    schema_version: 1,
    id: options.id.slice(0, 128),
    context: {},
    counters: {},
    failures: [],
    records: [],
    outcome: undefined,
    omitted_records: 0,
    truncated_fields: 0,
  };
  let sequence = 0;
  let recordBytes = 0;
  let phase = "";
  const sizes: number[] = [];
  const clean = (value: unknown) =>
    diagnosticFields(value, () => {
      state.truncated_fields++;
    });
  const make = (level: DiagnosticLevel, event: string, fields?: unknown): DiagnosticRecord => ({
    sequence: ++sequence,
    elapsed_ms: Math.max(0, options.now() - started),
    level,
    event: event.slice(0, 128),
    fields: clean(fields),
  });
  function count(name: string, value = 1): void {
    if (!Number.isFinite(value)) return;
    name = name.slice(0, 128);
    if (!(name in state.counters) && Object.keys(state.counters).length >= 48) return;
    state.counters[name] = (state.counters[name] ?? 0) + value;
  }
  function retain(record: DiagnosticRecord): void {
    // Protect bounded context, first/last problem samples, and outcome outside
    // the rolling timeline, but inside the total serialized report budget.
    const bytes = size(record);
    while (
      state.records.length &&
      (state.records.length >= DIAGNOSTIC_MAX_RECORDS || recordBytes + bytes > 256 * 1024)
    ) {
      state.records.shift();
      recordBytes -= sizes.shift() ?? 0;
      state.omitted_records++;
    }
    if (bytes <= 256 * 1024) {
      state.records.push(record);
      sizes.push(bytes);
      recordBytes += bytes;
    } else state.omitted_records++;
  }
  function record(level: DiagnosticLevel, event: string, fields?: unknown): void {
    try {
      const entry = make(level, event, fields);
      let repeated = false;
      if (level === "warn" || level === "error") {
        const f = entry.fields;
        const key = [entry.event, f.code, f.transport, f.http, f.purpose].join("|");
        const group = state.failures.find((candidate) => candidate.key === key);
        if (group) {
          group.count++;
          group.last = entry;
          repeated = true;
        } else if (state.failures.length < MAX_GROUPS)
          state.failures.push({ key, count: 1, first: entry, last: entry });
        else count("other_problem_observations");
      }
      // Trace successes count without evicting discovery or failures. An
      // explicit trace console sink can still print every observation.
      if (level !== "trace" && !repeated) retain(entry);
      if (!repeated) options.sink?.(entry);
    } catch {
      /* Diagnostics cannot fail the job, even if a sink throws. */
    }
  }
  function context(fields: unknown): void {
    const merged = { ...state.context, ...clean(fields) };
    state.context = Object.fromEntries(Object.entries(merged).slice(0, 128));
  }
  function observe(progress: Progress): void {
    context({ phase: progress.phase });
    state.counters.tiles_completed = progress.completed;
    if (progress.total != null) state.counters.tiles_total = progress.total;
    if (phase !== progress.phase) {
      phase = progress.phase;
      record("info", "phase", { phase });
    }
    if (progress.selected)
      context({
        selection: progress.selected,
        maximum: progress.maximum,
        title: progress.title,
        format: progress.source_format,
      });
  }
  function finish(event: string, fields?: unknown): void {
    if (state.outcome) return;
    record(event.endsWith("failed") ? "error" : "info", event, fields);
    state.outcome = make(event.endsWith("failed") ? "error" : "info", event, fields);
  }
  context(options.context);
  return {
    record,
    context,
    count,
    observe,
    finish,
    report: () => boundDiagnosticReport(state),
  };
}

/** Also apply the total budget after joining native and frontend context. */
export function boundDiagnosticReport(report: DiagnosticReport): DiagnosticReport {
  const result = JSON.parse(JSON.stringify(report)) as DiagnosticReport;
  while (size(result) > DIAGNOSTIC_MAX_BYTES && result.records.length) {
    result.records.shift();
    result.omitted_records++;
  }
  while (size(result) > DIAGNOSTIC_MAX_BYTES && result.failures.length > 1) {
    result.failures.pop();
    result.omitted_records++;
  }
  const context_entries = Object.entries(result.context);
  while (size(result) > DIAGNOSTIC_MAX_BYTES && context_entries.length > 0) {
    context_entries.pop();
    result.context = Object.fromEntries(context_entries);
    result.truncated_fields++;
  }
  return result;
}
