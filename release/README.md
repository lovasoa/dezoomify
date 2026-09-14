# Release

This directory is the single reviewed release inventory. Signing keys are
referenced by CI secret name and never checked in; the public half of the
release signing key lives at `gpg-public-key.asc` and is the only key
material in the repository. Promotion steps (build → sign → verify →
publish) run through `cargo xtask release` and the `release` workflow
with digest verification at every transition; each stage fails closed.

- `config.toml`: the protocol range, store identities, and disabled updater
  configuration. App versions come only from numbered Git tags and history.
- `targets.toml`: the artifact target inventory. A target marked
  `available = false` refuses to build (only the Linux desktop `.deb` is
  available; Windows and macOS stay unavailable until a matching host builds
  them; installers ship unsigned and automatic updates are disabled).
- `compatibility.toml`: the supported protocol version matrix.
- `checksums/<version>/SHA256SUMS`: the committed digest inventory of numbered
  releases. Rolling inventories remain attached to their GitHub release.
- `notes/<version>.md`: optional curated user-visible changes, included
  verbatim in the release notes when present.

Working release trees (`plan.json`, artifacts, signatures) live under
`target/release-dist/<version>/` and are never committed.
