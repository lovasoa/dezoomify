// Localized error headlines retain the complete generated error facts.
import type { Error as JobError } from "@dezoomify/wasm-bindings";
import { t } from "./i18n.ts";

// JPEG addresses at most 65535 px per side (copy interpolation only).
const JPEG_MAX_SIDE = 65535;

// Error copy: every code has plain jargon-free wording that names
// the step, the picture source, and the single best next action. Technical
// vocabulary (transport names, statuses, raw failure chains) stays out of
// this sentence; it belongs in the collapsible detail built beside it.
export function plainMessageFor(code: string, sourceMessage: string, host: string): string {
  const message = String(sourceMessage ?? "");
  const lowerCode = String(code ?? "").toLowerCase();
  // Browser canvas failure family (allocation, 2D context, PNG encoding):
  // the plain sentence names the desktop app before any generic branch.
  if (code === "PLAN_INVALID" || code === "OUTPUT_ALLOCATION_FAILED") {
    return t("view.fail.canvasAllocation");
  }
  if (code === "OUTPUT_SURFACE_UNAVAILABLE") {
    return t("view.fail.canvasContext");
  }
  if (code === "OUTPUT_ENCODE_FAILED") {
    return t("view.fail.canvasEncode");
  }
  if (code === "INVALID_URL") {
    return t("desktop.url.notWebPage");
  }
  if (code === "INVALID_SETTINGS") {
    return t("desktop.settings.unusable");
  }
  if (code === "OUTPUT_DENIED") {
    return t("desktop.output.deniedPick");
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
  if (lowerCode === "job.unknown" || lowerCode === "job.stale") {
    return t("desktop.job.gone", { host });
  }
  if (lowerCode === "output.canvas-limit" || lowerCode.indexOf("canvas-limit") >= 0) {
    const dim = message.match(/(\d+)\s*x\s*(\d+)/);
    const needMatch = message.match(/needs\s+([0-9.]+\s*GiB[^,;]*|[0-9,]+\s*bytes[^,;]*)/i);
    const dims = dim
      ? t("desktop.msg.dimsPixels", { a: dim[1], b: dim[2] })
      : t("desktop.msg.thisPicture");
    const need = needMatch ? t("desktop.msg.needAbout", { need: needMatch[1].trim() }) : "";
    const availableMatch = message.match(/only\s+([^;]+)\s+is currently available/i);
    return t("desktop.output.canvasLimit", {
      dims,
      need,
      limit: availableMatch ? availableMatch[1].trim() : "currently available memory",
      jpegMax: JPEG_MAX_SIDE,
      host,
    });
  }
  if (lowerCode === "output.encode-failed" && /65535|jpeg/i.test(message)) {
    const dim = message.match(/(\d+)\s*x\s*(\d+)/);
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
  if (lowerCode.indexOf("internal") >= 0 || code === "PLAN_INVALID") {
    return t("desktop.internal.error", { host });
  }
  return t("desktop.save.fallback", { host });
}

/** Keep diagnostic facts intact while choosing the localized headline. */
export function describeFailure(error: JobError, host = ""): JobError {
  return {
    ...error,
    message:
      error.transport === "metadata-proxy"
        ? error.message
        : plainMessageFor(error.code, error.message, host),
    detail: error.detail ?? error.message,
  };
}
