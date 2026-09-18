// Shared save-name helper (single source).
//
// The implementation lives in `@dezoomify/app-model` (host-neutral,
// dependency-free); this module only re-exports it for rendering. Covers
// PNG/JPEG/TIFF plus ZIF, WebP, and `iiif-dir` (desktop parity).
import * as SaveName from "@dezoomify/app-model";
const { extensionForSaveFormat, suggestedNameFor, safeTitleStem } = SaveName;
export { extensionForSaveFormat, suggestedNameFor, safeTitleStem };
export type { SaveNameFormat } from "@dezoomify/app-model";
