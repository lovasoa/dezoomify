// Desktop error copy and redaction (todo 2.2 split from main.tsx).
// Layered presentation helpers plus the payload/deep-link validators.
// Pure: the host string and controller status arrive as parameters, so this
// module owns no job state. File move, no behavior change.
import { t } from "@dezoomify/shared-ui";

// Large-image preflight bounds (native parity, docs/native-apps.md):
// the canvas holds 4 bytes per pixel plus transient encode buffers,
// budgeted at 8 GiB. JPEG addresses at most 65535 px per side.
export const CANVAS_BYTES_PER_PIXEL = 4;
export const CANVAS_LIMIT_BYTES = 8 * 1024 * 1024 * 1024;
export const JPEG_MAX_SIDE = 65535;


export function categoryFor(code: string): string {
  if (code === "INVALID_URL" || code === "INVALID_SETTINGS") return "validation";
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code.indexOf("OUTPUT_") === 0 || code === "OUTPUT_DENIED") return "output";
  if (code === "WORKER_FAILED" || code === "PLAN_INVALID") return "internal";
  const lower = String(code ?? "").toLowerCase();
  if (lower.indexOf("protocol.incompatible") === 0 || lower.indexOf("handoff.rejected") === 0) return "validation";
  if (lower.indexOf("discovery.") === 0 || lower.indexOf("job.discovery") >= 0) return "discovery";
  if (lower.indexOf("output.") === 0) return "output";
  if (lower.indexOf("internal") >= 0 || lower === "native.internal") return "internal";
  if (lower.indexOf("job.invalid") >= 0 || lower.indexOf("command.") === 0) return "validation";
  return "transport";
}


export function phaseFor(code: string): string {
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code.indexOf("OUTPUT_") === 0 || code === "OUTPUT_DENIED") return "output";
  const lower = String(code ?? "").toLowerCase();
  if (lower === "protocol.incompatible") return "handshake";
  if (lower === "handoff.rejected") return "validation";
  if (lower.indexOf("discovery.") === 0 || lower.indexOf("job.discovery") >= 0) return "discovery";
  if (lower === "tile.decode-failed" || lower.indexOf("decode.") === 0) return "decode";
  if (lower === "tile.processing-failed") return "processing";
  if (lower.indexOf("output.") === 0) return "output";
  if (lower === "job.cancelled") return "cleanup";
  if (lower.indexOf("job.resource") === 0 || lower.indexOf("job.plan") === 0 || lower.indexOf("job.probe") === 0) return "acquisition";
  if (lower.indexOf("command.") === 0 || lower.indexOf("job.invalid") >= 0 || lower.indexOf("job.post-terminal") >= 0 || lower.indexOf("job.unknown") >= 0 || lower.indexOf("job.stale") >= 0) return "validation";
  return "acquisition";
}


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


// Redact full http(s) URLs inside free-form technical text down to their
// redacted origin, so diagnostics never carry paths, queries, or fragments.
export function redactUrlsInText(text: string): string {
  return String(text ?? "").replace(/https?:\/\/[^\s"'<>]+/g, (match) => {
    const origin = redactedOriginOnly(match);
    return origin === "" ? "the server" : origin;
  });
}


export function trimTechnical(text: string, max = 2000): string {
  const redacted = redactUrlsInText(text);
  if (redacted.length <= max) return redacted;
  return `${redacted.slice(0, max)}…`;
}


export function formatGiB(bytes: number): string {
  const gib = bytes / (1024 * 1024 * 1024);
  if (gib >= 10) return `${Math.round(gib)} GiB`;
  return `${(Math.round(gib * 10) / 10).toFixed(1)} GiB`;
}


