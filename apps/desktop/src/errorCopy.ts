// Error presentation and deep-link validation for the desktop UI.

import { isValidDeepLinkSource, isValidInputUrl, t } from "@dezoomify/shared-ui";

export {
  DEEP_LINK_SECRET_QUERY_KEYS,
  hasSecretQueryParams,
  isValidDeepLinkSource,
  isValidInputUrl,
} from "@dezoomify/shared-ui";

export function hostOf(url: string): string {
  try {
    return new URL(url).host || "the server";
  } catch {
    return "the server";
  }
}

// Idle prefill: read an initial URL from the launch location without ever
// treating it as a started job. Supports ?url=/ ?src= and #url= or
// bare hash payloads. Invalid or secret-bearing candidates return null.
export function readInitialUrl(): string | null {
  try {
    const loc = (globalThis as Record<string, unknown>).location as
      | { search?: string; hash?: string }
      | undefined;
    if (!loc) return null;
    const search = typeof loc.search === "string" ? loc.search : "";
    if (search) {
      const params = new URLSearchParams(search);
      for (const key of ["url", "src", "input_url", "inputUrl"]) {
        const v = params.get(key);
        if (v && isValidInputUrl(v.trim())) return v.trim();
      }
    }
    const hash = typeof loc.hash === "string" ? loc.hash : "";
    if (hash?.startsWith("#")) {
      const body = hash.slice(1);
      if (body.startsWith("?")) {
        const params = new URLSearchParams(body.slice(1));
        const v = params.get("url") ?? params.get("src");
        if (v && isValidInputUrl(v.trim())) return v.trim();
      } else if (body.startsWith("url=")) {
        try {
          const v = decodeURIComponent(body.slice(4).replace(/\+/g, " "));
          if (isValidInputUrl(v.trim())) return v.trim();
        } catch {
          return null;
        }
      } else if (body.length > 0 && body.length <= 2048) {
        try {
          const v = decodeURIComponent(body.replace(/\+/g, " "));
          if (isValidInputUrl(v.trim())) return v.trim();
        } catch {
          return null;
        }
      }
    }
  } catch {
    return null;
  }
  return null;
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

export interface ValidatedDeepLink {
  sourceUrl: string;
  hint: string | null;
  version: number;
}

const utf8Encoder = new TextEncoder();

// UTF-8 byte length, matching the Rust shell's byte bounds.
function utf8Length(text: string): number {
  return utf8Encoder.encode(text).length;
}

export function normalizeDeepLinkHint(hint: unknown): string | null | undefined {
  if (hint === undefined || hint === null) return null;
  if (typeof hint !== "string") return undefined;
  if (hint.includes("\0")) return undefined;
  if (hint.length === 0) return null;
  // Byte bound matches the Rust shell (`deep_link.rs`: "hint beyond 256 bytes").
  if (utf8Length(hint) > 256) return undefined;
  return hint;
}

export function normalizeDeepLinkVersion(version: unknown): number | null {
  if (typeof version === "number" && Number.isInteger(version)) {
    return version === 1 || version === 2 ? version : null;
  }
  if (typeof version === "string" && (version === "1" || version === "2")) {
    return Number(version);
  }
  return null;
}

// Validate a `dezoomify://deep-link-pending` payload again in the frontend
// before showing the confirm UI. Accepts exactly the validated
// `{source_url, hint, version}` triple emitted by the Rust shell; raw
// `dezoomify://` values are refused (the shell's parser is the single
// validator, pinned by testdata/deep-link-vectors.json). Null means
// reject (no-op).
export function validateDeepLinkPayload(
  payload: Record<string, unknown>,
): ValidatedDeepLink | null {
  const sourceUrl = payload.source_url;
  const version = normalizeDeepLinkVersion(payload.version);
  if (version === null) return null;
  if (!isValidDeepLinkSource(sourceUrl)) return null;
  const hint = normalizeDeepLinkHint(payload.hint ?? null);
  if (hint === undefined) return null;
  return { sourceUrl: (sourceUrl as string).trim(), hint, version };
}
