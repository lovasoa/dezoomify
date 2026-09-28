import { type DiagnosticReport, formatDiagnosticReport } from "@dezoomify/app-model";
import { useState } from "react";
import { t } from "./i18n.ts";
import type { ViewCallbacks } from "./view-types.ts";

export function diagnosticIssueUrl(report: DiagnosticReport): string {
  const lines = [
    "### Diagnostics",
    `Report: ${report.id}`,
    `Outcome: ${report.outcome?.event ?? "running"}`,
    ...["input", "effective_input", "product", "version"].map(
      (key) => `${key}: ${report.context[key] ?? "unknown"}`,
    ),
    ...Object.entries(report.outcome?.fields ?? {}).map(([key, value]) => `${key}: ${value}`),
    ...report.failures.map(
      ({ count, first }) => `${count} × ${first.event}: ${JSON.stringify(first.fields)}`,
    ),
    ...Object.entries(report.context).map(([key, value]) => `${key}: ${value}`),
  ];
  const params = new URLSearchParams({ title: "Dezoomify job report", body: "" });
  let body = "";
  for (const line of lines) {
    const next = `${body}${line}\n`;
    params.set("body", next);
    if (params.toString().length <= 7000) body = next;
  }
  params.set("body", body);
  return `https://github.com/lovasoa/dezoomify/issues/new?${params}`;
}

export function DiagnosticDetails({
  report,
  callbacks,
}: {
  report: DiagnosticReport;
  callbacks: ViewCallbacks;
}) {
  const [loaded, setLoaded] = useState<DiagnosticReport>();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [loadFailed, setLoadFailed] = useState(false);
  const shown = loaded ?? report;
  async function load(): Promise<DiagnosticReport> {
    if (!callbacks.onLoadDiagnostics) return report;
    try {
      const result = await callbacks.onLoadDiagnostics();
      setLoaded(result);
      setLoadFailed(false);
      return result;
    } catch {
      setLoadFailed(true);
      return report;
    }
  }
  return (
    <details
      className="dz-details"
      onToggle={(event) => {
        if (event.currentTarget.open) void load();
      }}
    >
      <summary className="dz-summary">{t("view.job.techDetails")}</summary>
      <div className="dz-actions-row">
        {callbacks.onCopyDiagnostics ? (
          <button
            type="button"
            className="dz-btn-secondary"
            id="dz-btn-copy-diagnostics"
            onClick={async () => {
              try {
                await callbacks.onCopyDiagnostics?.(formatDiagnosticReport(await load()));
                setCopyState("copied");
              } catch {
                setCopyState("failed");
              }
            }}
          >
            {t("desktop.copy.diagnostics")}
          </button>
        ) : null}
        {callbacks.onSaveDiagnostics ? (
          <button
            type="button"
            className="dz-btn-secondary"
            onClick={async () => {
              try {
                await callbacks.onSaveDiagnostics?.(await load());
              } catch {
                setLoadFailed(true);
              }
            }}
          >
            {t("view.diagnostics.save")}
          </button>
        ) : null}
        <a href={diagnosticIssueUrl(shown)} target="_blank" rel="noopener">
          {t("view.fail.reportBug")}
        </a>
      </div>
      {copyState === "copied" ? <p role="status">{t("desktop.copy.copied")}</p> : null}
      {copyState === "failed" ? <p role="alert">{t("view.diagnostics.copyFailed")}</p> : null}
      {loadFailed ? <p role="alert">{t("view.diagnostics.loadFailed")}</p> : null}
      <pre className="dz-diagnostics dz-log" id="dz-job-diagnostics">
        {formatDiagnosticReport(shown)}
      </pre>
    </details>
  );
}
