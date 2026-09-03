# Browser Extension

- **Responsibility:** Run a finite scan for an explicitly activated tab, detect
  candidate zoomable resources, show status, and hand selected candidates to
  the embedded Studio with narrowly scoped browser capabilities.
- **Allowed dependencies:** `packages/browser-runtime`,
  `packages/protocol-ts`, shared recognition data, and browser extension APIs.
- **Forbidden responsibilities:** No always-on global monitoring, duplicate
  dezoomers, silent credential export, broad persistent permissions without
  need, hosted proxy use, JavaScript private signing key, scan rearming caused by
  a Studio reload, or listeners/timers surviving their session.
- **Interfaces and tests:** Start only on explicit extension action, register the
  per-tab scan before its one reload, and stop after settling, a deadline, or
  Studio/tab close. Normally fetch active-job resources directly with the
  current browser session and granted host permissions, create blob-backed
  images or `ImageBitmap` tiles, and compose them on an origin-clean canvas; a
  same-origin/page-context fallback may exist. Test one listener per tab,
  deduplication, finite deadlines, no reload rearm, cleanup, permissions, direct
  readable fetch, and clean export.
- **Handoffs:** Treat website/deep-link input as bounded, versioned, non-secret,
  untrusted data requiring validation and user confirmation. For Native
  Messaging, browser enforcement of the native host manifest's allowed extension
  IDs authenticates the extension sender. A fresh challenge/nonce binds one
  handoff and its consent and blocks replay; it does not establish identity.
  Cookie handoff is native-only, explicitly consented, origin-scoped,
  intentionally unpersisted, and best-effort short-lived, with no guarantee of
  zeroization in managed memory. Website proxy fallback neither carries cookies
  nor supplies cookie-handoff consent.
- **Migration source:** Migrate recognition and lifecycle behavior from
  `migration-sources/dezoomify-extension`.
