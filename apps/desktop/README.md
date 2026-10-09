# Desktop application

The Tauri shell runs NativeHost and embeds the shared UI. Image bytes stay
native; IPC carries generated progress, retry approvals, and output values. See
[Architecture](../../docs/architecture.md) for ownership and the
[desktop guide](desktop-app.md) for installation and use.

## Development and tests

```sh
cargo xtask dev desktop
cargo xtask test desktop
cargo xtask test desktop --e2e-window
```

The real-window lane uses an embedded test-only WebDriver on Linux, macOS, and
Windows. It needs a display (headless Linux: `xvfb-run -a`) and platform webview
packages. No external driver is needed. [Testing](../../docs/testing.md) explains
coverage; the [desktop workflow](../../.github/workflows/desktop.yml) owns CI lanes.

Subscribe before starting a native job and await registration before exposing
controls, so an immediate cancel reaches its task. Retired jobs cannot update
replacement views. Saved-file references outlive invocation resources and keep
paths out of IPC; file availability checks must not block rendering or completion.

Permission manifests are generated from Rust commands and events by
[`generate-desktop-capabilities.mjs`](../../scripts/generate-desktop-capabilities.mjs).
Do not add unused capabilities or enable the updater without a service and keys.

## Bundles

`cargo xtask build desktop` builds the shell, frontend, icons, and matching-host
installer. `--unsigned-test` builds without bundling.

| Host | Prerequisites |
|---|---|
| Linux | `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential`, and `dpkg-deb` (`dpkg-dev`) |
| Windows | WebView2, WiX v3 for MSI, NSIS, and generated `icons/icon.ico` |
| macOS | Xcode Command Line Tools and generated `icons/icon.icns` |

Icons derive from the root `favicon.svg` through the pinned Tauri CLI. Signing
and user approval steps live in the [installation guide](desktop-app.md#install).
Bundle smoke checks verify install/launch and macOS signatures; they do not
exercise Finder approval of a quarantined download. Check that on a clean Mac.

The macOS section of the desktop guide generates the DMG background. Preserve
its installation heading, ordered steps, and following note; regenerate with
`node scripts/generate-dmg-background.mjs` and inspect
`target/desktop-dmg/background.png` after edits. The generator rejects overflow.
