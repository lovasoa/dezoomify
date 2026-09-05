# Plan: True release pipeline (replaces the honest stubs)

Status: accepted (owner, 2026-09-05). Scope decisions (owner, 2026-09-05):
desktop-windows-x86_64 is excluded from buildable targets until the Tauri
shell is real; signing uses GPG via the `gpg` CLI in CI (private key in the
`release-signing` environment secret, fail closed when absent); the first
v3.0.0 release bumps the extension manifests to 3.0 alongside CLI, desktop,
and release config.

## Problem

`cargo xtask release plan|build|verify` (`crates/xtask/src/ci.rs`) and the
`release-build`/`release-sign`/`release-publish` workflows are honest stubs
that fail closed: no release plan file exists, no artifacts are built,
signed, verified, or published, and `release/checksums/` (the "single
reviewed release inventory") is empty. The release gates in
`docs/releases.md` are therefore unverifiable in practice.

## Design

One deterministic, digest-verified chain - plan → build → sign → verify →
publish - implemented as real `cargo xtask release` subcommands and wired
into the three workflows. Every transition validates the previous stage's
digests; every step fails closed on missing inputs or secrets.

- **plan** (`release plan [--version <v>]`): reads `release/config.toml`,
  `release/targets.toml`, `release/compatibility.toml`, and
  `generated/release-capabilities.json`; pins the current commit; writes a
  deterministic plan JSON plus release notes skeleton under
  `dist/release/<version>/` (never committed). Targets the pipeline cannot
  honestly build (desktop until Tauri lands) are recorded as
  unavailable and refuse to build.
- **build** (`release build --plan <p> --target <t>`): builds one target's
  artifacts on the matching host (CLI tarball via
  `cargo build --release -p dezoomify-cli`; extension zips via
  `apps/extension/scripts/package-store.sh`), writes per-target artifacts
  and a SHA256SUMS manifest. `release/targets.toml` gains the extension
  targets so the inventory stays authoritative.
- **sign** (`release sign --plan <p> --artifacts <dir>`): GPG detached
  signatures over SHA256SUMS and each artifact; the long-form public key
  is committed at `release/gpg-public-key.asc` so verify works anywhere;
  fails closed when no signing key is available.
- **verify** (`release verify --plan <p> --artifacts <dir>`): recompute all
  digests against SHA256SUMS, check artifact names, plan/config/protocol
  consistency, and GPG signatures; `--unsigned` is the explicit local
  pre-sign exception.
- **publish** (`release publish --plan <p> --artifacts <dir>`): runs verify
  (signed), then creates the GitHub release `v<version>` via `gh` with
  artifacts, checksums, signatures, and notes carrying protocol range,
  schema fingerprint, and capabilities; records the inventory at
  `release/checksums/<version>/SHA256SUMS` (committed).

## Phases

### RP1 (in progress): xtask release engine

New `crates/xtask/src/release.rs`; the stubs in `ci.rs` are deleted; HELP
and `main.rs` list `plan|build|sign|verify|publish`. Deterministic output;
no network except `release publish`.

### RP2: workflows

`release-build.yml` (test-all gate, plan, target matrix, artifact upload),
`release-sign.yml` (secret-key import, sign, upload), `release-publish.yml`
(verify, publish, commit the checksums inventory) replace the stubs;
actions stay SHA-pinned; jobs fail closed on missing secrets.

### RP3: docs and inventory

`docs/releases.md` states the implemented pipeline in present tense;
`release/README.md` documents the plan/artifact layout and the checksums
inventory convention; AGENTS.md links stay valid; xtask help updated.

### RP4: first release v3.0.0

Finish the version bump (extension manifests 2.0 → 3.0, remaining 0.1.0
strings, `ci.rs` remnants), run the deterministic gates (`cargo xtask
check`, `test all`, `ci local`), then produce and publish the v3.0.0
release with real CLI + extension artifacts so
`https://github.com/lovasoa/dezoomify/releases` resolves with assets.
Plan file removed when RP4 lands.
