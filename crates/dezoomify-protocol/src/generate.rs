//! Deterministic projection of [`crate::dto`] into TypeScript, JSON Schema,
//! capability manifests, and fingerprints. Generation is byte-identical across
//! runs: no timestamps, sorted keys, LF endings. This module performs no I/O;
//! the `generate-protocol` binary writes the returned artifacts.

use crate::dto::{CapabilitiesDto, PROTOCOL_VERSION};

pub const GENERATED_MARKER: &str =
    "// DO NOT EDIT: generated from crates/dezoomify-protocol/src/dto.rs";

/// Stable fingerprint of the canonical DTO source (first 16 hex of a
/// deterministic hash over DTO names + version).
#[must_use]
pub fn dto_fingerprint() -> String {
    let seed = format!(
        "protocol={PROTOCOL_VERSION};ids=sess,scan,cand,job,op,req,img,lvl,tile,att,fx,buf,dst,out,rec,hand;messages=command,effect,event,scan,handoff,error"
    );
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in seed.bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

#[must_use]
pub fn typescript() -> String {
    let fingerprint = dto_fingerprint();
    format!(
        r#"{GENERATED_MARKER}
// fingerprint: {fingerprint}
// protocol: {PROTOCOL_VERSION}

export const PROTOCOL_VERSION = "{PROTOCOL_VERSION}" as const;
export const DTO_FINGERPRINT = "{fingerprint}" as const;

export type RequestPurpose = "metadata" | "tile" | "probe";
export type Readiness = "ready" | "deferred";
export type BufferState = "allocated" | "committed" | "consumed" | "freed";
export type RecoveryKind = "retry" | "edit-input" | "choose-output" | "grant-permission" | "change-transport" | "keep-partial" | "discard-partial" | "handoff-to-native";
export type EventKind = "replayable" | "transient" | "decision-requesting" | "terminal";

export interface RequestDto {{ id: string; uri: string; headers: {{ name: string; value: string }}[]; purpose: RequestPurpose }}
export interface BufferHandle {{ id: string; generation: number; length: number; checksum?: string }}
export interface ImageDto {{ id: string; label: string; format: string; width: number; height: number; readiness: Readiness; sourceKind: string; levels: LevelDto[] }}
export interface LevelDto {{ id: string; width: number; height: number; tileWidth: number; tileHeight: number }}
export interface CatalogDto {{ images: ImageDto[] }}
export interface CandidateDto {{ id: string; url: string; formatHint: string; confidence: number; reason: string; dedupKey: string; sourceFrame: string }}
export interface CapabilitiesDto {{ inputSchemes: string[]; fetchModes: string[]; decoders: string[]; processingOps: string[]; encoders: string[]; destinationModes: string[]; storageModes: string[]; maxConcurrency: number; maxTileBytes: number; bulkSupported: boolean; handoffSupported: boolean }}
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
    let mut files: Vec<(String, String)> = vec![
        ("src/generated.ts".to_string(), typescript()),
        (
            "schema/protocol-v1.schema.json".to_string(),
            serde_json::to_string_pretty(&protocol_schema()).unwrap() + "\n",
        ),
        (
            "schema/capabilities-v1.schema.json".to_string(),
            serde_json::to_string_pretty(&capabilities_schema()).unwrap() + "\n",
        ),
        (
            "fingerprints.json".to_string(),
            serde_json::to_string_pretty(&serde_json::json!({
                "dto": dto_fingerprint(),
                "protocol": PROTOCOL_VERSION,
            }))
            .unwrap()
                + "\n",
        ),
    ];
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}
