import { t } from "./i18n.ts";

export function truncateMiddle(value: string, max = 90): string {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  const half = Math.floor((max - 1) / 2);
  return `${text.slice(0, half)}…${text.slice(text.length - half)}`;
}

// Bound free-form technical text while preserving the original details.
export function trimTechnical(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

export function formatMissingSummary(missing: Array<string>, failedCount?: number): string {
  const count = missing.length > 0 ? missing.length : (failedCount ?? 0);
  if (count <= 0) return t("desktop.rec.missingSome");
  const plural = count === 1 ? "" : "s";
  if (missing.length === 0) return t("desktop.rec.missingCount", { count, plural });
  const shown = missing.slice(0, 20).join(", ");
  const rest = missing.length > 20 ? t("desktop.rec.more", { n: missing.length - 20 }) : "";
  return t("desktop.rec.missingList", { n: missing.length, plural, shown, rest });
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
