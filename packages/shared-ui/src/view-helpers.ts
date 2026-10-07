import { getLocale, t } from "./i18n.ts";

export function formatPixelCount(pixels: number): string {
  const [scale, key] =
    pixels >= 1e9
      ? ([1e9, "view.job.gigapixels"] as const)
      : pixels >= 1e6
        ? ([1e6, "view.job.megapixels"] as const)
        : ([1, "view.job.pixels"] as const);
  const value = Math.round((pixels / scale) * 10) / 10;
  const locale = getLocale();
  return t(key, {
    count: new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value),
  });
}

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
  if (missing.length === 0) {
    const key = count === 1 ? "desktop.rec.missingOne" : "desktop.rec.missingCount";
    return t(key, { count });
  }
  const shown = missing.slice(0, 20).join(", ");
  const rest = missing.length > 20 ? t("desktop.rec.more", { n: missing.length - 20 }) : "";
  const key = missing.length === 1 ? "desktop.rec.missingOneList" : "desktop.rec.missingList";
  return t(key, { n: missing.length, shown, rest });
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
