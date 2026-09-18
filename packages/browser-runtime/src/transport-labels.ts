// Canonical transport labels (single source in `@dezoomify/app-model`).
//
// Every app renders transports through these codes, never a local duplicate.
// This module re-exports the host-neutral labels so existing
// `browser-runtime` imports keep working without a fork. The dependency runs
// browser-runtime -> app-model only: shared-ui never imports browser-runtime
// and app-model never imports browser-runtime, so no cycle can form. Keep
// this file erasable-syntax-only so node type-stripping can import it.
export {
  BROWSER_SESSION_TRANSPORT_LABEL,
  DIRECT_TRANSPORT_LABEL,
  DISPLAY_TRANSPORT_LABEL,
  NATIVE_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
} from "@dezoomify/app-model";
