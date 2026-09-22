// Shared validation for concrete JobService implementations. Runtime-owned
// services keep identity, observer forwarding, and disposal at one boundary.

import type { JobStartRequest } from "./types.ts";

/** Validate the host-neutral portion of a job request at a service boundary. */
export function validateJobStartRequest(request: JobStartRequest): string | null {
  if (!request || typeof request !== "object") return "validation.bad-request";
  if (!Array.isArray(request.inputs) || request.inputs.length === 0) {
    return "validation.empty-inputs";
  }
  for (const input of request.inputs) {
    const url = (input as { url?: unknown }).url;
    if (typeof url !== "string" || url.trim() === "" || url.length > 2048) {
      return "validation.bad-input-url";
    }
  }
  if (!request.host || typeof request.host !== "object") return "validation.bad-exec";
  const kind = (request.host as { kind?: unknown }).kind;
  if (kind !== "browser" && kind !== "native") return "validation.bad-exec-kind";
  if (kind === "browser") {
    const sourceUrl = (request.host as { sourceUrl?: unknown }).sourceUrl;
    if (typeof sourceUrl !== "string" || sourceUrl.trim() === "" || sourceUrl.length > 2048) {
      return "validation.bad-exec-source";
    }
  }
  if (kind === "native") {
    const dest = (request.host as { destination?: unknown }).destination;
    if (!dest || typeof dest !== "object") return "validation.bad-destination";
  }
  if (!request.engine || typeof request.engine !== "object") return "validation.bad-engine";
  return null;
}
