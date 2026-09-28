// Desktop Tauri event channels and payload guards.
//
// The desktop job keeps pixels in the native runtime. Only the
// self-describing `job-snapshot` (one routing id plus the canonical
// `Snapshot` the service forwards verbatim to its observer)
// crosses the IPC boundary; tile bytes never do.
// This module names the allowed channels and guards their payloads.

// Keep erasable syntax only so node type-stripping can read this file.

import type { Snapshot } from "@dezoomify/app-model";

export const DESKTOP_EVENT_CHANNELS = [
  "dezoomify://job-snapshot",
  "dezoomify://deep-link-pending",
] as const;

export type DesktopEventChannel = (typeof DESKTOP_EVENT_CHANNELS)[number];

/// Canonical runner snapshot, emitted on `dezoomify://job-snapshot`
/// for every runner snapshot the shell forwards verbatim. The payload is
/// the authoritative `Snapshot`: revision, lifecycle, paused,
/// progress, selection (with catalog), decision, terminal, and output.
/// The snapshot carries no job identity, so the host wraps it once instead of
/// mutating it with routing aliases.
export interface JobSnapshotPayload {
  job: string;
  snapshot: Snapshot;
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
