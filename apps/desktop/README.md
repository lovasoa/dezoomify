# Desktop Application (lean shell)

Dezoomify native shell: validated deep links, command registry, job
lifecycle table, capability manifests, framed Native Messaging handoff
execution with origin-scoped cookies, and per-user initial registration
(Native Messaging manifests plus the `dezoomify://` protocol handler).

- Shell: lean `src-tauri/` (pure Rust, no Tauri SDK vendored); frontend contract from `packages/shared-ui`.
- Deep links are validated, bounded, and confirmed before any work starts.
- Native handoff runs over length-prefixed Native Messaging: handshake,
  one-use challenge/nonce sessions, explicit consent, single bounded cookie
  message, sibling isolation, redacted diagnostics. See `src/native_host/`.
- First-run registration is per-user only: `dezoomify-desktop
  --register-native-host` writes the manifests and protocol handler;
  `--check-native-host` inspects, `--unregister-native-host` cleans up.
- Installers ship unsigned (no paid Apple/Azure signing in this free project);
  automatic updates are disabled, so check GitHub Releases manually.

- Shell: lean `src-tauri/` (no Tauri SDK vendored); frontend contract from `packages/shared-ui`.
- Deep links are validated, bounded, and confirmed before any work starts.
- Installers ship unsigned (no paid Apple/Azure signing in this free project);
  automatic updates are disabled, so check GitHub Releases manually.

Contributing: talk to the engine only through the narrow validated IPC
bridge. Tests: `cargo xtask test desktop`.

## End-to-end

The real-window E2E is the app-level gate: `selenium-webdriver` drives the
shipped window shell against the embedded W3C WebDriver server
(`tauri-plugin-wdio-webdriver`, compiled behind the test-only
`testing-webdriver` cargo feature) over hermetic loopback fixtures. Because the
server is embedded in the app, the same suite runs on Linux, macOS, and Windows
with no external tauri-driver or platform driver. The plugin declares no IPC
commands, so it needs no capability entry.

```sh
cargo xtask test desktop --e2e-window
```

The lane builds the frontend, fixture server, and window shell (features
`tauri,testing-webdriver`), stages lane-private copies, then runs
`node --test specs/desktop.e2e.mjs`. The spec
covers the user-visible journeys: automatic submit/save to an isolated output
directory versus the `native/cli-dzi` golden, cancellation with no output, the
deep-link confirm gate (pending links perform no effect), and a kept partial
published to a `.partial` sibling. The harness configures the existing
output-directory setting to an isolated temporary folder through the rendered
settings panel, so generated filenames remain discoverable on every supported
host. Reports stay redacted and inputs fixed.

The lane needs a display on headless Linux (`xvfb-run -a`); macOS and Windows
CI runners provide a GUI session. It needs the webview system packages above;
a missing piece fails closed naming it. The earlier app-level suites that only
asserted internal Rust state or mocked the IPC boundary were removed: app
behavior is verified through the real window.

CI (`.github/workflows/desktop.yml`, path-gated to desktop-relevant changes)
runs `window-e2e` on ubuntu/macos/windows (`fail-fast: false`, the embedded
server needs no external driver; Linux runs under Xvfb with one hard
deadline). The `bundle-smoke` job keeps actual per-platform bundle, install,
and launch coverage:
Linux installs the `deb` (`sudo dpkg -i`) and launches it briefly under
Xvfb (a 20 s stay-alive proves install + launch + webview init; the window
shell has no `--version` flag), macOS mounts the `dmg` and execs the binary
directly (unsigned local build, Gatekeeper/SIP untouched), Windows installs
silently (`nsis` `/S`, or the direct-exe fallback when WiX/NSIS are absent).
Smoke logs upload as `desktop-bundle-smoke-<os>`. Platform smokes do not
install browser drivers or claim real-window E2E coverage. The desktop crate's
lean unit tests also run in the `rust` lane of `ci.yml`. No update flow is
exercised anywhere (updater inert).

## Bundles

`cargo xtask build desktop` compiles the lean shell, then the frontend
(`apps/desktop/dist/`), then the Tauri window shell, then generates icons
(`scripts/gen-desktop-icons.py`), then bundles for the matching host:
Linux `deb` (`cargo tauri build --bundles deb`, needs `dpkg-deb`),
Windows `msi`/`nsis` (needs WebView2, WiX, NSIS, `icons/icon.ico`),
macOS `dmg` (needs Xcode CLT, `icons/icon.icns`).
`cargo xtask build desktop --unsigned-test` compiles everything but
produces no bundle. Linux window builds need
`libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential`;
macOS ships WebKit and Windows ships WebView2.

Bundles are unsigned with no paid Apple/Azure signing in this free
project; automatic updates are disabled (no update host or key), so check
GitHub Releases manually. Only the Linux `.deb` is buildable; Windows and
macOS stay unavailable until a matching host builds them. The user-facing
install note lives in the [Desktop app
guide](../../docs/user/desktop-app.md#install).
