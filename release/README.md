# Release

This directory is the single reviewed release inventory. Signing keys are
referenced by CI secret name and never checked in; the public half of the
release signing key lives at `gpg-public-key.asc` and is the only key
material in the repository. Promotion steps (build → sign → verify →
publish) run through `cargo xtask release` and the `release-*` workflows
with digest verification at every transition; each stage fails closed.

- `config.toml`: the release version, channel, protocol range, and store
  identities. The plan stage freezes these into the release contract.
- `targets.toml`: the artifact target inventory. A target marked
  `available = false` refuses to build (desktop installers stay
  unavailable until the Tauri shell is real).
- `compatibility.toml`: the supported protocol version matrix.
- `checksums/<version>/SHA256SUMS`: the digest inventory of published
  releases, recorded by the publish stage and committed.
- `notes/<version>.md`: optional curated user-visible changes, included
  verbatim in the release notes when present.

Working release trees (`plan.json`, artifacts, signatures) live under
`dist/release/<version>/` and are never committed.
