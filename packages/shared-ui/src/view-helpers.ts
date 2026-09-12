import type { StructuredError } from "./controller.ts";
import { t } from "./i18n.ts";

export function truncateMiddle(value: string, max = 90): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

export function displaySourceUrl(value: string): string {
  try { const url = new URL(value); return truncateMiddle(`${url.host}${url.pathname}`, 90); }
  catch { return "source unavailable"; }
}

export function hostFromUrl(url?: string): string {
  try { return new URL(url ?? "").host; }
  catch { return "the server"; }
}

export function handoffOriginFor(handoffUrl?: string, sourceUrl?: string): string {
  const candidates = [sourceUrl];
  try {
    const src = handoffUrl?.split("?")[1]?.split("#")[0]?.split("&").find((part) => part.startsWith("src="));
    if (src) candidates.push(decodeURIComponent(src.slice(4).replace(/\+/g, " ")));
  } catch { /* malformed handoff links have no origin summary */ }
  for (const candidate of candidates) {
    try {
      if (!candidate || candidate.trim().toLowerCase().startsWith("file:")) return "";
      const url = new URL(candidate.trim());
      if (url.protocol === "http:" || url.protocol === "https:") return `${url.protocol}//${url.host}/`;
    } catch { /* try the next candidate */ }
  }
  return "";
}

export function isFileHandoffSource(sourceUrl?: string): boolean {
  try { return new URL(String(sourceUrl ?? "").trim()).protocol === "file:"; }
  catch { return false; }
}

export function defaultStepFor(status: string): string {
  switch (status) {
    case "discovering": return t("view.step.discovering");
    case "choosing-image": return t("view.step.choosingImage");
    case "choosing-level": return t("view.step.choosingLevel");
    case "preflighting": return t("view.step.preflighting");
    case "downloading": return t("view.step.downloading");
    case "saving": return t("view.step.saving");
    default: return t("view.step.working");
  }
}

export function errorDiagnosticsText(error: StructuredError): string {
  const base = `Code: ${error.code}\nCategory: ${error.category}\nRetryable: ${error.retryable}\n` +
    `Transport: ${error.transport ?? "direct"}\nPhase: ${error.phase ?? "discovery"}\nMessage: ${error.message}`;
  return error.detail ? `${base}\n\n${error.detail}` : base;
}
