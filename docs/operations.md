# Operations

On-call verifies asset digests before interpreting results; source URLs never enter monitoring. Rollback: `docs/rollback-runbook.md`.

## Release runbook

What each stage guarantees is the contract in [`releases.md`](releases.md); this is the operator sequence. The release version is one version across all apps; `release plan` fails closed when any app manifest disagrees, so a missed bump cannot ship.

### Preparing a release

1. Bump the version in `release/config.toml` and every app manifest it appears in (CLI, desktop, extension; `release plan` lists any file you missed).
2. Optionally add curated user-visible changes to `release/notes/<version>.md`; it is included verbatim in the release notes.
3. Pass the deterministic gates: `cargo xtask check && cargo xtask test all`.
4. Commit to `master`, push, create and push the annotated tag `v<version>`. Publish refuses when the tag does not point at the revision the plan pinned.

### Cutting a release

Run from the tagged revision:

1. `cargo xtask release plan`
2. `cargo xtask release build --plan target/release-dist/<version>/plan.json --target <target>` for every available target (each build runs on its matching host and writes a per-target digest fragment; the CLI and Linux desktop targets need a Linux host; the plan lists them).
3. `RELEASE_GPG_KEY="$(cat <signing-key.asc>)" cargo xtask release sign` (assembles the aggregate `SHA256SUMS` from the fragments in plan order and GPG-detach-signs it and every artifact; fails closed without the key; the public key is `release/gpg-public-key.asc`).
4. `cargo xtask release verify --plan target/release-dist/<version>/plan.json --artifacts target/release-dist/<version>` (recomputes every digest, checks artifact names against the plan, and validates every signature).
5. `cargo xtask release publish --plan ... --artifacts ...`, then commit and push the recorded `release/checksums/<version>/SHA256SUMS`.

Signing uses free mechanisms only: GPG-detached `SHA256SUMS` plus per-artifact `.sig` files, and store submission to the existing Chromium listing. Desktop installers remain unsigned with no paid Apple/Azure signing; only the Linux `.deb` is buildable. Automatic in-app updates are disabled (no update host or key); users check GitHub Releases manually. Working trees under `target/release-dist/<version>/` are never committed; only the recorded `release/checksums/<version>/SHA256SUMS` inventory is committed. The user-facing install note lives in the [Desktop app guide](user/desktop-app.md#install).

Steps 1 and 2 also run in CI: dispatch `release-build` with the tag, then `release-sign` and `release-publish` with the run ids; in CI the signing key comes from the `release-signing` environment secret, and every stage fails closed when the key, digests, or signatures are missing. The Chromium artifact from step 2 is the store payload for the existing listing (`iapjjopjejpelnfdonefbffahmcndfbm`), submitted through the `store-submit` workflow; never create a new store item and never publish to Firefox/AMO.

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

Rollback is a manual reinstall of the previous immutable GitHub Release artifact (never a rebuild under an existing version); see `docs/rollback-runbook.md`. There is no update rollout to pause and no staged-percentage deploy: releases publish at once, and the store draft path is Chromium-only. Expected operator timing: plan plus per-target builds in minutes on their matching hosts, sign plus verify in under a minute once the key is present, publish plus checksum-inventory commit in minutes; any missing secret, digest, or signature fails the stage immediately rather than shipping partial artifacts.
