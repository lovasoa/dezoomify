// Desktop copy-diagnostics (todo 2.2 split from main.tsx).
// Provenance block plus the clipboard handoff. The snapshot arrives as plain
// data, so this module owns no job state. File move, no behavior change.
import { t } from "@dezoomify/shared-ui";
import { PROTOCOL_MAX, PROTOCOL_MIN, PROTOCOL_VERSION } from "./desktopIntegration.ts";

declare const __DEZOOMIFY_VERSION__: string;

export const DESKTOP_APP_VERSION =
  typeof __DEZOOMIFY_VERSION__ === "string" ? __DEZOOMIFY_VERSION__ : "0.0.0";

// Copy-diagnostics provenance: job and attempt ids, app and protocol
// versions, progress, and the redacted source origin only. The typed
// error context (url, engine block, trailing code line) comes from the
// shared renderer, which the caller prepends; it is never duplicated
// here. Never credentials or response content.
export interface DiagnosticsSnapshot {
  status: string;
  transport: string | null | undefined;
  jobId: string | null;
  attempt: string | undefined;
  sessionId: string;
  nativeTransport: string;
  progress: { current: number; total: number } | undefined;
  origin: string;
  outputActionError?: { action: "open" | "folder"; code: string };
}

export function buildCopyDiagnostics(snapshot: DiagnosticsSnapshot): string {
  const lines = [
    `Status: ${snapshot.status}`,
    `Transport: ${snapshot.transport ?? snapshot.nativeTransport}`,
    `Job: ${snapshot.jobId ?? "none"}`,
    `Attempt: ${snapshot.attempt ?? "n/a"}`,
    `Session: ${snapshot.sessionId}`,
    `App: dezoomify-desktop ${DESKTOP_APP_VERSION}`,
    `Protocol: ${PROTOCOL_VERSION} (min ${PROTOCOL_MIN}, max ${PROTOCOL_MAX})`,
  ];
  if (snapshot.outputActionError) {
    lines.push(`File action: ${snapshot.outputActionError.action}`);
    lines.push(`File action code: ${snapshot.outputActionError.code}`);
  }
  if (snapshot.progress)
    lines.push(`Tiles: ${snapshot.progress.current} of ${snapshot.progress.total}`);
  lines.push(`Origin: ${snapshot.origin === "" ? "n/a" : snapshot.origin}`);
  return lines.join("\n");
}

export function handleCopyDiagnostics(buildText: () => string): void {
  const text = buildText();
  const done = () => {
    const btn =
      typeof document !== "undefined"
        ? (document.getElementById("dz-btn-copy-diagnostics") ??
          document.getElementById("dz-btn-copy-diag"))
        : null;
    if (btn) {
      const iconButton = btn.id === "dz-btn-copy-diagnostics";
      if (iconButton) {
        btn.setAttribute("title", t("desktop.copy.copied"));
        btn.setAttribute("aria-label", t("desktop.copy.copied"));
      } else {
        btn.textContent = t("desktop.copy.copied");
      }
      setTimeout(() => {
        try {
          if (!btn.isConnected) return;
          if (iconButton) {
            btn.setAttribute("title", t("desktop.copy.diagnostics"));
            btn.setAttribute("aria-label", t("desktop.copy.diagnostics"));
          } else {
            btn.textContent = t("desktop.copy.diagnostics");
          }
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
