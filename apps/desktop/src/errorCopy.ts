// Desktop error copy and redaction (todo 2.2 split from main.tsx).
// Layered presentation helpers plus the payload/deep-link validators.
// Pure: the host string and controller status arrive as parameters, so this
// module owns no job state. File move, no behavior change.
import { categoryFor, phaseFor, plainMessageFor, t } from "@dezoomify/shared-ui";
import { eventJobId, eventSeq } from "./events.ts";

// Failure classification and plain-language headlines live once in the shared
// UI (`packages/shared-ui/src/failure.ts`); desktop re-exports them so its
// callers keep one import site and no copy is duplicated here.
export { categoryFor, phaseFor, plainMessageFor };


export function isValidInputUrl(url: string): boolean {
  if (typeof url !== "string") return false;
  const trimmed = url.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (parsed.username !== "" || parsed.password !== "") return false;
  return true;
}


// Redacted origin (scheme://host[:port]) for diagnostics and bug reports.
// Never includes userinfo, path, query, or fragment; "" when unparseable.
export function redactedOriginOnly(url: string): string {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase();
    if (!host) return "";
    const defaultPort = u.protocol === "https:" ? "443" : "80";
    const port = u.port && u.port !== defaultPort ? `:${u.port}` : "";
    return `${u.protocol}//${host}${port}`;
  } catch {
    return "";
  }
}


export function hostOf(url: string): string {
  const origin = redactedOriginOnly(url);
  if (origin) {
    const withoutScheme = origin.split("://")[1] ?? "";
    if (withoutScheme) return withoutScheme;
  }
  return "the server";
}


// Idle prefill: read an initial URL from the launch location without ever
// treating it as a started job. Supports ?url=/ ?src= and legacy #url= or
// bare hash payloads. Invalid or secret-bearing candidates return null.
export function readInitialUrl(): string | null {
  try {
    const loc = (globalThis as Record<string, unknown>)["location"] as
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
    if (hash && hash.startsWith("#")) {
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


// Bound free-form technical text. Credentials are already redacted by the
// backend (`redact_error_text`); the full request URL is deliberately kept
// verbatim in the on-device details (the shared renderer places it on its
// own line), so only the length is trimmed here.
export function trimTechnical(text: string, max = 2000): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}


// Missing-tile ids for the partial view: typed fields first, then
// tile ids inside free-form detail text. Ids are short tokens only;
// URLs and paths never enter the list.
export function extractMissingTiles(
  payload: Record<string, unknown>,
  detailObj: Record<string, unknown> | null,
  detailRaw: string,
): Array<string> {
  const out: Array<string> = [];
  const pushToken = (v: unknown): void => {
    if (typeof v !== "string") return;
    const t = v.trim();
    if (t.length === 0 || t.length > 128) return;
    if (t.indexOf("http://") >= 0 || t.indexOf("https://") >= 0) return;
    if (t.indexOf("/") >= 0 && t.indexOf(":") < 0) return;
    if (out.indexOf(t) < 0) out.push(t);
  };
  const tables: Array<Record<string, unknown> | null | undefined> = [payload, detailObj ?? undefined];
  for (const table of tables) {
    if (!table) continue;
    for (const key of ["missing", "missingTiles", "missing_tiles", "failedTiles", "failed_tiles", "tiles", "failed"]) {
      const v = (table as Record<string, unknown>)[key];
      if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === "string") pushToken(item);
          else if (item && typeof item === "object") {
            const obj = item as Record<string, unknown>;
            pushToken(obj["tile"] ?? obj["id"] ?? obj["name"]);
          }
        }
      } else if (typeof v === "string" && v.length > 0 && v.length <= 2048) {
        for (const part of v.split(/[\s,;]+/)) pushToken(part);
      }
    }
  }
  const text = String(detailRaw ?? "");
  const tileRe = /tile[:#\s]*([A-Za-z0-9._-]{1,64})/gi;
  let m: RegExpExecArray | null;
  while ((m = tileRe.exec(text)) !== null) {
    pushToken(m[1]);
    if (out.length >= 60) break;
  }
  return out.slice(0, 60);
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


// --- IPC payload parsing ---

export type PayloadTable = Record<string, unknown>;

export function asPayload(raw: unknown): PayloadTable {
  if (typeof raw === "object" && raw !== null) return raw as PayloadTable;
  return { value: raw };
}

export function payloadText(payload: PayloadTable): string {
  const parts: Array<string> = [];
  for (const key of ["kind", "event", "detail", "state", "reason", "status", "phase"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) parts.push(v);
  }
  return parts.join(" ").toLowerCase();
}

export function payloadJob(payload: PayloadTable): string | null {
  return eventJobId(payload);
}

export function payloadSeq(payload: PayloadTable): number | null {
  return eventSeq(payload);
}

export function strField(payload: PayloadTable, keys: Array<string>): string | undefined {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

// Numeric field from a payload key (number or numeric string) or from a
// "k=v"/"k: v" pair inside free-form detail text (the shell joins pipeline
// detail maps as "acquired=3 total=10").
export function numField(payload: PayloadTable, detailText: string, keys: Array<string>): number | undefined {
  for (const key of keys) {
    const v = payload[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v.trim()))) {
      const n = Math.floor(Number(v.trim()));
      if (n >= 0) return n;
    }
  }
  for (const key of keys) {
    const m = detailText.match(new RegExp(`(?:^|\\s)${key}\\s*[:=]\\s*(\\d+)`, "i"));
    if (m) {
      const n = Math.floor(Number(m[1]));
      if (Number.isFinite(n) && n >= 0) return n;
    }
  }
  return undefined;
}

