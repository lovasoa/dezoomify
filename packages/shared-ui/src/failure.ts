// Localized error headlines and derived verdicts for the typed error
// contract (`Error` in `@dezoomify/wasm-bindings`). Copy is chosen from the
// discriminated union's structured facts (kind, status, limit facts); no
// message text is ever parsed. The Rust twin of `isRetryable` is
// `Error::retryable`, pinned together by `testdata/policy-vectors.json`.
import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { t } from "./i18n.ts";

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

// Every variant of the generated union, pinned at compile time: adding a
// Rust variant makes this record incomplete until it is listed here.
const KINDS = {
  "http-error": true,
  "rate-limited": true,
  timeout: true,
  "network-failure": true,
  "policy-denied": true,
  "bad-url": true,
  "bad-redirect": true,
  "redirect-limit": true,
  "size-limit": true,
  cancelled: true,
  "proxy-budget-exceeded": true,
  "proxy-error": true,
  "no-image-found": true,
  "malformed-metadata": true,
  "unknown-format": true,
  "empty-resource": true,
  "resource-limit": true,
  "deferred-limit": true,
  "discovery-failed": true,
  "invalid-input": true,
  "invalid-options": true,
  "invalid-state": true,
  duplicate: true,
  stale: true,
  "plan-empty": true,
  "plan-invalid": true,
  "no-usable-tiles": true,
  "partial-discarded": true,
  "decode-failed": true,
  "processing-failed": true,
  "limit-exceeded": true,
  "encode-failed": true,
  "write-failed": true,
  "output-exists": true,
  "destination-denied": true,
  "unsupported-extension": true,
  "output-unavailable": true,
  "output-no-parent": true,
  "launch-failed": true,
  "output-denied": true,
  "output-not-found": true,
  "invoke-failed": true,
  "start-failed": true,
  "choice-failed": true,
  "invalid-url": true,
  "invalid-settings": true,
  "handoff-rejected": true,
  "registration-failed": true,
  internal: true,
  "shell-lock": true,
  "binding-invalid-value": true,
  "interaction-expired": true,
  "auth-forbidden-header": true,
  resource: true,
} satisfies Record<JobError["kind"], true>;

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
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  return typeof kind === "string" && Object.hasOwn(KINDS, kind) && boundedText(value, 0);
}

/** The underlying failure, seen through the composition wrappers (`resource`
 * and `discovery-failed.cause`). */
export type RootCause = Exclude<JobError, { kind: "resource" }>;

export function causeOf(error: JobError): RootCause {
  if (error.kind === "resource") return causeOf(error.source);
  if (error.kind === "discovery-failed" && error.cause) return causeOf(error.cause);
  return error;
}

/** The observed HTTP status of a fetch failure, when there is one.
 * Aggregates report the status of their first retained HTTP failure. */
export function httpStatusOf(error: JobError): number | undefined {
  const cause = causeOf(error);
  if (cause.kind === "http-error") return cause.status;
  if (cause.kind === "no-usable-tiles" || cause.kind === "partial-discarded") {
    for (const failure of cause.failures) {
      const status = httpStatusOf(failure);
      if (status !== undefined) return status;
    }
  }
  return undefined;
}

/**
 * Whether the same request may be retried: transient HTTP statuses
 * (408/425/429 and 5xx) and transient transport/service failures retry;
 * everything else fails closed. Aggregates retry when any retained
 * constituent is transient. Mirrors `Error::retryable` in `model.rs`; the
 * shared oracle `testdata/policy-vectors.json` pins both.
 */
