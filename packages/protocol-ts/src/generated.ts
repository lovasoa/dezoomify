// DO NOT EDIT: generated from crates/dezoomify-protocol/src/dto.rs
// protocol: 2.0

export const PROTOCOL_VERSION = "2.0" as const;

export const MAX_BROWSER_AREA = 268435456 as const;
export const PROXY_MAX_BYTES = 2097152 as const;
export const METADATA_WINDOW_MS = 1500 as const;

export const DIRECT_TRANSPORT_LABEL = "Direct from your browser" as const;
export const PROXY_TRANSPORT_LABEL = "Metadata proxy" as const;

export const FORMAT_GRID = [
  { id: "custom", displayName: "Custom tiles", powerUser: true },
  { id: "google_arts_and_culture", displayName: "Arts & Culture", powerUser: false },
  { id: "zoomify", displayName: "Zoomify", powerUser: false },
  { id: "iiif", displayName: "IIIF", powerUser: false },
  { id: "deepzoom", displayName: "Seadragon (Deep Zoom Image)", powerUser: false },
  { id: "generic", displayName: "Generic dezoomer", powerUser: false },
  { id: "krpano", displayName: "krpano", powerUser: false },
  { id: "iipimage", displayName: "IIPImage", powerUser: false },
  { id: "xlimage", displayName: "XLimage", powerUser: false },
  { id: "topviewer", displayName: "TopViewer", powerUser: false },
  { id: "fsi", displayName: "FSI", powerUser: false },
  { id: "lizardtech", displayName: "LizardTech ImageServer", powerUser: false },
  { id: "vls", displayName: "VLS", powerUser: false },
  { id: "hungaricana", displayName: "Hungaricana", powerUser: false },
  { id: "wmts", displayName: "WMTS", powerUser: false },
  { id: "arcgis", displayName: "ArcGIS MapServer", powerUser: false },
  { id: "pnav", displayName: "pnav", powerUser: false },
  { id: "bulk_text", displayName: "Bulk text", powerUser: true },
] as const;

export type RequestPurpose = "metadata" | "tile" | "probe";
export type Readiness = "ready" | "deferred";
export type BufferState = "allocated" | "committed" | "consumed" | "freed";
export type RecoveryKind = "retry" | "edit-input" | "choose-output" | "grant-permission" | "change-transport" | "keep-partial" | "discard-partial" | "handoff-to-native";
export type EventKind = "replayable" | "transient" | "decision-requesting" | "terminal";

export interface RequestDto { id: number; uri: string; headers: { name: string; value: string }[]; purpose: RequestPurpose }
export interface BufferHandle { id: string; generation: number; length: number; checksum?: string }
export interface ImageDto { title?: string; format: string; width: number; height: number; readiness: Readiness; sourceKind: string; levels: LevelDto[] }
export interface LevelDto { label: string; width: number; height: number; tileWidth: number; tileHeight: number }
export interface CatalogDto { images: ImageDto[] }
export interface NativeCookie { name: string; value: string; origin: string }
export type NativeHostRequest =
  | { kind: "handshake"; protocol?: string; clientVersion?: number }
  | { kind: "negotiate"; clientVersion: number; jobId: string; extensionId?: string }
  | { kind: "consent"; challenge: string; nonce: string; jobId: string; origins: string[]; cookieNames?: string[]; confirmed: boolean }
  | { kind: "credential"; challenge: string; nonce: string; jobId: string; sourceUrl: string; origins: string[]; cookies?: NativeCookie[] }
  | { kind: "decline"; challenge: string };
export interface ErrorDto { code: string; phase: string; retryable: boolean; message: string; recovery?: unknown[]; transport?: string; blockedReason?: string; resourceKind?: string }
