// Desktop Tauri event channels and IPC redaction guards.
//
// The desktop job keeps pixels in the native runtime. Only the
// self-describing `job-snapshot` (one routing id plus the canonical
// `EngineSnapshotDto` the service forwards verbatim to its observer)
// crosses the IPC boundary; tile bytes never do.
// This module names the allowed channels and guards their payloads.

// Keep erasable syntax only so node type-stripping can read this file.

import type { EngineSnapshotDto } from "@dezoomify/app-model";

export const DESKTOP_EVENT_CHANNELS = [
  "dezoomify://job-snapshot",
  "dezoomify://deep-link-pending",
] as const;

export type DesktopEventChannel = (typeof DESKTOP_EVENT_CHANNELS)[number];

/// Canonical runner snapshot, emitted on `dezoomify://job-snapshot`
/// for every runner snapshot the shell forwards verbatim. The payload is
/// the authoritative `EngineSnapshotDto`: revision, lifecycle, paused,
/// progress, selection (with catalog), decision, terminal, and output.
/// The DTO carries no job identity, so the host wraps it once instead of
/// mutating it with routing aliases.
export interface JobSnapshotPayload {
  job: string;
  snapshot: EngineSnapshotDto;
}

const FORBIDDEN_IPC_KEYS = new Set([
  "tilebytes",
  "tile_bytes",
  "tiledata",
  "tile_data",
  "pixels",
  "pixeldata",
  "pixel_data",
  "imagebytes",
  "image_bytes",
  "imagedata",
]);

const SECRET_KEY_FRAGMENTS = [
  "cookie",
  "authorization",
  "bearer",
  "token",
  "secret",
  "password",
  "session",
  "apikey",
  "api_key",
  "signature",
];

export function isDesktopEventChannel(value: string): value is DesktopEventChannel {
  return (DESKTOP_EVENT_CHANNELS as readonly string[]).includes(value);
}

function containsForbiddenKey(value: unknown, seen: Set<unknown>): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return false;
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsForbiddenKey(item, seen)) return true;
    }
    return false;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase().replace(/[-_]/g, "");
      // `bytes` alone is allowed only as a small numeric count, never as
      // a buffer. Buffers are caught above via ArrayBuffer/view checks.
      if (FORBIDDEN_IPC_KEYS.has(k.toLowerCase()) || FORBIDDEN_IPC_KEYS.has(lower)) {
        return true;
      }
      if (containsForbiddenKey(v, seen)) return true;
    }
  }
  return false;
}

// Throw when a payload would carry tile bytes over IPC.
// Progress counters stay allowed; buffers and pixel fields do not.
export function assertNoTileBytes(payload: unknown): void {
  if (containsForbiddenKey(payload, new Set())) {
    throw new Error("ipc.forbidden-tile-bytes: tile bytes must stay in the native runtime");
  }
}

function redactValue(key: string, value: unknown): unknown {
  const lower = key.toLowerCase();
  for (const frag of SECRET_KEY_FRAGMENTS) {
    if (lower.includes(frag)) return "REDACTED";
  }
  if (typeof value === "string") {
    let out = value;
    for (const needle of [
      "apiKey=",
      "api_key=",
      "token=",
      "session=",
      "cookie=",
      "Authorization:",
    ]) {
      let from = 0;
      while (true) {
        const at = out.indexOf(needle, from);
        if (at < 0) break;
        const start = at + needle.length;
        let end = out.length;
        for (const stop of ["&", " ", '"', "'"]) {
          const idx = out.indexOf(stop, start);
          if (idx >= 0 && idx < end) end = idx;
        }
        out = out.slice(0, start) + "REDACTED" + out.slice(end);
        from = start + "REDACTED".length;
      }
    }
    return out;
  }
  return value;
}

// Redact credential-bearing fields before an event crosses IPC or reaches logs.
export function redactForEvent(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof ArrayBuffer)) {
      out[k] = redactForEvent(v as Record<string, unknown>);
    } else {
      out[k] = redactValue(k, v);
    }
  }
  return out;
}