// Layered error copy: every code has plain jargon-free wording that names
// the step, the picture source, and the single best next action. Technical
// vocabulary (transport names, statuses, raw engine chains) stays out of
// this sentence; it belongs in the collapsible detail built beside it.
export function plainMessageFor(code: string, engineMessage: string, host: string): string {
  const engine = String(engineMessage ?? "");
  const lowerCode = String(code ?? "").toLowerCase();
  if (code === "INVALID_URL") {
    return t("desktop.url.notWebPage");
  }
  if (code === "INVALID_SETTINGS") {
    return t("desktop.settings.unusable");
  }
  if (code === "OUTPUT_DENIED") {
    return t("desktop.output.deniedPick");
  }
  if (lowerCode === "protocol.incompatible") {
    return t("desktop.proto.incompatible", { host });
  }
  if (lowerCode === "handoff.rejected") {
    return t("desktop.handoff.rejected", { host });
  }
  if (lowerCode === "output.exists") {
    return t("desktop.output.exists", { host });
  }
  if (lowerCode === "output.destination-denied" || lowerCode === "output.unsupported-extension") {
    return t("desktop.output.destDenied", { host });
  }
  if (lowerCode === "job.post-terminal" || lowerCode === "job.unknown" || lowerCode === "job.stale") {
    return t("desktop.job.gone", { host });
  }
  if (lowerCode === "output.canvas-limit" || lowerCode.indexOf("canvas-limit") >= 0) {
    const dim = engine.match(/(\d+)\s*x\s*(\d+)/);
    const needMatch = engine.match(/needs\s+([0-9.]+\s*GiB[^,;]*|[0-9,]+\s*bytes[^,;]*)/i);
    const dims = dim ? t("desktop.msg.dimsPixels", { a: dim[1], b: dim[2] }) : t("desktop.msg.thisPicture");
    const need = needMatch ? t("desktop.msg.needAbout", { need: needMatch[1].trim() }) : "";
    return t("desktop.output.canvasLimit", {
      dims,
      need,
      limit: formatGiB(CANVAS_LIMIT_BYTES),
      jpegMax: JPEG_MAX_SIDE,
      host,
    });
  }
  if (lowerCode === "output.encode-failed" && /65535|jpeg/i.test(engine)) {
    const dim = engine.match(/(\d+)\s*x\s*(\d+)/);
    const dims = dim ? t("desktop.msg.dimsPixels", { a: dim[1], b: dim[2] }) : t("desktop.msg.thisPicture");
    return t("desktop.output.jpegLimit", { dims, jpegMax: JPEG_MAX_SIDE, host });
  }
  if (
    lowerCode.indexOf("tile.") === 0 ||
    lowerCode === "tile.download-failed" ||
    lowerCode === "job.partial-discarded" ||
    lowerCode.indexOf("partial") >= 0
  ) {
    if (lowerCode === "job.partial-discarded") {
      return t("desktop.tile.partialDiscarded", { host });
    }
    return t("desktop.tile.partialChoice", { host });
  }
  if (
    code === "NO_IMAGE_FOUND" ||
    lowerCode.indexOf("discovery.no-image") >= 0 ||
    lowerCode.indexOf("discovery.failed") >= 0 ||
    lowerCode.indexOf("discovery.") === 0 ||
    lowerCode.indexOf("job.discovery") >= 0 ||
    lowerCode.indexOf("job.no-images") >= 0 ||
    lowerCode.indexOf("job.catalog") >= 0 ||
    lowerCode.indexOf("job.empty") >= 0 ||
    lowerCode.indexOf("unknown-dezoomer") >= 0
  ) {
    return t("desktop.discovery.none", { host });
  }
  if (
    lowerCode.indexOf("plan") >= 0 ||
    lowerCode.indexOf("level") >= 0 ||
    lowerCode.indexOf("tile-plan") >= 0 ||
    lowerCode.indexOf("resource-limit") >= 0 ||
    lowerCode.indexOf("tile.limit") >= 0
  ) {
    return t("desktop.plan.none", { host });
  }
  if (
    lowerCode.indexOf("transport.") === 0 ||
    lowerCode.indexOf("network") >= 0 ||
    lowerCode.indexOf("http-error") >= 0 ||
    lowerCode.indexOf("timeout") >= 0 ||
    lowerCode.indexOf("tls") >= 0 ||
    lowerCode.indexOf("redirect") >= 0
  ) {
    return t("desktop.transport.stalled", { host });
  }
  if (lowerCode.indexOf("output.") === 0 || code.indexOf("OUTPUT_") === 0) {
    return t("desktop.output.writeFail", { host });
  }
  if (lowerCode.indexOf("job.cancelled") >= 0) {
    return t("desktop.job.cancelledMsg");
  }
  if (
    code === "START_FAILED" ||
    code === "CHOICE_FAILED" ||
    lowerCode.indexOf("invalid") >= 0 ||
    lowerCode.indexOf("stale") >= 0 ||
    lowerCode.indexOf("unknown") >= 0
  ) {
    if (code === "START_FAILED") return t("desktop.start.failed", { host });
    if (code === "CHOICE_FAILED") return t("desktop.choice.failed");
    return t("desktop.save.generic", { host });
  }
  if (lowerCode.indexOf("internal") >= 0 || code === "WORKER_FAILED" || code === "PLAN_INVALID") {
    return t("desktop.internal.error", { host });
  }
  return t("desktop.save.fallback", { host });
}


// Technical chain for the collapsible detail only: code, phase, transport,
// resource kind, status, trimmed origin, and the trimmed non-secret engine
// text. Never shown as the first message. Phase/transport/resource-kind come
// from the backend payload when present (stable codes), falling back to the
// local code mapping only for legacy payloads.
export function technicalDetailFor(
  code: string,
  engineMessage: string,
  extraDetail: string | undefined,
  opts: { phase?: string; transport?: string; resourceKind?: string } | undefined,
  status: string,
  origin: string,
  nativeTransport: string,
): string {
  const lines = [
    `Code: ${code}`,
    `Phase: ${opts?.phase ?? phaseFor(code)}`,
    `Transport: ${opts?.transport ?? nativeTransport}`,
  ];
  if (opts?.resourceKind) lines.push(`Resource: ${opts.resourceKind}`);
  lines.push(`Status: ${status}`);
  lines.push(`Origin: ${origin === "" ? "n/a" : origin}`);
  const engine = trimTechnical(engineMessage || "");
  if (engine) lines.push(`Engine: ${engine}`);
  if (extraDetail && extraDetail !== engineMessage) {
    const extra = trimTechnical(extraDetail);
    if (extra && extra !== engine) lines.push(`Detail: ${extra}`);
  }
  return lines.join("\n");
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
  for (const key of ["job", "jobId", "job_id"]) {
    const v = payload[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export function payloadSeq(payload: PayloadTable): number | null {
  for (const key of ["seq", "seqNo", "sequence", "eventSeq"]) {
    const v = payload[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.floor(v);
    if (typeof v === "string" && v.trim() !== "") {
      const n = Number(v.trim());
      if (Number.isFinite(n) && n >= 0) return Math.floor(n);
    }
  }
  return null;
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
// `testdata/redaction-vectors.json`, and `packages/protocol-ts/src/generated.ts`.
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
