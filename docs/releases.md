# Releases

One version covers core libraries, generated bindings, website, extension, CLI, and desktop artifacts.

## Versioning

One version names a tested source revision across all apps. `cargo xtask release version` derives it from Git: `vX.Y.Z` is `X.Y.Z`; each following first-parent commit bumps `Z`. Manifests author no versions; builds receive the derived value as `DEZOOMIFY_VERSION`. WASM bindings ship with their browser product from the same revision and version nothing on their own.

## Compatibility

### Compatibility break

Native Messaging support and the `dezoomify-native-host` third-party entry point
are removed. The extension keeps browser credentials in the browser; the
remaining native entry points are the desktop app, the CLI, and bounded,
user-confirmed `dezoomify://` deep links. Deep links do not replace the removed
host's credential-transfer capabilities. Existing browser registration files
from older installations are inert after the host binary is removed; because
installers do not own browser-profile files, users who installed that host may
delete its `dev.ophir.dezoomify.native_host.json` files from their browser's
per-user native-host directory.

## Release gates

A release candidate passes:

- full Rust and TypeScript formatting, lint, and unit suites;
- Rust-source-to-TypeScript binding generation checks and clean-tree checks;
- shared scenarios on native, WASM, shared UI, extension, Tauri, and CLI targets;
- supported browser and operating-system smoke tests;
- encoder output and large-image boundary tests;
- website direct-first request-order and classified automatic proxy-fallback tests;
- proxy public-resource eligibility, credential omission, redirect, and active-transport display audits;
- extension permission and dependency audits.

## Pipeline

`cargo xtask release plan|build|sign|verify|publish` is the only release orchestration; each stage validates the previous stage's digests and fails closed on missing inputs, tools, or secrets. The plan freezes a deterministic contract (version, tag, commit, capabilities, targets) from Git, `release/targets.toml`, and `generated/release-capabilities.json`. Every planned target builds on its matching host; all are mandatory. Verify checks artifact names against the plan. Publish verifies again and refuses unless `origin/master` is the planned revision. Descriptions use the annotated tag message, or commit titles since the preceding tag. Rolling releases use `rolling-v<version>` and become GitHub's latest; important numbered releases use `vX.Y.Z`. Working trees under `target/release-dist/<version>/` are never committed (under `target/` so website builds never clobber them).

The `release` workflow runs after green `master` CI and accepts dispatch with a numbered tag for an important release. Every job pins the same revision. After GitHub Release assets publish, parallel Chromium and Firefox store jobs submit the exact ZIPs from that release (Chromium uploads and publishes; AMO takes a listed-channel upload). Release artifacts are the single source of truth; store jobs rebuild nothing and check the transferred ZIP with `unzip -t` only. Store review stays external: submission is automatic, availability waits for store approval. Linux x86_64 `.deb`, Windows x86_64 `.msi`, and Apple silicon `.dmg` build on matching GitHub-hosted runners (Windows: WebView2, WiX, NSIS, `icon.ico`; macOS: Xcode Command Line Tools, `icon.icns`). Missing prerequisites fail the release. Operator steps: [Operations](operations.md#release-runbook).

GitHub Releases holds provenance and the exact store-submitted artifacts. Linux and Windows installers stay unsigned. Tauri ad-hoc signs the macOS app with `bundle.macOS.signingIdentity = "-"`; no Apple account, Developer ID certificate, or notarization credentials are used. Before uploading the macOS artifact, the build job mounts the finished DMG and requires `codesign --verify --deep --strict` to pass for its app bundle. This checks signature integrity, not Gatekeeper acceptance; downloaded apps still need user approval. User note: [Desktop app guide](user/desktop-app.md#install).

## Desktop updater

Automatic in-app updates are disabled: no update host is deployed and no updater key exists, and every candidate fails closed. Users install the [latest release](https://github.com/lovasoa/dezoomify/releases/latest) manually. The shipped desktop capability sets `updater.enabled: false` with an empty allowlist, `tauri.conf.json` ships empty endpoints, `release/config.toml` sets `[updater] enabled = false` with empty endpoints and no key file, and empty `UPDATER_PUBKEY` keeps the plugin failing closed. Activation needs an undone key ceremony: a real pubkey, deployed endpoints, `enabled = true`.

See [Testing](testing.md) for test structure and [Security](security.md) for trust requirements.
