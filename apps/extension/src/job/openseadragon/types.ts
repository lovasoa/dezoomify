import type { JobInput } from "@dezoomify/wasm-bindings";

export type ObservedMetadata = JobInput & { kind: "observed-metadata"; contents: string };

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

export type TileSource = DziSource | ZoomifySource | IiifSource | IipSource;

export interface MetadataContext {
  documentUrl: string;
  imageIndex: number;
}

export type StopReason =
  | "time-budget"
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
  inputs: ObservedMetadata[];
  diagnostics: ScanDiagnostics;
}

export type PageRealm = Window & typeof globalThis;
