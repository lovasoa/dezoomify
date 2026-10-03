import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { useState } from "react";
import { type DiagnosticReport, diagnosticFields, formatDiagnosticReport } from "./diagnostics.ts";
import { plainMessageFor } from "./failure.ts";
import { t } from "./i18n.ts";
import type { ViewCallbacks } from "./view-types.ts";

export function diagnosticIssueUrl(report: DiagnosticReport, error?: JobError): string {
  const input = String(report.context.input ?? "unknown");
  const finalUrl =
    report.context.effective_input ??
    report.context.final_url ??
    [...report.records]
      .reverse()
      .find((record) => record.fields.url === input && record.fields.final_url)?.fields.final_url;
  let host = "unknown host";
  try {
    host = new URL(String(finalUrl ?? input)).host;
  } catch {
    /* Invalid input still deserves a report. */
  }
  const product = ["website", "extension", "desktop"].includes(String(report.context.product))
    ? String(report.context.product)
    : "website";
  const facts = error ? diagnosticFields(error) : (report.outcome?.fields ?? {});
  const message = error
    ? plainMessageFor(error, host)
    : String(
        facts.message ??
          facts["error.message"] ??
          report.outcome?.event ??
          "No error message available.",
      );
  const summary = Object.entries(facts)
    .filter(([key]) =>
      /(?:^|\.)(kind|status|transport|blocked_reason|reason|request|retry_after_ms|bytes_required|bytes_available|width|height)$/.test(
        key,
      ),
    )
    .map(([key, value]) => `${key}: ${value}`);
  const intro = [
    input,
    ...(finalUrl && finalUrl !== input ? [`Resolved URL: ${finalUrl}`] : []),
    "",
    ...message.split("\n").map((line) => `> ${line}`),
    "",
    `I tried to download this zoomable image using the Dezoomify ${product}${report.context.version ? ` (${report.context.version})` : ""}, but the attempt failed.`,
    ...summary.map((line) => `- ${line}`),
    "",
    "<!-- Please add what you expected, what happened, and any steps needed to reproduce the problem. -->",
    "",
  ].join("\n");
  const failures = report.failures
    .map(({ count, first }) => `${count} × ${first.event}: ${JSON.stringify(first.fields)}`)
    .join("\n");
  const details = `Error\n${JSON.stringify(error ?? facts, null, 2)}\n\n${failures}\n\n${formatDiagnosticReport(report)}`;
  // A longer fence keeps server previews containing backticks inside the block.
  const fence = "`".repeat(
    Math.max(3, ...Array.from(details.matchAll(/`+/g), (match) => match[0].length + 1)),
  );
  const labels = new Set(["unconfirmed", product]);
  for (const [key, kind] of Object.entries(facts)) {
    if (!/(?:^|\.)kind$/.test(key)) continue;
    switch (kind) {
      case "http-error":
      case "rate-limited":
      case "timeout":
      case "network-failure":
      case "policy-denied":
      case "bad-redirect":
      case "redirect-limit":
      case "size-limit":
      case "proxy-budget-exceeded":
      case "proxy-error":
        labels.add("transport");
        break;
      case "no-image-found":
      case "malformed-metadata":
      case "unknown-format":
      case "empty-resource":
      case "deferred-limit":
      case "discovery-failed":
        labels.add("image discovery");
        break;
      case "limit-exceeded":
      case "encode-failed":
      case "write-failed":
      case "output-exists":
      case "destination-denied":
      case "unsupported-extension":
      case "output-unavailable":
      case "output-no-parent":
      case "launch-failed":
      case "output-denied":
      case "output-not-found":
      case "invoke-failed":
        labels.add("output");
        break;
    }
  }
  const params = new URLSearchParams({
    title: `${host} : ${product} report`,
    labels: [...labels].join(","),
    body: "",
  });
  const bodyFor = (length: number) =>
    `${intro}${fence}text\n${details.slice(0, length)}${length < details.length ? "\n[Truncated; copy or save the complete diagnostics from Dezoomify.]" : ""}\n${fence}\n`;
  let low = 0;
  let high = details.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    params.set("body", bodyFor(middle));
    if (params.toString().length <= 7000) low = middle;
    else high = middle - 1;
  }
  params.set("body", bodyFor(low));
  // Pathological input/error text must also respect the encoded draft budget.
  if (params.toString().length > 7000) {
    params.set("body", "");
    const fallback = `${input}\n\nReport exceeds the GitHub link limit. Please copy or save the complete diagnostics from Dezoomify.`;
    for (const character of fallback) {
      const body = params.get("body") ?? "";
      params.set("body", body + character);
      if (params.toString().length > 7000) {
        params.set("body", body);
        break;
      }
    }
  }
  return `https://github.com/lovasoa/dezoomify/issues/new?${params}`;
}

export function DiagnosticDetails({
  report,
  callbacks,
  error,
}: {
  report: DiagnosticReport;
  callbacks: ViewCallbacks;
  error?: JobError;
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
      {shown.context.product === "extension" ? <p>{t("view.diagnostics.signedInNote")}</p> : null}
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
        <a href={diagnosticIssueUrl(shown, error)} target="_blank" rel="noopener">
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