// Structured detail attached to an event: JSON object string, "k=v" pairs,
// or a plain technical sentence. Returns the parsed object when the detail
// is shaped, so reason/recovery/attempt/code/message stay typed (never
// branched from display strings elsewhere).
export function parseDetailObject(detail: string): PayloadTable | null {
  const trimmed = detail.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) return parsed as PayloadTable;
    } catch {
      return null;
    }
  }
  return null;
}

export function payloadReason(payload: PayloadTable, text: string): "destination" | "partial" | null {
  const direct = strField(payload, ["reason", "recoveryReason", "recovery_reason"]);
  if (direct) {
    const lower = direct.toLowerCase();
    if (lower.indexOf("destination") >= 0) return "destination";
    if (lower.indexOf("partial") >= 0) return "partial";
  }
  const detail = strField(payload, ["detail"]);
  if (detail) {
    const obj = parseDetailObject(detail);
    if (obj) {
      const inner = strField(obj, ["reason"]);
      if (inner) {
        const lower = inner.toLowerCase();
        if (lower.indexOf("destination") >= 0) return "destination";
        if (lower.indexOf("partial") >= 0) return "partial";
      }
    }
  }
  if (text.indexOf("destination") >= 0) return "destination";
  if (text.indexOf("partial") >= 0) return "partial";
  return null;
}


export function encoderToMime(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const lower = value.toLowerCase();
  if (lower.indexOf("image/") === 0) return value;
  if (lower === "png") return "image/png";
  if (lower === "jpeg" || lower === "jpg") return "image/jpeg";
  if (lower === "tiff" || lower === "tif") return "image/tiff";
  if (lower === "webp") return "image/webp";
  // ZIF is a TIFF-compatible multi-directory pyramid; IIIF trees are a
  // directory of JPEG tiles with an `info.json` manifest, so both fall back
  // to their closest single-file mime for the completed view.
  if (lower === "zif") return "image/tiff";
  if (lower === "iiif" || lower === "iiif-dir") return "application/json";
  return fallback;
}


export interface ValidatedDeepLink {
  sourceUrl: string;
  hint: string | null;
  version: number;
}

export const DEEP_LINK_SECRET_QUERY_KEYS = new Set([
  "access-token",
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "auth",
  "authorization",
  "bearer",
  "code",
  "cookie",
  "cookies",
  "credential",
  "key",
  "passwd",
  "password",
  "proxy-authorization",
  "secret",
  "session",
  "sessionid",
  "sessiontoken",
  "set-cookie",
  "sid",
  "sig",
  "signature",
  "state",
  "ticket",
  "token",
  "x-api-key",
]);
// Single shared vocabulary: mirrors `dezoomify_protocol::dto::SENSITIVE_QUERY_KEYS`,
// `testdata/redaction-vectors.json`, and the generated Rust bindings.
// Matching is exact per key (case-insensitive), never substring, so
// `/cookie-recipe/` stays valid while `?token=secret` is rejected.

