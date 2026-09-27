// Shared validation for concrete JobService implementations. Runtime-owned
// services keep identity, observer forwarding, and disposal at one boundary.

import type { EngineStartRequest } from "./types.ts";

/** Validate the host-neutral portion of a job request at a service boundary. */
export function validateEngineStartRequest(request: EngineStartRequest): string | null {
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
  if (!request.engine || typeof request.engine !== "object") return "validation.bad-engine";
  return null;
}
