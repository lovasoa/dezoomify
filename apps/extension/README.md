# Browser Extension

Detects zoomable images in your current tab and hands the job to Dezoomify,
using your browser's own session so logged-in and interactive viewers work.

- **Use:** click the extension button on a page with a zoomable image (grey
  idle becomes blue with a dot while the job is active); the dedicated job tab
  snapshots the source page and saves the result. The source page is not
  reloaded, and a second click focuses the existing job tab.
  Full steps: [browser extension](../../docs/user/browser-extension.md).
- Explicit-action jobs only: no background watching, auto-rearm, or unrelated
  tab monitoring. The job page owns each job and invalidates its source access
  on navigation. Detection runs in the core wasm; source reads use direct
  `executeScript()` calls with no metadata proxy.
- The extension uses only `activeTab` and `scripting` permissions plus
  optional host permissions requested for the active job.

Contributing: narrow manifest permissions, explicit-action scans with cleanup,
no private signing keys in shipped JS. `cargo xtask test extension` is the full
integration gate: current generated WASM, Chromium and Firefox WXT builds, all
units, and both headless browsers. The package-local `pnpm test` and
`pnpm test:unit` scripts are pure unit-only loops with no generated builds or
browsers.
Store publishing: `apps/extension/scripts/chrome-webstore-publish.sh`
(see `.env.example`); CI packages every push via `store-submit`, which
updates the existing Chromium and Firefox (AMO) listings in place.