export function hasSecretQueryParams(urlString: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlString);
  } catch {
    return true;
  }
  for (const key of parsed.searchParams.keys()) {
    if (DEEP_LINK_SECRET_QUERY_KEYS.has(key.toLowerCase())) return true;
  }
  // Fragments never reach servers but can leak tokens in labels/logs.
  if (parsed.hash) {
    const fragment = parsed.hash.slice(1);
    for (const pair of fragment.split("&")) {
      const eq = pair.indexOf("=");
      if (eq > 0) {
        const key = pair.slice(0, eq).replace(/^[?#]+/, "");
        if (DEEP_LINK_SECRET_QUERY_KEYS.has(key.toLowerCase())) return true;
      }
    }
  }
  return false;
}

// Deep-link source check: the shared input-URL shape plus the deep-link
// non-secret rule (no secret query keys, no local-file/path markers).
export function isValidDeepLinkSource(source: unknown): source is string {
  if (typeof source !== "string") return false;
  const trimmed = source.trim();
  if (!isValidInputUrl(trimmed)) return false;
  if (hasSecretQueryParams(trimmed)) return false;
  const lower = trimmed.toLowerCase();
  for (const needle of ["file://", "/etc/", "c:\\"]) {
    if (lower.includes(needle)) return false;
  }
  return true;
}

export function normalizeDeepLinkHint(hint: unknown): string | null | undefined {
  if (hint === undefined || hint === null) return null;
  if (typeof hint !== "string") return undefined;
  if (hint.includes("\0")) return undefined;
  if (hint.length === 0) return null;
  if (hint.length > 256) return undefined;
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

// Re-parse one raw `dezoomify://open` URL in the frontend (defense in depth:
// the Rust shell already validated it with `deep_link::parse_deep_link`).
// Rejects oversize, wrong scheme, duplicate/unknown/secret fields,
// unsupported versions, and malformed percent-encoding. Null means reject.
export function parseRawDeepLinkUrl(raw: string): ValidatedDeepLink | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "dezoomify:") return null;
  if (parsed.hostname !== "open") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  const query = trimmed.split("?")[1]?.split("#")[0] ?? "";
  if (query.length === 0) return null;
  let versionRaw: string | null = null;
  let srcRaw: string | null = null;
  let hintRaw: string | null = null;
  let seenV = false;
  let seenSrc = false;
  let seenHint = false;
  for (const pair of query.split("&")) {
    if (pair.length === 0) continue;
    const eq = pair.indexOf("=");
    if (eq < 0) return null;
    const name = pair.slice(0, eq);
    const value = pair.slice(eq + 1);
    if (name.includes("%")) return null;
    if (name === "v") {
      if (seenV) return null;
      seenV = true;
      versionRaw = value;
    } else if (name === "src") {
      if (seenSrc) return null;
      seenSrc = true;
      srcRaw = value;
    } else if (name === "hint") {
      if (seenHint) return null;
      seenHint = true;
      hintRaw = value;
    } else {
      return null;
    }
  }
  if (versionRaw !== "1" && versionRaw !== "2") return null;
  if (srcRaw === null) return null;
  let sourceUrl: string;
  try {
    sourceUrl = decodeURIComponent(srcRaw.replace(/\+/g, " "));
  } catch {
    return null;
  }
  if (!isValidDeepLinkSource(sourceUrl)) return null;
  let hint: string | null = null;
  if (hintRaw !== null) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(hintRaw.replace(/\+/g, " "));
    } catch {
      return null;
    }
    const normalized = normalizeDeepLinkHint(decoded);
    if (normalized === undefined) return null;
    hint = normalized;
  }
  return { sourceUrl: sourceUrl.trim(), hint, version: Number(versionRaw) };
}

export function extractDeepLinkUrl(payload: PayloadTable): string | null {
  for (const key of ["url", "sourceUrl", "source_url", "input_url", "inputUrl", "href", "detail"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

// Validate a `dezoomify://deep-link-pending` payload again in the frontend
// before showing the confirm UI. Accepts the redacted
// `{source_url, hint, version}` triple emitted by the Rust shell, or a raw
// `dezoomify://open` URL in legacy shapes. Null means reject (no-op).
export function validateDeepLinkPayload(payload: PayloadTable): ValidatedDeepLink | null {
  const sourceRaw =
    payload["source_url"] ?? payload["sourceUrl"] ?? extractDeepLinkUrl(payload);
  if (typeof sourceRaw === "string" && sourceRaw.trim().startsWith("dezoomify://")) {
    return parseRawDeepLinkUrl(sourceRaw);
  }
  const version = normalizeDeepLinkVersion(payload["version"] ?? payload["v"]);
  if (version === null) return null;
  if (!isValidDeepLinkSource(sourceRaw)) return null;
  const hint = normalizeDeepLinkHint(payload["hint"] ?? null);
  if (hint === undefined) return null;
  return { sourceUrl: (sourceRaw as string).trim(), hint, version };
}
