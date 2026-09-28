import type {
  DiagnosticLevel,
  DiagnosticRecord,
  DiagnosticReport,
  DiagnosticValue,
  Snapshot,
} from "@dezoomify/wasm-bindings";
import { DEEP_LINK_SECRET_QUERY_KEYS } from "./source-url.ts";

export type { DiagnosticLevel, DiagnosticRecord, DiagnosticReport };
export type DiagnosticFields = Record<string, DiagnosticValue>;
export const DIAGNOSTIC_MAX_BYTES = 1024 * 1024;
export const DIAGNOSTIC_MAX_RECORDS = 1000;
const FIELD_LIMIT = 4096;
const MAX_FIELDS = 48;
const MAX_GROUPS = 16;
const SECRET =
  /authorization|cookie|password|secret|token|signature|api.?key|credential|(^|[._-])(auth|session|sig|key|policy)($|[._-])|^x-amz-|^x-goog-/i;
// JSON escaping and UTF-8 use at most six bytes per UTF-16 code unit.
const size = (value: unknown) => JSON.stringify(value).length * 6;

/** Preserve URL spelling (including escapes and semantic query parameters). */
export function redactDiagnosticText(value: string): string {
  return (
    value
      .replace(/(https?:\/\/)[^\s/@]+@/gi, "$1[redacted]@")
      .replace(/([?&#])([^=&#\s]+)=([^&#\s]*)/g, (all, sep, key) => {
        let decoded = key;
        try {
          decoded = decodeURIComponent(key);
        } catch {
          /* Keep malformed spelling. */
        }
        return SECRET.test(decoded) || DEEP_LINK_SECRET_QUERY_KEYS.has(decoded.toLowerCase())
          ? `${sep}${key}=[redacted]`
          : all;
      })
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/=._~-]+/gi, "$1 [redacted]")
      .replace(
        /\b(authorization|auth|cookie|passwd|password|secret|session(?:id|token)?|sid|ticket|token|signature|api[_-]?key)\s*[:=]\s*[^\s,;&#]+/gi,
        "$1=[redacted]",
      )
      .replace(/file:\/\/[^\s"'<>]+/gi, "[local file]")
      .replace(
        /(^|[\s"'(])(?:\/(?:home|Users|tmp|private|var)\/|[A-Z]:\\)[^\s"'<>)]*/g,
        "$1[local path]",
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal control characters.
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "")
  );
}

/** Flatten bounded facts; explicitly retain Error's non-enumerable properties. */
export function diagnosticFields(
  value: unknown,
  truncated: () => void = () => {},
): DiagnosticFields {
  const out: DiagnosticFields = {};
  const seen = new Set<unknown>();
  let remaining = 8192;
  function visit(key: string, item: unknown, depth: number): void {
    key = redactDiagnosticText(key).slice(0, 256);
    if (Object.keys(out).length >= MAX_FIELDS) {
      truncated();
      return;
    }
    if (item === undefined || item === null || typeof item === "function") return;
    if (SECRET.test(key) && !/header_names|credentials_present/.test(key)) {
      out[key] = "[redacted]";
      return;
    }
    if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) {
      out[key] = item;
    } else if (typeof item === "string") {
      const text = redactDiagnosticText(item);
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
        if (/^(output_dir|cache_dir|path|destination)$/i.test(child)) {
          visit(key ? `${key}.${child}` : child, "[local path]", depth + 1);
        } else visit(key ? `${key}.${child}` : child, next, depth + 1);
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
    report.outcome ? `Outcome: ${formatDiagnosticRecord(report.outcome)}` : "Outcome: running",
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
  observe(snapshot: Snapshot): void;
  finish(event: string, fields?: unknown): void;
  report(): DiagnosticReport;
}

/** No clocks, console, storage, or engine decisions live in this recorder. */
export function createDiagnosticRecorder(options: {
  id: string;
  now(): number;
  context?: unknown;
  sink?(record: DiagnosticRecord): void;
}): DiagnosticRecorder {
  const started = options.now();
  const state: DiagnosticReport = {
    schema_version: 1,
    id: redactDiagnosticText(options.id).slice(0, 128),
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
  let selection = "";
  let decision: number | undefined;
  const sizes: number[] = [];
  const clean = (value: unknown) =>
    diagnosticFields(value, () => {
      state.truncated_fields++;
    });
  const make = (level: DiagnosticLevel, event: string, fields?: unknown): DiagnosticRecord => ({
    sequence: ++sequence,
    elapsed_ms: Math.max(0, options.now() - started),
    level,
    event: redactDiagnosticText(event).slice(0, 128),
    fields: clean(fields),
  });
  function count(name: string, value = 1): void {
    if (!Number.isFinite(value)) return;
    name = redactDiagnosticText(name).slice(0, 128);
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
      recordBytes -= sizes.shift()!;
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
  function observe(snapshot: Snapshot): void {
    state.counters.tiles_completed = snapshot.progress.completed;
    if (snapshot.progress.total != null) state.counters.tiles_total = snapshot.progress.total;
    const next = `${snapshot.lifecycle}:${snapshot.paused}`;
    if (next !== phase) {
      phase = next;
      record("info", "phase", {
        phase: snapshot.lifecycle,
        paused: snapshot.paused,
        revision: snapshot.revision,
      });
    }
    const chosen = snapshot.selection;
    const entry = chosen.catalog?.entries?.[chosen.image ?? -1];
    const image = entry?.kind === "image" ? entry : undefined;
    const level = image?.levels?.[chosen.level ?? -1];
    const key = `${image?.format}:${chosen.image}:${chosen.level}:${level?.size?.width}:${level?.size?.height}`;
    if (image && key !== selection) {
      selection = key;
      const largest = image.levels.reduce(
        (best, candidate) =>
          (candidate.size?.width ?? 0) * (candidate.size?.height ?? 0) >
          (best?.width ?? 0) * (best?.height ?? 0)
            ? candidate.size
            : best,
        level?.size,
      );
      const facts = {
        format: image.format,
        image: chosen.image,
        level: chosen.level,
        levels: chosen.level_count,
        title: image.title,
        width: level?.size?.width,
        height: level?.size?.height,
        maximum_width: largest?.width,
        maximum_height: largest?.height,
        tile_size: level?.tileSize,
        source_kind: image.sourceKind,
      };
      context({ selection: facts });
      record("info", "selection", facts);
    }
    if (snapshot.decision && snapshot.decision.generation !== decision) {
      decision = snapshot.decision.generation;
      record("info", "partial-decision", {
        generation: decision,
        missing: snapshot.decision.missing.length,
      });
    }
    if (snapshot.terminal)
      finish(snapshot.terminal.type, {
        ...snapshot.terminal,
        output: snapshot.output,
        revision: snapshot.revision,
      });
  }
  function finish(event: string, fields?: unknown): void {
    if (state.outcome) return;
    record(event.endsWith("failed") ? "error" : "info", event, fields);
    state.outcome = make(event.endsWith("failed") ? "error" : "info", event, fields);
  }
  context(options.context);
  return { record, context, count, observe, finish, report: () => boundDiagnosticReport(state) };
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
  while (size(result) > DIAGNOSTIC_MAX_BYTES && Object.keys(result.context).length > 0) {
    delete result.context[Object.keys(result.context).at(-1)!];
    result.truncated_fields++;
  }
  return result;
}
