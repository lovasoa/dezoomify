// Shared failure presentation: the single place every product turns a typed
// failure into the `StructuredError` the error view renders.
//
// Layered presentation (docs/errors.md): the prominent `message` is a plain,
// jargon-free sentence naming the step and the next action; the engine's raw
// diagnostics (for discovery, the headline-free per-format bullet block) go to
// the expandable `detail`, never the first message. Hosts pass the typed facts
// and never re-implement the split.
//
// Erasable-syntax-only TypeScript (type aliases, plain functions) so node can
// type-strip it directly in tests, exactly like `i18n.ts`.

import { t } from "./i18n.ts";
import type { StructuredError } from "./snapshot-view.ts";

// JPEG addresses at most 65535 px per side (copy interpolation only).
const JPEG_MAX_SIDE = 65535;

/** Stable error classification derived from the code, never from text. */
export function categoryFor(code: unknown): string {
  if (typeof code !== "string") return "transport";
  if (code === "INVALID_URL" || code === "INVALID_SETTINGS") return "validation";
  if (typeof code === "string" && code.toLowerCase() === "adapter.wrong-state") {
    return "internal";
  }
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code.indexOf("OUTPUT_") === 0 || code === "OUTPUT_DENIED") return "output";
  if (code === "WORKER_FAILED" || code === "PLAN_INVALID") return "internal";
  const lower = code.toLowerCase();
  if (lower.indexOf("protocol.incompatible") === 0 || lower.indexOf("handoff.rejected") === 0)
    return "validation";
  if (lower.indexOf("discovery.") === 0 || lower.indexOf("job.discovery") >= 0) return "discovery";
  if (lower.indexOf("output.") === 0) return "output";
  if (lower.indexOf("internal") >= 0 || lower === "native.internal") return "internal";
  if (lower.indexOf("job.invalid") >= 0 || lower.indexOf("command.") === 0) return "validation";
  return "transport";
}

export function phaseFor(code: unknown): string {
  if (typeof code !== "string") return "acquisition";
  if (code === "NO_IMAGE_FOUND") return "discovery";
  if (code.indexOf("OUTPUT_") === 0 || code === "OUTPUT_DENIED") return "output";
  const lower = code.toLowerCase();
  if (lower === "protocol.incompatible") return "handshake";
  if (lower === "handoff.rejected") return "validation";
  if (lower.indexOf("discovery.") === 0 || lower.indexOf("job.discovery") >= 0) return "discovery";
  if (lower === "tile.decode-failed" || lower.indexOf("decode.") === 0) return "decode";
  if (lower === "tile.processing-failed") return "processing";
  if (lower.indexOf("output.") === 0) return "output";
  if (lower === "job.cancelled") return "cleanup";
  if (
    lower.indexOf("job.resource") === 0 ||
    lower.indexOf("job.plan") === 0 ||
    lower.indexOf("job.probe") === 0
  )
    return "acquisition";
  if (
    lower.indexOf("command.") === 0 ||
    lower.indexOf("job.invalid") >= 0 ||
    lower.indexOf("job.post-terminal") >= 0 ||
    lower.indexOf("job.unknown") >= 0 ||
    lower.indexOf("job.stale") >= 0
  )
    return "validation";
  return "acquisition";
}

/** Default retryability when a host does not supply the backend verdict. */
export function retryableFor(code: unknown): boolean {
  if (typeof code !== "string") return true;
  return (
    code !== "INVALID_URL" &&
    code !== "INVALID_SETTINGS" &&
    code !== "NO_IMAGE_FOUND" &&
    code !== "OUTPUT_DENIED"
  );
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
  if (lowerCode === "adapter.wrong-state") {
    return t("view.ext.desynced");
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
  if (
    lowerCode === "job.post-terminal" ||
    lowerCode === "job.unknown" ||
    lowerCode === "job.stale"
  ) {
    return t("desktop.job.gone", { host });
  }
  if (lowerCode === "output.canvas-limit" || lowerCode.indexOf("canvas-limit") >= 0) {
    const dim = engine.match(/(\d+)\s*x\s*(\d+)/);
    const needMatch = engine.match(/needs\s+([0-9.]+\s*GiB[^,;]*|[0-9,]+\s*bytes[^,;]*)/i);
    const dims = dim
      ? t("desktop.msg.dimsPixels", { a: dim[1], b: dim[2] })
      : t("desktop.msg.thisPicture");
    const need = needMatch ? t("desktop.msg.needAbout", { need: needMatch[1].trim() }) : "";
    const availableMatch = engine.match(/only\s+([^;]+)\s+is currently available/i);
    return t("desktop.output.canvasLimit", {
      dims,
      need,
      limit: availableMatch ? availableMatch[1].trim() : "currently available memory",
      jpegMax: JPEG_MAX_SIDE,
      host,
    });
  }
  if (lowerCode === "output.encode-failed" && /65535|jpeg/i.test(engine)) {
    const dim = engine.match(/(\d+)\s*x\s*(\d+)/);
    const dims = dim
      ? t("desktop.msg.dimsPixels", { a: dim[1], b: dim[2] })
      : t("desktop.msg.thisPicture");
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
    code === "DISCOVERY_FAILED" ||
    lowerCode === "discovery.failed" ||
    lowerCode.indexOf("discovery.no-image") >= 0 ||
    lowerCode.indexOf("discovery.failed") >= 0 ||
    lowerCode.indexOf("discovery.") === 0 ||
    lowerCode.indexOf("job.discovery") >= 0 ||
    lowerCode.indexOf("job.no-images") >= 0 ||
    lowerCode.indexOf("job.catalog") >= 0 ||
    lowerCode.indexOf("job.empty") >= 0 ||
    lowerCode.indexOf("unknown-format") >= 0
  ) {
    return t("view.discovery.none");
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

/** Typed facts every product hands to the shared presenter. */
export interface FailureFacts {
  code: string;
  /** Engine diagnostics (headline-free bullet block). Rendered only in details. */
  engineDetail?: string;
  /** Extra host provenance appended to the engine block in `detail`. */
  extraDetail?: string;
  /** Already-human sentence; when omitted the shared copy table selects one. */
  message?: string;
  category?: string;
  phase?: string;
  retryable?: boolean;
  transport?: string;
  url?: string;
  http?: number;
  preview?: string;
  extras?: string[];
  /** Source host used by copy interpolation. */
  host?: string;
}

/**
 * Build the shared `StructuredError`: the plain headline in `message`, the
 * engine block in `detail`, stable classification, and the optional
 * on-device fetch context. Every product renders this through the same view.
 */
export function describeFailure(facts: FailureFacts): StructuredError {
  const code = String(facts.code ?? "");
  const host = facts.host ?? "";
  const engineDetail = facts.engineDetail ?? "";
  const detail = [engineDetail, facts.extraDetail]
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join("\n\n");
  const error: StructuredError = {
    code,
    category: facts.category ?? categoryFor(code),
    retryable: facts.retryable ?? retryableFor(code),
    message: facts.message ?? plainMessageFor(code, engineDetail, host),
    phase: facts.phase ?? phaseFor(code),
  };
  if (facts.transport) error.transport = facts.transport;
  if (detail !== "") error.detail = detail;
  if (facts.url) error.url = facts.url;
  if (typeof facts.http === "number") error.http = facts.http;
  if (facts.preview) error.preview = facts.preview;
  if (facts.extras && facts.extras.length > 0) error.extras = facts.extras;
  return error;
}
