// GENERATED from packages/browser-runtime/src/transport-labels.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/browser-runtime/src/transport-labels.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Canonical transport labels (todo 2.2 single source, lowest layer).
//
// Every app renders transports through these codes, never a local duplicate.
// This module is dependency-free on purpose: `packages/shared-ui` re-exports
// these labels for rendering, and `packages/browser-runtime` reports them,
// so neither direction can form a runtime-to-UI import. Keep this file
// erasable-syntax-only so node type-stripping can import it.
export const DIRECT_TRANSPORT_LABEL = "Direct from your browser"         ;
export const PROXY_TRANSPORT_LABEL = "Metadata proxy"         ;
export const DISPLAY_TRANSPORT_LABEL = "Display only"         ;
export const BROWSER_SESSION_TRANSPORT_LABEL = "Browser session"         ;
export const NATIVE_TRANSPORT_LABEL = "Native"         ;
