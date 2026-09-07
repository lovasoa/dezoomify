# Browser Extension

Detects zoomable images in your current tab and hands the job to Dezoomify,
using your browser's own session so logged-in and interactive viewers work.

- **Use:** click the extension button on a page with a zoomable image (grey
  idle becomes blue with a dot while monitoring); the page reloads once;
  when an image is found a modal opens in the same tab; pick the image and
  save it or hand it to the desktop app. A second click cancels monitoring.
  Full steps: [browser extension](../../docs/user/browser-extension.md).
- Indefinite explicit-action monitoring only: no deadline, no background
  watching, no auto-rearm; monitoring stops on detection, second click, tab
  close, or navigation. Detection runs in the core wasm; fetching is
  tab-origin direct fetch with no metadata proxy.
- Cookie handoff to the desktop app is native-only, explicitly consented, and
  memory-only.

Contributing: narrow manifest permissions, explicit-action scans with cleanup,
no private signing keys in shipped JS. Tests: `cargo xtask test extension`.
Store publishing: `apps/extension/scripts/chrome-webstore-publish.sh`
(see `.env.example`); CI packages every push via `store-submit`, which
updates the existing Chromium and Firefox (AMO) listings in place.