export function isRetryable(error: JobError): boolean {
  const cause = causeOf(error);
  switch (cause.kind) {
    case "http-error":
      return (
        cause.status === 408 ||
        cause.status === 425 ||
        cause.status === 429 ||
        (cause.status >= 500 && cause.status <= 599)
      );
    case "rate-limited":
    case "timeout":
    case "network-failure":
    case "proxy-error":
      return true;
    case "no-usable-tiles":
    case "partial-discarded":
      return cause.failures.some(isRetryable);
    default:
      return false;
  }
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

/**
 * Error copy: plain jargon-free wording that names the step, the picture
 * source, and the single best next action. Technical vocabulary (transport
 * names, statuses, raw failure chains) stays out of this sentence; it
 * belongs in the collapsible detail built beside it.
 */
export function plainMessageFor(error: JobError, host: string, source = ""): string {
  const cause = causeOf(error);
  const dims =
    cause.kind === "limit-exceeded" && cause.limit.dimensions
      ? t("desktop.msg.dimsPixels", {
          a: String(cause.limit.dimensions.width),
          b: String(cause.limit.dimensions.height),
        })
      : t("desktop.msg.thisPicture");
  switch (cause.kind) {
    // Browser canvas failure family (plan shape, 2D context, PNG encoding):
    // the plain sentence names the desktop app before any generic branch.
    case "plan-invalid":
      return t("view.fail.canvasAllocation");
    case "output-unavailable":
      return t("view.fail.canvasContext");
    case "encode-failed":
      return t("view.fail.canvasEncode");
    // Structured limit facts come from `limit`; display prose is never parsed.
    case "limit-exceeded": {
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
      return t(
        cause.transport === "metadata-proxy" ? "view.fail.rateProxy" : "view.fail.rateDirect",
      );
    case "http-error":
      if (cause.status === 429) {
        return t(
          cause.transport === "metadata-proxy" ? "view.fail.rateProxy" : "view.fail.rateDirect",
        );
      }
      return t("desktop.save.generic", { host });
    case "invalid-url":
      return source.startsWith("file:") ? t("view.handoff.localNote") : t("desktop.url.invalid");
    case "invalid-settings":
    case "auth-forbidden-header":
      return t("desktop.settings.unusable");
    case "output-denied":
      return t("desktop.output.deniedPick");
    case "handoff-rejected":
      return t("desktop.handoff.rejected", { host });
    case "output-exists":
      return t("desktop.output.exists", { host });
    case "destination-denied":
    case "unsupported-extension":
      return t("desktop.output.destDenied", { host });
    case "stale":
    case "invalid-state":
      return t("desktop.job.gone", { host });
    case "partial-discarded":
      return t("desktop.tile.partialDiscarded", { host });
    case "no-usable-tiles":
    case "decode-failed":
    case "processing-failed":
      return t("desktop.tile.partialChoice", { host });
    case "no-image-found":
    case "empty-resource":
    case "unknown-format":
    case "malformed-metadata":
    case "discovery-failed":
    case "deferred-limit":
      return t("view.discovery.none");
    case "plan-empty":
    case "resource-limit":
      return t("desktop.plan.none", { host });
    case "bad-url":
    case "bad-redirect":
    case "redirect-limit":
    case "timeout":
    case "network-failure":
    case "proxy-error":
      return t("desktop.transport.stalled", { host });
    case "write-failed":
    case "output-not-found":
    case "output-no-parent":
    case "launch-failed":
    case "invoke-failed":
      return t("desktop.output.writeFail", { host });
    case "cancelled":
      return t("desktop.job.cancelledMsg");
    case "start-failed":
      return t("desktop.start.failed", { host });
    case "choice-failed":
    case "interaction-expired":
      return t("desktop.choice.failed");
    case "internal":
    case "shell-lock":
    case "binding-invalid-value":
    case "registration-failed":
      return t("desktop.internal.error", { host });
    case "policy-denied":
      return t("desktop.save.generic", { host });
    case "invalid-input":
    case "invalid-options":
    case "size-limit":
    case "proxy-budget-exceeded":
    case "duplicate":
      return t("desktop.save.fallback", { host });
    default: {
      // Exhaustiveness guard: a new Rust variant must choose its wording
      // here before this compiles. Unrecognized payloads stay on the
      // generic sentence at runtime.
      const exhaustive: never = cause;
      void exhaustive;
      return t("desktop.save.fallback", { host });
    }
  }
}
