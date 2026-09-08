// GENERATED from packages/shared-ui/src/saveName.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/shared-ui/src/saveName.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Shared save-name helper (todo 2.2 single source, lowest layer).
//
// The implementation lives one layer down in
// `packages/browser-runtime/src/save-name.ts` (dependency-free); this module
// only re-exports it for rendering, so the dependency points inward. Covers
// PNG/JPEG/TIFF plus ZIF, WebP, and `iiif-dir` (todo 5.1 desktop parity).
import * as SaveName from "./save-name.js";
const { extensionForSaveFormat, suggestedNameFor } = SaveName;
export { extensionForSaveFormat, suggestedNameFor };
