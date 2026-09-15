//! Deterministic projection of [`crate::dto`] into TypeScript, JSON Schema,
//! browser constants and TypeScript boundary types. Generation is byte-identical across
//! runs: no timestamps, sorted keys, LF endings. This module performs no I/O;
//! the `generate-protocol` binary writes the returned artifacts.

use crate::dto::{
    DIRECT_TRANSPORT_LABEL, FORMAT_GRID, MAX_BROWSER_AREA, METADATA_WINDOW_MS, POWER_USER_FORMATS,
    PROTOCOL_VERSION, PROXY_MAX_BYTES, PROXY_TRANSPORT_LABEL,
};

pub const GENERATED_MARKER: &str =
    "// DO NOT EDIT: generated from crates/dezoomify-protocol/src/dto.rs";

fn format_grid_ts() -> String {
    let mut out = String::from("export const FORMAT_GRID = [\n");
    for (id, display) in FORMAT_GRID {
        let power = POWER_USER_FORMATS.contains(id);
        out.push_str(&format!(
            "  {{ id: \"{id}\", displayName: \"{display}\", powerUser: {power} }},\n"
        ));
    }
    out.push_str("] as const;\n");
    out
}

#[must_use]
pub fn typescript() -> String {
    let grid_ts = format_grid_ts();
    format!(
        r#"{GENERATED_MARKER}
// protocol: {PROTOCOL_VERSION}

export const PROTOCOL_VERSION = "{PROTOCOL_VERSION}" as const;

export const MAX_BROWSER_AREA = {MAX_BROWSER_AREA} as const;
export const PROXY_MAX_BYTES = {PROXY_MAX_BYTES} as const;
export const METADATA_WINDOW_MS = {METADATA_WINDOW_MS} as const;

export const DIRECT_TRANSPORT_LABEL = "{DIRECT_TRANSPORT_LABEL}" as const;
export const PROXY_TRANSPORT_LABEL = "{PROXY_TRANSPORT_LABEL}" as const;

{grid_ts}
export type RequestPurpose = "metadata" | "tile" | "probe";
export type Readiness = "ready" | "deferred";
export type BufferState = "allocated" | "committed" | "consumed" | "freed";
export type RecoveryKind = "retry" | "edit-input" | "choose-output" | "grant-permission" | "change-transport" | "keep-partial" | "discard-partial" | "handoff-to-native";
export type EventKind = "replayable" | "transient" | "decision-requesting" | "terminal";

export interface RequestDto {{ id: string; uri: string; headers: {{ name: string; value: string }}[]; purpose: RequestPurpose }}
export interface BufferHandle {{ id: string; generation: number; length: number; checksum?: string }}
export interface ImageDto {{ id: string; title?: string; format: string; width: number; height: number; readiness: Readiness; sourceKind: string; levels: LevelDto[] }}
export interface LevelDto {{ id: string; width: number; height: number; tileWidth: number; tileHeight: number }}
export interface CatalogDto {{ images: ImageDto[] }}
export interface NativeCookie {{ name: string; value: string; origin: string }}
export type NativeHostRequest =
  | {{ kind: "handshake"; protocol?: string; clientVersion?: number }}
  | {{ kind: "negotiate"; clientVersion: number; jobId: string; extensionId?: string }}
  | {{ kind: "consent"; challenge: string; nonce: string; jobId: string; origins: string[]; cookieNames?: string[]; confirmed: boolean }}
  | {{ kind: "credential"; challenge: string; nonce: string; jobId: string; sourceUrl: string; origins: string[]; cookies?: NativeCookie[] }}
  | {{ kind: "decline"; challenge: string }};
export interface ErrorDto {{ code: string; phase: string; retryable: boolean; message: string; recovery?: unknown[]; transport?: string; blockedReason?: string; resourceKind?: string }}
"#
    )
}

/// Pure artifact projection: returns sorted `(relative path, content)`
/// pairs without touching the filesystem. The binary writes them.
#[must_use]
pub fn artifacts() -> Vec<(String, String)> {
    let mut files = vec![("src/generated.ts".to_string(), typescript())];
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
