// DO NOT EDIT: generated from crates/dezoomify-protocol/src/dto.rs
// fingerprint: b4bad92b24615c58
// protocol: 1.0

export const PROTOCOL_VERSION = "1.0" as const;
export const DTO_FINGERPRINT = "b4bad92b24615c58" as const;

export type RequestPurpose = "metadata" | "tile" | "probe";
export type Readiness = "ready" | "deferred";
export type BufferState = "allocated" | "committed" | "consumed" | "freed";
export type RecoveryKind = "retry" | "edit-input" | "choose-output" | "grant-permission" | "change-transport" | "keep-partial" | "discard-partial" | "handoff-to-native";
export type EventKind = "replayable" | "transient" | "decision-requesting" | "terminal";

export interface RequestDto { id: string; uri: string; headers: { name: string; value: string }[]; purpose: RequestPurpose }
export interface BufferHandle { id: string; generation: number; length: number; checksum?: string }
export interface ImageDto { id: string; label: string; format: string; width: number; height: number; readiness: Readiness; sourceKind: string; levels: LevelDto[] }
export interface LevelDto { id: string; width: number; height: number; tileWidth: number; tileHeight: number }
export interface CatalogDto { images: ImageDto[] }
export interface CandidateDto { id: string; url: string; formatHint: string; confidence: number; reason: string; dedupKey: string; sourceFrame: string }
export interface CapabilitiesDto { inputSchemes: string[]; fetchModes: string[]; decoders: string[]; processingOps: string[]; encoders: string[]; destinationModes: string[]; storageModes: string[]; maxConcurrency: number; maxTileBytes: number; bulkSupported: boolean; handoffSupported: boolean }
export interface HandoffDto { id: string; sourceUrl: string; candidate?: string; selection?: string; outputIntent?: string; requiredCapabilities: string[]; provenanceLabel: string; expiryHint?: string; opaqueRef?: string }
export interface ErrorDto { code: string; phase: string; retryable: boolean; message: string; recovery?: unknown[]; transport?: string; blockedReason?: string; resourceKind?: string }
