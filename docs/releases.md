# Releases

The monorepo produces coordinated core libraries, generated bindings, the
website, extension, CLI, and desktop artifacts. A release records one version
and the Native Messaging range supported by independently installed extension
and desktop artifacts.

## Versioning

The release version identifies a tested source revision across all apps.
`cargo xtask release version` derives it from Git: `vX.Y.Z` is `X.Y.Z`, and
each following first-parent commit increments `Z`. App manifests do not author
release versions; builds receive the derived value as `DEZOOMIFY_VERSION`.
The extension-to-desktop Native Messaging channel has an independent version
because those two installed products do not update at the same time. Generated
WASM bindings are built and shipped with their browser product from the same
source revision and have no independent compatibility range.

## Compatibility

The extension and desktop perform the [Native Messaging version
check](protocol.md#native-messaging-version-check) before any consent or
credential message. A peer outside the supported range stops safely with an
update action. Handoff application input carries its application version;
receivers reject unsupported or expired data before confirmation or effects.
Only the extension-to-native channel can request consent for scoped cookies.

## Release gates

A release candidate passes:

- full Rust and TypeScript formatting, lint, and unit suites;
- Rust-source-to-TypeScript binding generation checks and clean-tree checks;
- shared scenarios on native, WASM, shared UI, extension, Tauri, and CLI targets;
- supported browser and operating-system smoke tests;
- Native Messaging version rejection, event-gap, and handoff fixtures;
- encoder output and large-image boundary tests;
- website direct-first request-order and classified automatic proxy-fallback tests;
- proxy public-resource eligibility, credential omission, redirect, and active-transport display audits;
- extension permission, native cookie-consent, Native Messaging sender-authentication and replay-defense, redaction, and dependency audits.

## Pipeline

`cargo xtask release plan|build|sign|verify|publish` is the only release
orchestration; every stage validates the previous stage's digests and fails
closed on missing inputs, tools, or secrets. The plan stage freezes a
deterministic contract (version, tag, commit, Native Messaging range,
capabilities, targets) from Git, `release/config.toml`,
`release/targets.toml`, the Native Messaging support range, and
`generated/release-capabilities.json`. The build stage produces one target's
artifact on the matching host; every planned target is mandatory. The verify
stage checks every artifact name against the plan. The publish stage verifies again
and refuses unless `origin/master` is the planned
revision. Release descriptions use the annotated tag message, or commit titles
since the preceding release tag when no annotation exists. Rolling releases use
`rolling-v<version>` and become GitHub's latest release. Important numbered releases use `vX.Y.Z`. Working
release trees live under `target/release-dist/<version>/` and are never
committed; `target/` is used so website builds cannot clobber them.

The `release` workflow runs after successful `master` CI and can be dispatched
with a numbered tag for an important release. Every job uses the same planned
revision. After GitHub Release assets publish, parallel Chromium and Firefox
store jobs submit the exact extension ZIPs from that GitHub Release: Chromium
uploads and publishes its package, and AMO receives a listed-channel upload.
GitHub Release artifacts are the single source of truth for store submission;
the store jobs do not rebuild or independently validate them beyond checking
the transferred ZIP with `unzip -t`. Store review remains external: submission
is automatic, but public availability waits for Chrome Web Store or AMO
approval. The release builds an unsigned Linux x86_64 `.deb`, Windows x86_64
`.msi`, and Apple silicon macOS `.dmg` on matching GitHub-hosted runners.
Windows requires WebView2, WiX, NSIS, and `icon.ico`; macOS requires the Xcode
Command Line Tools and `icon.icns`. A missing prerequisite fails the release.
The operator
sequence for cutting a release is the runbook in [Operations](operations.md).

GitHub Releases provides release provenance and the exact artifacts submitted
to the extension stores.
Desktop installers remain unsigned. See the [Desktop app guide](user/desktop-app.md#install).

## Desktop updater

Automatic in-app updates are disabled (todo 5.8 decision): no update host is deployed and no updater key exists. Users install the [latest release](https://github.com/lovasoa/dezoomify/releases/latest) manually. The shipped desktop capability sets `updater.enabled: false` with an empty allowlist, `tauri.conf.json` ships empty `plugins.updater.endpoints`, `release/config.toml` sets `[updater] enabled = false` with empty endpoints and no key file, and `UPDATER_PUBKEY` stays empty so the plugin never validates (fail closed).

The retained `apps/desktop/src-tauri/src/updater.rs` validator documents the policy a future self-hosted updater would enforce (strict ed25519 over the canonical `dezoomify-updater-v1` message, HTTPS allowlist, 7-day stale bound, +300s future skew, anti-rollback, explicit user confirmation, never auto-stage) and stays unit-tested via `validate_candidate`; the production `validate_update` entry rejects every candidate with `updater.disabled` and the installed app keeps working. The capability document grants only `updater:allow-check` so download and install stay denied. Activation requires a key ceremony that has not happened: a real public key in place of the empty `UPDATER_PUBKEY` (which also registers the plugin via the `tauri_shell.rs` gate), deployed endpoints, and `enabled = true`; until then no host or key is invented and every candidate fails closed.

See [Testing](testing.md) for test structure and [Security](security.md) for trust requirements.
