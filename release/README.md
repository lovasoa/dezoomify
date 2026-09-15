# Release

This directory is the single reviewed release inventory. Promotion steps
(build → verify → publish) run through `cargo xtask release` and the
`release` workflow. GitHub Releases provides the release provenance.

- `config.toml`: the protocol range, store identities, and disabled updater
  configuration. App versions come only from numbered Git tags and history.
- `targets.toml`: the mandatory artifact target inventory. Every listed target
  builds on its matching host; a missing host, tool, or artifact fails the
  release. Desktop installers ship unsigned and automatic updates are disabled.
- `compatibility.toml`: the supported protocol version matrix.
- Release notes use an annotated tag message or commit titles since the
  preceding release tag.

Working release trees (`plan.json`, artifacts) live under
`target/release-dist/<version>/` and are never committed.
