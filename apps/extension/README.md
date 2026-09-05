# Browser Extension

Detects zoomable images in your current tab and hands the job to Dezoomify —
using your browser's own session, so logged-in and interactive viewers work.

- **Use:** click the extension button on a page with a zoomable image; approve
  the per-site permission; pick the image; download it or hand it to the
  desktop app.
- One finite scan per explicit click — no background monitoring, no permanent
  broad permissions. The extension never uses the website's metadata proxy.
- Cookie handoff to the desktop app is native-only, explicitly consented, and
  memory-only.

Contributing: narrow manifest permissions, explicit-action scans with cleanup,
no private signing keys in shipped JS. Tests: `cargo xtask test extension`.
Store publishing: `apps/extension/scripts/chrome-webstore-publish.sh`
(see `.env.example`); CI packages every push via `store-submit`.
