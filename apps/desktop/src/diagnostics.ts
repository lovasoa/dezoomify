// Desktop copy-diagnostics (todo 2.2 split from main.tsx).
// Provenance block plus the clipboard handoff. The snapshot arrives as plain
// data, so this module owns no job state. File move, no behavior change.
import { t } from "@dezoomify/shared-ui";
import { phaseFor } from "./errorCopy.ts";
import {
  PROTOCOL_MAX,
  PROTOCOL_MIN,
  PROTOCOL_VERSION,
} from "./desktopIntegration.ts";

// Desktop app version mirrors apps/desktop/package.json. Kept as a literal
// so the TS layer stays host-neutral (no JSON import, no I/O); bump both
// together. Used only for copy-diagnostics provenance, never for logic.
export const DESKTOP_APP_VERSION = "3.0.0";


// Copy-diagnostics provenance: typed error context, job and attempt ids, app
// and protocol versions, and the redacted source origin only. Never the full
// URL, credentials, or response content.
export interface DiagnosticsSnapshot {
  status: string;
  transport: string | null | undefined;
  jobId: string | null;
  attempt: string | undefined;
  sessionId: string;
  nativeTransport: string;
  error: {
    code: string;
    category: string;
    phase?: string;
    retryable: boolean;
    message: string;
    detail?: string;
  } | null;
  progress: { current: number; total: number } | undefined;
  origin: string;
}

export function buildCopyDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const error = snapshot.error;
  const lines = [
    `Status: ${snapshot.status}`,
    `Transport: ${snapshot.transport ?? snapshot.nativeTransport}`,
    `Job: ${snapshot.jobId ?? "none"}`,
    `Attempt: ${snapshot.attempt ?? "n/a"}`,
    `Session: ${snapshot.sessionId}`,
    `App: dezoomify-desktop ${DESKTOP_APP_VERSION}`,
    `Protocol: ${PROTOCOL_VERSION} (min ${PROTOCOL_MIN}, max ${PROTOCOL_MAX})`,
  ];
  if (error) {
    lines.push(`Code: ${error.code}`);
    lines.push(`Category: ${error.category}`);
    lines.push(`Phase: ${error.phase ?? phaseFor(error.code)}`);
    lines.push(`Retryable: ${String(error.retryable)}`);
    lines.push(`Message: ${error.message}`);
    if (error.detail) lines.push(`Detail: ${error.detail}`);
  }
  const progress = snapshot.progress;
  if (progress) lines.push(`Tiles: ${progress.current} of ${progress.total}`);
  lines.push(`Origin: ${snapshot.origin === "" ? "n/a" : snapshot.origin}`);
  return lines.join("\n");
}


export function handleCopyDiagnostics(buildText: () => string): void {
  const text = buildText();
  const done = () => {
    const btn = typeof document !== "undefined" ? document.getElementById("dz-btn-copy-diag") : null;
    if (btn) {
      btn.textContent = t("desktop.copy.copied");
      setTimeout(() => {
        try {
          if (btn.isConnected) btn.textContent = t("desktop.copy.diagnostics");
        } catch {
          // Button may be gone after re-render; ignore.
        }
      }, 2000);
    }
  };
  try {
    const nav = globalThis as Record<string, unknown>;
    const clipboard = nav["navigator"] as unknown as
      | { clipboard?: { writeText?: (text: string) => Promise<unknown> } }
      | undefined;
    if (clipboard?.clipboard?.writeText) {
      void (clipboard.clipboard.writeText(text) as Promise<unknown>).then(done, done);
      return;
    }
    if (typeof document !== "undefined") {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done();
    }
  } catch {
    // Copy failures stay silent; the technical-details section still shows
    // the same diagnostics for manual copying.
  }
}
