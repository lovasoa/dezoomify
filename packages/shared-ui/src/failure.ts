// Localized error headlines for the typed error contract (`Error` in
// `@dezoomify/wasm-bindings`): copy comes from structured facts only; no
// message text is parsed. The retry verdict is stamped by host boundaries
// from the one policy in Rust (`Error::retryable`).
import type { BlockedReason, Error as JobError } from "@dezoomify/wasm-bindings";
import { type I18nKey, t } from "./i18n.ts";

// JPEG addresses at most 65535 px per side; WebP at most 16383 px
// (copy interpolation only).
const JPEG_MAX_SIDE = 65535;
const WEBP_MAX_SIDE = 16383;

// Human-readable byte counts for limit copy (exact bytes plus a
// GiB/MiB approximation).
function formatBytes(bytes: number): string {
  const GIB = 1024 ** 3;
  const MIB = 1024 ** 2;
  if (bytes >= GIB) return `${(bytes / GIB).toFixed(1)} GiB (${bytes} bytes)`;
  if (bytes >= MIB) return `${(bytes / MIB).toFixed(1)} MiB (${bytes} bytes)`;
  return `${bytes} bytes`;
}

/**
 * One headline key per error kind; adding a Rust variant makes this record
 * incomplete until it is listed. Kinds whose copy needs extra facts resolve
 * in `plainMessageFor` first; their entry here is the plain fallback.
 */
const COPY = {
  "http-error": "view.fail.httpNotOpened",
  "rate-limited": "view.fail.rateDirect",
  timeout: "desktop.transport.stalled",
  "network-failure": "desktop.transport.stalled",
  "policy-denied": "view.fail.policyBlocked",
  "bad-url": "desktop.transport.stalled",
  "bad-redirect": "desktop.transport.stalled",
  "redirect-limit": "desktop.transport.stalled",
  "size-limit": "view.fail.proxyBudget",
  cancelled: "desktop.job.cancelledMsg",
  "proxy-budget-exceeded": "view.fail.proxyBudget",
  "proxy-error": "view.fail.proxyFetch",
  "no-image-found": "view.discovery.none",
  "malformed-metadata": "view.discovery.none",
  "unknown-format": "view.discovery.none",
  "empty-resource": "view.discovery.none",
  "resource-limit": "desktop.plan.none",
  "deferred-limit": "view.discovery.none",
  "discovery-failed": "view.discovery.none",
  "invalid-input": "desktop.save.fallback",
  "invalid-options": "desktop.settings.unusable",
  "invalid-state": "desktop.job.gone",
  duplicate: "desktop.save.fallback",
  stale: "desktop.job.gone",
  "plan-empty": "desktop.plan.none",
  "plan-invalid": "view.fail.canvasAllocation",
  "no-usable-tiles": "desktop.tile.partialChoice",
  "partial-discarded": "desktop.tile.partialDiscarded",
  "decode-failed": "desktop.tile.partialChoice",
  "processing-failed": "desktop.tile.partialChoice",
  "limit-exceeded": "desktop.output.canvasLimit",
  "encode-failed": "desktop.output.writeFail",
  "write-failed": "desktop.output.writeFail",
  "output-exists": "desktop.output.exists",
  "destination-denied": "desktop.output.destDenied",
  "unsupported-extension": "desktop.output.destDenied",
  "output-unavailable": "view.fail.canvasContext",
  "output-no-parent": "desktop.output.writeFail",
  "launch-failed": "desktop.output.writeFail",
  "output-denied": "desktop.output.deniedPick",
  "output-not-found": "desktop.output.writeFail",
  "invoke-failed": "desktop.output.writeFail",
  "start-failed": "desktop.start.failed",
  "choice-failed": "desktop.choice.failed",
  "invalid-url": "desktop.url.invalid",
  "invalid-settings": "desktop.settings.unusable",
  "registration-failed": "desktop.internal.error",
  internal: "desktop.internal.error",
  "shell-lock": "desktop.internal.error",
  "binding-invalid-value": "desktop.internal.error",
  "interaction-expired": "desktop.choice.failed",
  "auth-forbidden-header": "desktop.settings.unusable",
  // Unreachable through `plainMessageFor` (composition unwraps it first).
  resource: "desktop.save.fallback",
} satisfies Record<JobError["kind"], I18nKey>;

// Bounded diagnostic text, matching the Rust side's bounds.
const MAX_TEXT = 4096;

function boundedText(value: unknown, depth: number): boolean {
  if (depth > 8) return false;
  if (typeof value === "string") return value.length <= MAX_TEXT;
  if (Array.isArray(value)) return value.every((item) => boundedText(item, depth + 1));
  if (value && typeof value === "object")
    return Object.values(value).every((item) => boundedText(item, depth + 1));
  return true;
}

