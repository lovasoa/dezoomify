# Release

This directory is the single reviewed release inventory. Promotion steps
(build → verify → publish) run through `cargo xtask release` and the
`release` workflow. GitHub Releases provides the release provenance.

- `config.toml`: the store identities. App versions come only from numbered
  Git tags and history.
- `targets.toml`: the mandatory artifact target inventory. Every listed target
  builds on its matching host; a missing host, tool, or artifact fails the
  release. macOS apps use Developer ID signing and Apple notarization; Linux
  and Windows installers are unsigned. Updater artifacts have separate Tauri
  signatures. Signing setup: [Operations](../docs/operations.md#apple-signing-setup).
  Installation policy:
  [Desktop app guide](../apps/desktop/desktop-app.md#install).
- Release notes use an annotated tag message or commit titles since the
  preceding release tag.

Working release trees (`plan.json`, artifacts) live under
`target/release-dist/<version>/` and are never committed.
