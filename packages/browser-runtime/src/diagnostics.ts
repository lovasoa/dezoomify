import {
  createDiagnosticRecorder,
  type DiagnosticRecorder,
  type DiagnosticReport,
  formatDiagnosticRecord,
} from "../../shared-ui/src/diagnostics.ts";

let sequence = 0;
declare const __DEZOOMIFY_VERSION__: string;

/** One recorder per product attempt, allocated before input validation. */
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