/** Validate a typed error payload at untrusted boundaries, without rebuilding it. */
export function isJobError(value: unknown): value is JobError {
  return isJobErrorAt(value, 0);
}

/** Bounded text for an unknown throw: strings pass through, Error objects
 * keep their existing `String(error)` rendering, and plain objects render
 * as JSON instead of `[object Object]`. */
export function unknownDetail(error: unknown, limit = 2048): string {
  if (typeof error === "string") return error.slice(0, limit);
  if (error instanceof Error) return String(error).slice(0, limit);
  if (error !== null && typeof error === "object") {
    try {
      const text = JSON.stringify(error);
      if (typeof text === "string" && text !== "{}") return text.slice(0, limit);
    } catch {
      /* Fall through to String(error) below. */
    }
  }
  return String(error).slice(0, limit);
}

const TRANSPORTS = new Set([
  "direct",
  "metadata-proxy",
  "browser-session",
  "native",
  "display-only",
]);
const RESOURCE_KINDS = new Set(["metadata", "tile", "probe", "output"]);
// Closed enums of the generated contract's wire values (`BlockedReason`,
// `LimitReason`); the generated package declares types only, so this runtime
// list is their wire spelling. An unknown member is a binding error waiting
// to happen.
const BLOCKED_REASONS = new Set([
  "access-required",
  "blocked-ipv4",
  "blocked-ipv6",
  "cancelled",
  "content-type",
  "dns-rebinding",
  "dns-rebinding-v6",
  "forbidden",
  "invalid-url",
  "limit-exceeded",
  "loopback-host",
  "malformed",
  "malformed-body",
  "method",
  "network",
  "non-standard-port",
  "origin",
  "private-host",
  "protocol-version",
  "redirect-limit",
  "redirect-target",
  "scheme",
  "signed-query",
  "source-document-lost",
  "throttled",
  "userinfo",
]);
const LIMIT_REASONS = new Set(["memory", "jpeg-side", "webp-side"]);

/** Narrow a wire value to the generated `BlockedReason` union; an unknown
 * member is simply absent. */
export function blockedReason(value: unknown): BlockedReason | undefined {
  return typeof value === "string" && BLOCKED_REASONS.has(value)
    ? (value as BlockedReason)
    : undefined;
}

/** Structural guard per variant: required fields must exist with the right
 * shape before the payload narrows to the generated union (wrappers recurse
 * within the same depth bound). */
function isJobErrorAt(value: unknown, depth: number): boolean {
  if (!value || typeof value !== "object" || depth > 8) return false;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !Object.hasOwn(COPY, kind) || !boundedText(value, depth)) {
    return false;
  }
  const num = (field: unknown) => typeof field === "number" && Number.isFinite(field);
  const transport = (field: unknown) => typeof field === "string" && TRANSPORTS.has(field);
  const size = (field: unknown) => {
    const dimensions = field as Record<string, unknown> | undefined;
    return (
      dimensions !== undefined &&
      typeof dimensions === "object" &&
      num(dimensions.width) &&
      num(dimensions.height)
    );
  };
  switch (kind) {
    case "http-error":
      return num(record.status) && transport(record.transport);
    case "rate-limited":
    case "timeout":
    case "network-failure":
    case "proxy-error":
      return transport(record.transport);
    case "policy-denied":
      return transport(record.transport) && blockedReason(record.blocked_reason) !== undefined;
    case "redirect-limit":
    case "deferred-limit":
      return num(record.max);
    case "size-limit":
      return num(record.max_bytes);
    case "unknown-format":
      return typeof record.format === "string" && record.format.length > 0;
    case "limit-exceeded": {
      const limit = record.limit as Record<string, unknown> | undefined;
      return (
        !!limit &&
        typeof limit === "object" &&
        typeof limit.reason === "string" &&
        LIMIT_REASONS.has(limit.reason) &&
        (limit.dimensions === undefined || size(limit.dimensions)) &&
        (limit.bytes_required === undefined || num(limit.bytes_required)) &&
        (limit.bytes_available === undefined || num(limit.bytes_available))
      );
    }
    case "no-usable-tiles":
    case "partial-discarded":
      return typeof record.transient === "boolean";
    case "resource":
      return (
        typeof record.request === "string" &&
        typeof record.resource_kind === "string" &&
        RESOURCE_KINDS.has(record.resource_kind) &&
        isJobErrorAt(record.source, depth + 1)
      );
    case "discovery-failed":
      return record.cause === undefined || isJobErrorAt(record.cause, depth + 1);
    default:
      // Field-less variants (and `detail`-only variants) carry nothing
      // beyond the bounded text already checked.
      return true;
  }
}

/** The underlying failure, seen through the composition wrappers (`resource`
 * and `discovery-failed.cause`). */
