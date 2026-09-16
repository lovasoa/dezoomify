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
      if (!candidate) continue;
      if (candidate.trim().toLowerCase().startsWith("file:")) return "";
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

/**
 * Technical-details text, one shape across every product:
 *
 * ```text
 * url: <full request URL, verbatim>
 * http: <status>              (only when the failure is an HTTP refusal)
 * server: "<bounded signal>"  (only when one was captured)
 *
 * <engine block: headline-free per-format bullets, real line breaks>
 *
 * code:<C> category:<c> retryable:<true|false> transport:<t> phase:<p>[ http:<n>]
 * <host provenance lines>       (only when the host supplies extras)
 * ```
 *
 * The prominent headline lives outside the details and is never repeated
 * here; the URL and server signal stay on the user's device.
 */
export function errorDiagnosticsText(error: StructuredError): string {
  const hasHttp = typeof error.http === "number";
  const lines: string[] = [];
  if (error.url) lines.push(`url: ${error.url}`);
  if (hasHttp) lines.push(`http: ${error.http}`);
  if (error.preview) lines.push(`server: ${error.preview}`);
  if (error.detail) {
    if (lines.length > 0) lines.push("");
    lines.push(error.detail);
  }
  let trailing =
    `code:${error.code} category:${error.category ?? "unknown"} retryable:${error.retryable ? "true" : "false"}` +
    ` transport:${error.transport ?? "direct"} phase:${error.phase ?? "discovery"}`;
  if (hasHttp) trailing += ` http:${error.http}`;
  if (lines.length > 0) lines.push("");
  lines.push(trailing);
  if (error.extras) lines.push(...error.extras);
  return lines.join("\n");
}
