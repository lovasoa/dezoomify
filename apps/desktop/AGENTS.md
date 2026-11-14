- Generate permission manifests from Rust commands/events with
  `node scripts/generate-desktop-capabilities.mjs`; declare only used permissions.
  The native updater needs no webview updater permissions.
- The macOS installation heading, ordered steps and following note in
  `desktop-app.md` generate the DMG background. After editing them, run
  `node scripts/generate-dmg-background.mjs` and inspect
  `target/desktop-dmg/background.png`.
- Bundle startup/signature checks cannot exercise Finder approval of a
  quarantined download. Verify that flow on a clean Mac before release.