export type RootCause = Exclude<JobError, { kind: "resource" }>;

export function causeOf(error: JobError): RootCause {
  if (error.kind === "resource") return causeOf(error.source);
  if (error.kind === "discovery-failed" && error.cause) return causeOf(error.cause);
  return error;
}

/** The observed HTTP status of a fetch failure, when there is one. */
export function httpStatusOf(error: JobError): number | undefined {
  const cause = causeOf(error);
  if (cause.kind === "http-error") return cause.status;
  return undefined;
}

/** Whether the same request may be retried, read from the `retryable` hint
 * the host boundary stamped from Rust's `Error::retryable`. Pure data read:
 * no policy lives here, and an error without the hint fails closed. */
export function canRetry(error: JobError): boolean {
  return (error as { retryable?: boolean }).retryable === true;
}

/** The bounded diagnostic text retained along the composition chain. */
export function detailOf(error: JobError): string | undefined {
  const parts: string[] = [];
  let current: JobError | undefined = error;
  for (let depth = 0; current && depth < 8; depth += 1) {
    if ("detail" in current && typeof current.detail === "string") parts.push(current.detail);
    current =
      current.kind === "resource"
        ? current.source
        : current.kind === "discovery-failed"
          ? current.cause
          : undefined;
  }
  return parts.length > 0 ? [...new Set(parts)].join("\n") : undefined;
}

/** Plain next-fix hint for a policy denial's reason. The exact reason stays
 * in diagnostics; the hint names the next action without jargon. */
function policyHintFor(
  reason: Extract<JobError, { kind: "policy-denied" }>["blocked_reason"],
): string {
  switch (reason) {
    case "blocked-ipv4":
    case "blocked-ipv6":
    case "dns-rebinding":
    case "dns-rebinding-v6":
    case "loopback-host":
    case "private-host":
      return t("view.fail.hintPrivate");
    case "content-type":
      return t("view.fail.hintContentType");
    case "redirect-limit":
    case "redirect-target":
    case "origin":
      return t("view.fail.hintRedirect");
    default:
      return t("view.fail.hintAddress");
  }
}

/**
 * Error copy: plain jargon-free wording that names the step, the picture
 * source, and the single best next action. Technical vocabulary (transport
 * names, statuses, raw failure chains) stays out of this sentence; it
 * belongs in the collapsible detail built beside it.
 */
export function plainMessageFor(error: JobError, host: string): string {
  const cause = causeOf(error);
  switch (cause.kind) {
    // Structured limit facts come from `limit`; display prose is never parsed.
    case "limit-exceeded": {
      const dims = cause.limit.dimensions
        ? t("desktop.msg.dimsPixels", {
            a: String(cause.limit.dimensions.width),
            b: String(cause.limit.dimensions.height),
          })
        : t("desktop.msg.thisPicture");
      const need =
        cause.limit.bytes_required !== undefined
          ? t("desktop.msg.needAbout", { need: formatBytes(cause.limit.bytes_required) })
          : "";
      const available =
        cause.limit.bytes_available !== undefined
          ? formatBytes(cause.limit.bytes_available)
          : "currently available memory";
      if (cause.limit.reason === "jpeg-side") {
        return t("desktop.output.jpegLimit", { dims, jpegMax: JPEG_MAX_SIDE, host });
      }
      if (cause.limit.reason === "webp-side") {
        return t("desktop.output.webpLimit", { dims, webpMax: WEBP_MAX_SIDE, host });
      }
      return t("desktop.output.canvasLimit", {
        dims,
        need,
        limit: available,
        jpegMax: JPEG_MAX_SIDE,
        host,
      });
    }
    case "rate-limited":
      return t(rateKey(cause.transport));
    case "http-error": {
      const status = cause.status;
      if (status === 429) return t(rateKey(cause.transport));
      if (status === 404) return t("view.fail.httpNotFound");
      if (status === 401 || status === 403 || status === 406) {
        return t("view.fail.httpRefused", { http: String(status) });
      }
      if (status >= 500) return t("view.fail.httpSiteProblem");
      break;
    }
    case "policy-denied":
      return t("view.fail.policyBlocked", { hint: policyHintFor(cause.blocked_reason) });
  }
  // Unrecognized payloads stay on the generic sentence at runtime; the
  // compile-time exhaustiveness lives in `COPY`.
  const key = Object.hasOwn(COPY, cause.kind) ? COPY[cause.kind] : undefined;
  return t(key ?? "desktop.save.fallback", { host });
}

/** 429s read as rate limits, branded by the transport that saw them. */
function rateKey(transport: string): I18nKey {
  return transport === "metadata-proxy" ? "view.fail.rateProxy" : "view.fail.rateDirect";
}
