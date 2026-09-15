# Releases

The monorepo produces coordinated core libraries, protocol bindings, the website, extension, CLI, and desktop artifacts. A release records one version and the exact protocol range each artifact supports.

## Versioning

The release version identifies a tested source revision across all apps.
`cargo xtask release version` derives it from Git: `vX.Y.Z` is `X.Y.Z`, and
each following first-parent commit increments `Z`. App manifests do not author
release versions; builds receive the derived value as `DEZOOMIFY_VERSION`.
The protocol has an independent version because installed products do not
update at the same time.

Backward-compatible protocol additions keep the current major version. Removed fields, changed meanings, or incompatible command and event behavior require a new protocol major version. Error codes remain stable within a supported protocol major.

## Compatibility

Web, extension, and desktop perform the [version handshake](protocol.md#version-handshake) before sending job commands. Each artifact supports a documented rolling range of protocol versions. A peer outside that range stops safely and receives `protocol.incompatible` with the appropriate update action.

Handoff data carries app version, protocol version, schema fingerprint, and required capabilities. Receivers reject incompatible or expired data before confirmation or effects. Only the extension-to-native channel can separately request consent for scoped cookies.

## Release gates

A release candidate passes:

- full Rust and TypeScript formatting, lint, and unit suites;
- Rust-source-to-TypeScript-and-schema generation checks and clean-tree checks;
- shared scenarios on native, WASM, shared UI, extension, Tauri, and CLI targets;
- supported browser and operating-system smoke tests;
- protocol upgrade, downgrade, event-gap, and handoff fixtures;
- encoder output and large-image boundary tests;
- website direct-first request-order and classified automatic proxy-fallback tests;
- proxy public-resource eligibility, credential omission, redirect, and active-transport display audits;
- extension permission, native cookie-consent, Native Messaging sender-authentication and replay-defense, redaction, and dependency audits.

## Pipeline

`cargo xtask release plan|build|sign|verify|publish` is the only release
orchestration; every stage validates the previous stage's digests and fails
closed on missing inputs, tools, or secrets. The plan stage freezes a
deterministic contract (version, tag, commit, protocol range, schema
fingerprint, capabilities, targets) from Git, `release/config.toml`,
`release/targets.toml`, `release/compatibility.toml`, and
`generated/release-capabilities.json`. The build stage produces one target's
artifact on the matching host; unavailable targets refuse to build. The verify
stage checks artifact names against the plan. The publish stage verifies again
and refuses unless `origin/master` is the planned
revision. Rolling releases use `rolling-v<version>` and become GitHub's latest
release. Important numbered releases use `vX.Y.Z`. Working
release trees live under `target/release-dist/<version>/` and are never
committed; `target/` is used so website builds cannot clobber them.

The `release` workflow runs after successful `master` CI and can be dispatched
with a numbered tag for an important release. Every job uses the same planned
revision. Local `cargo xtask build desktop` produces
a real unsigned `.deb` (no paid signing) from the Tauri window shell behind
the optional `tauri` feature, so `desktop-linux-x86_64` is available;
`desktop-windows-x86_64` (needs a Windows host with WebView2, WiX, NSIS, and
`icon.ico`) and the macOS targets (need a macOS host with the Xcode Command
Line Tools and `icon.icns`) stay unavailable, and a release never claims an
artifact it did not build. The operator
sequence for cutting a release is the runbook in [Operations](operations.md).

Artifacts are signed with GPG-detached checksums and signatures. Store
submission remains separate because store review may lag rolling releases.
Desktop installers remain unsigned; the published inventory currently has the
Linux `.deb` only. See the [Desktop app guide](user/desktop-app.md#install).

## Desktop updater

Automatic in-app updates are disabled (todo 5.8 decision): no update host is deployed and no updater key exists. Users install the [latest release](https://github.com/lovasoa/dezoomify/releases/latest) manually. The shipped desktop capability sets `updater.enabled: false` with an empty allowlist, `tauri.conf.json` ships empty `plugins.updater.endpoints`, `release/config.toml` sets `[updater] enabled = false` with empty endpoints and no key file, and `UPDATER_PUBKEY` stays empty so the plugin never validates (fail closed).

The retained `apps/desktop/src-tauri/src/updater.rs` validator documents the policy a future self-hosted updater would enforce (strict ed25519 over the canonical `dezoomify-updater-v1` message, HTTPS allowlist, 7-day stale bound, +300s future skew, anti-rollback, explicit user confirmation, never auto-stage) and stays unit-tested via `validate_candidate`; the production `validate_update` entry rejects every candidate with `updater.disabled` and the installed app keeps working. The capability document grants only `updater:allow-check` so download and install stay denied. Activation requires a key ceremony that has not happened: a real public key in place of the empty `UPDATER_PUBKEY` (which also registers the plugin via the `tauri_shell.rs` gate), deployed endpoints, and `enabled = true`; until then no host or key is invented and every candidate fails closed.

See [Testing](testing.md) for test structure and [Security](security.md) for trust requirements.
