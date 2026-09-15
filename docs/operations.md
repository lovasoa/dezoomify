# Operations

On-call verifies asset digests before interpreting results; source URLs never enter monitoring. Rollback: `docs/rollback-runbook.md`.

## Release runbook

What each stage guarantees is the contract in [`releases.md`](releases.md).
Successful `master` CI automatically publishes the next rolling version.

### Preparing a release

1. Choose a version greater than `cargo xtask release version` and create the
   annotated `vX.Y.Z` tag on `master`. Write its annotation as the user-facing
   release description.
2. Push the tag and dispatch the `release` workflow with that tag as `ref`.
3. The workflow requires successful CI and edits no app manifest.

### Cutting a release

Run from the tagged revision:

1. `export DEZOOMIFY_VERSION="$(cargo xtask release version)"`
2. `cargo xtask release plan --numbered`
3. `cargo xtask release build --plan target/release-dist/<version>/plan.json --target <target>` for every available target (each build runs on its matching host and writes a per-target digest fragment; the CLI and Linux desktop targets need a Linux host; the plan lists them).
4. `RELEASE_GPG_KEY="$(cat <signing-key.asc>)" cargo xtask release sign` (assembles the aggregate `SHA256SUMS` from the fragments in plan order and GPG-detach-signs it and every artifact; fails closed without the key; the public key is `release/gpg-public-key.asc`).
5. `cargo xtask release verify --plan target/release-dist/<version>/plan.json --artifacts target/release-dist/<version>` (recomputes every digest, checks artifact names against the plan, and validates every signature).
6. `cargo xtask release publish --plan ... --artifacts ...`, then commit and push the recorded `release/checksums/<version>/SHA256SUMS`.

Signing uses free mechanisms only: GPG-detached `SHA256SUMS` plus per-artifact `.sig` files, and store submission to the existing Chromium listing. Desktop installers remain unsigned with no paid Apple/Azure signing; only the Linux `.deb` is buildable. Automatic in-app updates are disabled (no update host or key); users check GitHub Releases manually. Working trees under `target/release-dist/<version>/` are never committed; only the recorded `release/checksums/<version>/SHA256SUMS` inventory is committed. The user-facing install note lives in the [Desktop app guide](user/desktop-app.md#install).

The `release` workflow performs all five stages. Signing and publishing remain
separate protected jobs. Store submission remains a separate workflow because
store review can lag the rolling GitHub release.

## Update and installer truth

- No auto-update endpoint exists: `release/config.toml` sets `[updater] enabled = false` with empty endpoints, `tauri.conf.json` ships empty updater endpoints, and the desktop capability sets `updater.enabled: false` with an empty allowlist.
- Verify a download before use: `sha256sum -c SHA256SUMS` plus `gpg --verify SHA256SUMS.sig` against `release/gpg-public-key.asc`; a mismatch or missing signature stops the install.
- Windows and macOS ship no installer in this wave; the compatibility matrix and the desktop guide name Linux as the only desktop bundle.

## Service levels

Dezoomify runs as a volunteer best-effort project with no uptime, latency,
or support-response SLO: the website, the metadata CORS proxy, and the
release pipeline carry no availability target, and issue reports receive
volunteer triage per [Incident response](incident-response.md). What holds
instead is reproducibility: every release artifact is immutable,
checksummed, and signed (see [Releases](releases.md)), so an operator
verifies `SHA256SUMS` before use and reinstalls the previous immutable
release on failure (see `docs/rollback-runbook.md`).

## Rollback

Rollback is a manual reinstall of the previous immutable GitHub Release artifact (never a rebuild under an existing version); see `docs/rollback-runbook.md`. There is no update rollout to pause and no staged-percentage deploy: releases publish at once, Chromium store uploads are drafts until published, and AMO listed uploads enter review immediately. Expected operator timing: plan plus per-target builds in minutes on their matching hosts, sign plus verify in under a minute once the key is present, publish plus checksum-inventory commit in minutes; any missing secret, digest, or signature fails the stage immediately rather than shipping partial artifacts.
