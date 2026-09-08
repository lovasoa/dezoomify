# Browser Extension

Detects zoomable images in your current tab and hands the job to Dezoomify,
using your browser's own session so logged-in and interactive viewers work.

- **Use:** click the extension button on a page with a zoomable image (grey
  idle becomes blue with a dot while the job is active); the dedicated job tab
  snapshots the source page and saves the result. The source page is not
  reloaded, and a second click cancels the active job.
  Full steps: [browser extension](../../docs/user/browser-extension.md).
- Explicit-action jobs only: no background watching, auto-rearm, or unrelated
  tab monitoring. Navigation invalidates the source binding. Detection runs
  in the core wasm; fetching is tab-origin direct fetch with no metadata
  proxy.
- Cookie handoff to the desktop app is native-only, explicitly consented, and
  memory-only.

Contributing: narrow manifest permissions, explicit-action scans with cleanup,
no private signing keys in shipped JS. Tests: `cargo xtask test extension`.
Store publishing: `apps/extension/scripts/chrome-webstore-publish.sh`
(see `.env.example`); CI packages every push via `store-submit`, which
updates the existing Chromium and Firefox (AMO) listings in place.
