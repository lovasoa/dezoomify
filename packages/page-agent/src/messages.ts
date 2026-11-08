/** The in-page to Dezoomify interface: every operation a page agent performs on
 * a host's behalf, and every value it can return.
 *
 * This is a wire contract, not a call convention. A host transports these JSON
 * values into and out of the inspected document by whatever means it has. The
 * browser extension awaits a returned promise; a webview host cannot, and posts
 * the reply back instead. Correlation, framing, and cancellation belong to that
 * transport and are deliberately absent here.
 *
 * Caller obligations:
 * - Replies never throw. A failure is `{ ok: false, error }` because an
 *   exception crossing a host boundary loses the structured `Error` facts the
 *   core's retry classification reads.
 * - Every reply names the document it answered from. A host must compare it
 *   with the document it asked and reject the reply if they differ.
 * - `read-tile` handles are opaque, scoped to one document, and only valid
 *   between `scan` and `release-tiles`. A host never constructs one.
 * - Replies are untrusted. The host validates every field before use; the page
 *   can replace the agent and forge any value it returns. */

import type {
  Error as JobError,
  ObservedInput,
  Size,
  ViewerTileRequest,
} from "@dezoomify/wasm-bindings";
import type { LoadedImage } from "./loaded-image.ts";
import type { ScanDiagnostics } from "./viewers/types.ts";

/** What one scan found. Tile handles appear in both `handles` and the viewer
 * observations that reference them; only `handles` retires them. */
export interface ScanResult {
  inputs: ObservedInput[];
  images: LoadedImage[];
  handles: string[];
  diagnostics: ScanDiagnostics;
}

/** Either an ordinary image URL to fetch, or owned encoded pixels. */
export type ViewerTileResult = { url: string } | { bytes: number; data: string };

/** What each operation returns on success, keyed by its `method`. */
export interface PageResults {
  scan: ScanResult;
  "read-tile": ViewerTileResult;
  "release-tiles": undefined;
  "find-loaded-image": LoadedImage | undefined;
  "find-image-link": string | undefined;
}

export type PageMethod = keyof PageResults;

export type PageRequest =
  /** Traverse the document and report every identified image source. */
  | { method: "scan" }
  /** Load one tile through the viewer that registered `request.handle`. */
  | { method: "read-tile"; request: ViewerTileRequest; extent: Size }
  /** Retire handles and stop their outstanding loads. Unknown handles are ignored. */
  | { method: "release-tiles"; handles: string[] }
  /** Pick the largest usable of the supplied candidates, else the document's own. */
  | { method: "find-loaded-image"; images: LoadedImage[] }
  /** The single image file the document offers for download, if it offers exactly one. */
  | { method: "find-image-link" };

/** A reply to `method`. Keyed by method so a host that asked one operation reads
 * that operation's result without re-establishing which reply it is holding. */
export type PageResponse<M extends PageMethod = PageMethod> =
  | { method: M; documentUrl: string; ok: true; result: PageResults[M] }
  | { method: M; documentUrl: string; ok: false; error: JobError };

/** The service installed in one inspected document. One method, one call shape. */
export interface PageAgent {
  handle(request: PageRequest): Promise<PageResponse>;
}
