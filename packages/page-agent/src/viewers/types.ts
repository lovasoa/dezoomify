import type { ObservedInput } from "@dezoomify/wasm-bindings";
/** Candidate original image discovered in an inspected viewer. */
export interface LoadedImage {
  url: string;
  width: number;
  height: number;
}

export type ViewerEvidence = { input: ObservedInput; handle?: string } | { image: LoadedImage };

export interface SourceGeometry {
  width: number;
  height: number;
  tileWidth: number;
  tileHeight: number;
  format: string;
}

export interface DziSource extends SourceGeometry {
  protocol: "dzi";
  base: string;
  overlap: number;
}

export interface ZoomifySource extends SourceGeometry {
  protocol: "zoomify";
  base: string;
  tileCount: number;
}

export interface IiifTile {
  width: number;
  height: number;
  scaleFactors: number[];
}

export interface IiifSource extends SourceGeometry {
  protocol: "iiif";
  id: string;
  version: 2 | 3;
  tiles: IiifTile[];
}

export interface IipSource extends SourceGeometry {
  protocol: "iip";
  server: string;
  image: string;
  transforms: string;
  levels: number;
}

export const krpanoShapes = [
  "cube",
  "cylinder",
  "flat",
  "sphere",
  "left",
  "right",
  "front",
  "back",
  "up",
  "down",
] as const;

export interface KrpanoShape {
  readonly type: (typeof krpanoShapes)[number];
  readonly url: string;
}

export interface KrpanoLevel {
  readonly width: number;
  readonly height: number;
  readonly shapes: readonly KrpanoShape[];
}

export interface KrpanoSource {
  readonly protocol: "krpano";
  readonly tileSize: number;
  readonly baseIndex: number;
  readonly levels: readonly KrpanoLevel[];
}

export type TileSource = DziSource | ZoomifySource | IiifSource | IipSource | KrpanoSource;

export interface MetadataContext {
  documentUrl: string;
  imageIndex: number;
}

export type StopReason =
  | "image-limit"
  | "payload-limit"
  | "frame-limit"
  | "node-limit"
  | "reference-limit";

export interface ScanDiagnostics {
  documents: number;
  nodes: number;
  references: number;
  viewers: number;
  probes: number;
  rejected: number;
  bytes: number;
  truncated: boolean;
  elapsedMs: number;
  versions: string;
  stopped: string;
  frames: string[];
}

export interface ScanResult {
  ok: true;
  documentUrl: string;
  inputs: ObservedInput[];
  images: LoadedImage[];
  handles: string[];
  /** Job-scoped page listener for live tile requests; absent if no live handles. */
  channelId?: string;
  diagnostics: ScanDiagnostics;
}

export type PageRealm = Window & typeof globalThis;
