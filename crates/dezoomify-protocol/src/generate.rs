//! Deterministic projection of [`crate::dto`] into TypeScript, JSON Schema,
//! capability manifests, and fingerprints. Generation is byte-identical across
//! runs: no timestamps, sorted keys, LF endings. This module performs no I/O;
//! the `generate-protocol` binary writes the returned artifacts.

use crate::dto::{
    CapabilitiesDto, DIRECT_TRANSPORT_LABEL, FORMAT_GRID, MAX_BROWSER_AREA, METADATA_WINDOW_MS,
    POWER_USER_FORMATS, PROTOCOL_VERSION, PROXY_MAX_BYTES, PROXY_TRANSPORT_LABEL,
};

pub const GENERATED_MARKER: &str =
    "// DO NOT EDIT: generated from crates/dezoomify-protocol/src/dto.rs";

/// FNV-1a 64-bit offset basis (standard constant, also used for cache keys).
const FNV_OFFSET_BASIS: u64 = 0xcbf29ce484222325;

/// Stable fingerprint of the canonical DTO source (first 16 hex of a
/// deterministic hash over DTO names + version).
#[must_use]
pub fn dto_fingerprint() -> String {
    let seed = format!(
        "protocol={PROTOCOL_VERSION};ids=sess,scan,cand,job,op,req,img,lvl,tile,att,fx,buf,dst,out,rec,hand;messages=command,effect,event,scan,handoff,error"
    );
    let mut hash: u64 = FNV_OFFSET_BASIS;
    for b in seed.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

/// Stable fingerprint of the single limits/grid/transports generation
/// (first 16 hex of FNV-1a over the three limits plus format grid plus
/// transport labels). Extends the dto fingerprint plumbing without
/// changing the dto value, so existing capability documents keep matching.
#[must_use]
pub fn limits_fingerprint() -> String {
    let mut seed = format!(
        "limits={MAX_BROWSER_AREA},{PROXY_MAX_BYTES},{METADATA_WINDOW_MS};transports={DIRECT_TRANSPORT_LABEL},{PROXY_TRANSPORT_LABEL};formats="
    );
    for (id, display) in FORMAT_GRID {
        let power = if POWER_USER_FORMATS.contains(id) {
            "p"
        } else {
            "-"
        };
        seed.push_str(&format!("{id}:{display}:{power},"));
    }
    let mut hash: u64 = FNV_OFFSET_BASIS;
    for b in seed.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

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
    let fingerprint = dto_fingerprint();
    let limits_fp = limits_fingerprint();
    let grid_ts = format_grid_ts();
    format!(
        r#"{GENERATED_MARKER}
// fingerprint: {fingerprint}
// limits-fingerprint: {limits_fp}
// protocol: {PROTOCOL_VERSION}

export const PROTOCOL_VERSION = "{PROTOCOL_VERSION}" as const;
export const DTO_FINGERPRINT = "{fingerprint}" as const;
export const LIMITS_FINGERPRINT = "{limits_fp}" as const;

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
export type ExtensionTransportOutcome = "source-document-lost" | "access-required" | "redirect-unavailable" | "cancelled" | "network" | "throttled" | "malformed" | "limit-exceeded" | "disconnected";

export interface RequestDto {{ id: string; uri: string; headers: {{ name: string; value: string }}[]; purpose: RequestPurpose }}
export interface BufferHandle {{ id: string; generation: number; length: number; checksum?: string }}
export interface ImageDto {{ id: string; label: string; format: string; width: number; height: number; readiness: Readiness; sourceKind: string; levels: LevelDto[] }}
export interface LevelDto {{ id: string; width: number; height: number; tileWidth: number; tileHeight: number }}
export interface CatalogDto {{ images: ImageDto[] }}
export interface CandidateDto {{ id: string; url: string; formatHint: string; confidence: number; reason: string; dedupKey: string; sourceFrame: string }}
export interface SourceBindingDto {{ job: string; tabId: number; frameId: number; documentGeneration: number }}
export interface CandidateChunkDto {{ binding: SourceBindingDto; request: string; candidates: CandidateDto[]; complete: boolean }}
export interface SourceFetchRequestDto {{ binding: SourceBindingDto; request: RequestDto }}
export interface ByteChunkDto {{ binding: SourceBindingDto; request: string; sequence: number; buffer: BufferHandle; finalChunk: boolean }}
export interface ChunkAcknowledgementDto {{ binding: SourceBindingDto; request: string; sequence: number }}
export interface CapabilitiesDto {{ inputSchemes: string[]; fetchModes: string[]; decoders: string[]; processingOps: string[]; encoders: string[]; destinationModes: string[]; storageModes: string[]; maxConcurrency: number; maxTileBytes: number; bulkSupported: boolean; handoffSupported: boolean; pausedSupported: boolean }}
export interface HandoffDto {{ id: string; sourceUrl: string; candidate?: string; selection?: string; outputIntent?: string; requiredCapabilities: string[]; provenanceLabel: string; expiryHint?: string; opaqueRef?: string }}
export interface ErrorDto {{ code: string; phase: string; retryable: boolean; message: string; recovery?: unknown[]; transport?: string; blockedReason?: string; resourceKind?: string }}
"#
    )
}

#[must_use]
pub fn protocol_schema() -> serde_json::Value {
    serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "dezoomify-protocol-v1",
        "type": "object",
        "required": ["protocol", "kind"],
        "properties": {
            "protocol": {"const": PROTOCOL_VERSION},
            "kind": {"type": "string"}
        }
    })
}

#[must_use]
pub fn capabilities_schema() -> serde_json::Value {
    serde_json::json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "title": "dezoomify-capabilities-v1",
        "type": "object",
        "required": ["fetchModes", "decoders", "encoders"],
        "properties": {
            "fetchModes": {"type": "array", "items": {"type": "string"}},
            "decoders": {"type": "array", "items": {"type": "string"}},
            "encoders": {"type": "array", "items": {"type": "string"}}
        }
    })
}

#[must_use]
pub fn capability_manifest(capabilities: &CapabilitiesDto) -> serde_json::Value {
    serde_json::json!({
        "protocol": PROTOCOL_VERSION,
        "fingerprint": dto_fingerprint(),
        "keys": capabilities.keys(),
    })
}

/// Pure artifact projection: returns sorted `(relative path, content)`
/// pairs without touching the filesystem. The binary writes them.
#[must_use]
pub fn artifacts() -> Vec<(String, String)> {
    // `serde_json::Value` pretty-printing is infallible (string-keyed maps
    // only); the empty-string fallback is unreachable and fail-closed
    // downstream (the `--check` drift comparison catches it). It exists so
    // this module keeps the crate-root deny on `clippy::unwrap_used`.
    let pretty =
        |value: &serde_json::Value| serde_json::to_string_pretty(value).unwrap_or_default() + "\n";
    let mut files: Vec<(String, String)> = vec![
        ("src/generated.ts".to_string(), typescript()),
        (
            "schema/protocol-v1.schema.json".to_string(),
            pretty(&protocol_schema()),
        ),
        (
            "schema/capabilities-v1.schema.json".to_string(),
            pretty(&capabilities_schema()),
        ),
        (
            "fingerprints.json".to_string(),
            pretty(&serde_json::json!({
                "dto": dto_fingerprint(),
                "limits": limits_fingerprint(),
                "protocol": PROTOCOL_VERSION,
            })),
        ),
    ];
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
