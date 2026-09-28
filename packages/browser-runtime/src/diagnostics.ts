import {
  createDiagnosticRecorder,
  type DiagnosticRecorder,
  type DiagnosticReport,
  formatDiagnosticRecord,
} from "@dezoomify/app-model";

let sequence = 0;
declare const __DEZOOMIFY_VERSION__: string;
const completed: DiagnosticReport[] = [];

/** One recorder per product attempt, allocated before service validation. */
export function createAttemptDiagnostics(
  product: string,
  version = typeof __DEZOOMIFY_VERSION__ === "string" ? __DEZOOMIFY_VERSION__ : "development",
): DiagnosticRecorder {
  const id = `${product}-${Date.now().toString(36)}-${++sequence}`;
  return createDiagnosticRecorder({
    id,
    now: () => performance.now(),
    context: {
      product,
      version,
      protocol: "2.0",
      build: import.meta.url,
      user_agent: typeof navigator === "undefined" ? undefined : navigator.userAgent,
      platform: typeof navigator === "undefined" ? undefined : navigator.platform,
    },
    sink(record) {
      if (record.level === "debug" || record.level === "trace") return;
      console[record.level](`[${id}] ${formatDiagnosticRecord(record)}`);
    },
  });
}

export async function copyDiagnosticText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  try {
    area.select();
    if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
  } finally {
    area.remove();
  }
}

export function retainDiagnostics(recorder: DiagnosticRecorder): void {
  retainDiagnosticReport(recorder.report());
}

export function retainDiagnosticReport(report: DiagnosticReport): void {
  completed.push(report);
  while (completed.length > 10 || JSON.stringify(completed).length * 6 > 10 * 1024 * 1024)
    completed.shift();
}

export function recentDiagnosticReports(): DiagnosticReport[] {
  return structuredClone(completed);
}

/** Saving diagnostics is a distinct explicit user action, never a job save. */
export function saveDiagnosticReport(report: DiagnosticReport): void {
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `dezoomify-${report.id}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
