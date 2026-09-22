import type { StructuredError } from "./snapshot-view.ts";

export function truncateMiddle(value: string, max = 90): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

export function displaySourceUrl(value: string): string {
  try {
    const url = new URL(value);
    return truncateMiddle(`${url.host}${url.pathname}`, 90);
  } catch {
    return "source unavailable";
  }
}

export function hostFromUrl(url?: string): string {
  try {
    return new URL(url ?? "").host;
  } catch {
    return "the server";
  }
}

/** Base document title for browser products when no job is active. */
export const DEFAULT_PAGE_TITLE = "Dezoomify";

/**
 * Document title while a job runs: `Dezoomify <host>`. Pure and host-neutral
 * so the website and the extension share one shape; hosts own the
 * `document.title` assignment (shared UI never touches host globals).
 * Returns the base title when the source URL is missing or unparseable.
 */
export function jobPageTitle(url?: string): string {
  const host = hostFromUrl(url);
  if (!url || host === "" || host === "the server") return DEFAULT_PAGE_TITLE;
  return `${DEFAULT_PAGE_TITLE} ${host}`;
}

/**
 * Whether a controller status counts as "while dezooming" for the tab title.
 * Covers the shared job phase; terminal and idle phases restore the base.
 */
export function isActiveJobStatus(status: string): boolean {
  return (
    status === "discovering" ||
    status === "choosing-image" ||
    status === "choosing-level" ||
    status === "preflighting" ||
    status === "downloading" ||
    status === "saving"
  );
}

export function handoffOriginFor(handoffUrl?: string, sourceUrl?: string): string {
  const candidates = [sourceUrl];
  try {
    const src = handoffUrl
      ?.split("?")[1]
      ?.split("#")[0]
      ?.split("&")
      .find((part) => part.startsWith("src="));
    if (src) candidates.push(decodeURIComponent(src.slice(4).replace(/\+/g, " ")));
  } catch {
    /* malformed handoff links have no origin summary */
  }
  for (const candidate of candidates) {
    try {
      if (!candidate) continue;
      if (candidate.trim().toLowerCase().startsWith("file:")) return "";
      const url = new URL(candidate.trim());
      if (url.protocol === "http:" || url.protocol === "https:")
        return `${url.protocol}//${url.host}/`;
    } catch {
      /* try the next candidate */
    }
  }
  return "";
}

export function isFileHandoffSource(sourceUrl?: string): boolean {
  try {
    return new URL(String(sourceUrl ?? "").trim()).protocol === "file:";
  } catch {
    return false;
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
 * here. The text itself is inert; `reportIssueUrl` is the only path that
 * puts it in a URL, and only when the user opens the prefilled report link.
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

const REPORT_BASE_URL = "https://github.com/lovasoa/dezoomify/issues/new";
const REPORT_LABELS = "new site support,unconfirmed";
/**
 * Pre-encoding ceiling for the prefilled body. GitHub answers `414 URI Too
 * Long` past its server limit, so the activity log is dropped line by line
 * before the diagnostics or the source URL are.
 */
const MAX_REPORT_BODY = 4000;

function assembleReportBody(
  host: string,
  url: string,
  error: StructuredError,
  log: string,
): string {
  const sourceLines = [
    `### Site name and description`,
    host,
    url !== "" ? url : "(address unavailable)",
  ];
  sourceLines.push("", "### Example URLs", url !== "" ? url : "(address unavailable)");
  sourceLines.push("", "### Current error message", error.message);
  sourceLines.push("", "### Technical details", errorDiagnosticsText(error));
  if (log !== "") sourceLines.push("", "### Activity log", log);
  sourceLines.push(
    "",
    "### Browser",
    "- Browser:",
    "- Version:",
    "",
    "### Additional context",
    "<!-- Review the draft and remove sign-in details, tokens, or private addresses before submitting. -->",
  );
  return sourceLines.join("\n");
}

/**
 * New-site-support issue URL prefilled from the failed view: the source
 * address, the engine diagnostics, and the recent activity log all travel in
 * the query string, so the user reviews them before the issue is submitted.
 */
export function reportIssueUrl({
  source,
  error,
  activityLog,
}: {
  source?: string;
  error: StructuredError;
  activityLog?: string;
}): string {
  const url = String(source ?? "").trim();
  const host = hostFromUrl(url);
  const log = String(activityLog ?? "").trim();

  let body = assembleReportBody(host, url, error, "");
  if (log !== "") {
    const full = assembleReportBody(host, url, error, log);
    if (full.length <= MAX_REPORT_BODY) {
      body = full;
    } else {
      const kept: string[] = [];
      for (const line of log.split("\n")) {
        kept.push(line);
        if (assembleReportBody(host, url, error, kept.join("\n")).length > MAX_REPORT_BODY) {
          kept.pop();
          break;
        }
      }
      body = assembleReportBody(host, url, error, kept.join("\n"));
    }
  }
  if (body.length > MAX_REPORT_BODY) body = body.slice(0, MAX_REPORT_BODY);

  const params = new URLSearchParams();
  params.set("labels", REPORT_LABELS);
  params.set("title", `[new site support] ${host}`);
  params.set("body", body);
  return `${REPORT_BASE_URL}?${params.toString()}`;
}
