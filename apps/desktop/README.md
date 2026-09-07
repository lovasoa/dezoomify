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

The hermetic E2E always runs with no public network and no webview. It
serves fixtures on an ephemeral loopback port with the same binary and
flags as `cargo xtask fixtures serve --port 0`, drives the lean shell plus
the frontend harness through submit URL, image/level choice,
request_destination, and save, verifies the saved PNG against the
`native/cli-dzi` golden (dimensions, quadrant placement, sha256), and
covers the deep-link confirm flow (no effect while pending) plus the
cancel flow (terminal once, uncommitted output removed). Reports carry
redacted origins, hashes, and codes only.

```sh
cargo xtask test desktop    # lean shell tests plus the hermetic E2E
cargo xtask test scenario   # native pipeline scenario gates
```

The hermetic pieces are `apps/desktop/src-tauri/tests/desktop_e2e.rs`
(real job table over an in-process loopback server) and
`apps/desktop/tests/e2e.test.mjs` (subprocess fixture server, real
frontend integration, real pipeline save, redacted report). Both use
allocated ports, isolated profiles, fixed seeds, and no shared state.

The real-window E2E runs the window shell under tauri-driver on Linux
instead of by hand:

```sh
cargo xtask test desktop --e2e-window
```

The lane builds the window shell (`--unsigned-test`: lean shell, frontend,
window shell, no bundle), serves fixtures hermetically on an ephemeral
loopback port, serves the built frontend over loopback for the debug
window shell, launches the app under tauri-driver with a fresh profile and
ephemeral ports, and drives four flows with selenium-webdriver: submit with
destination grant to a byte-exact save versus the `native/cli-dzi` golden,
cancel with output cleanup, an existing-destination refusal with its stable
code, and the deep-link confirm gate (pending links perform no effect).
The native save dialog is not WebDriver-automatable, so the run sets the
fail-closed E2E fixed destination (`DEZOOMIFY_E2E_WINDOW=1` plus
`DEZOOMIFY_E2E_FIXED_DESTINATION`); production never sets either, so the
dialog always shows there. Reports stay redacted and seeds fixed as in the
hermetic gate.

The lane needs a display (`xvfb-run -a` when headless), tauri-driver 2.x
(`cargo install tauri-driver --version "=2.0.6"`, or `TAURI_DRIVER_BIN`),
WebKitWebDriver (`WEBKIT_DRIVER_BIN` override), and the webview system
packages above; each missing piece fails closed naming it. The lane and
harness run on Linux; macOS/Windows lane support (native-driver discovery
plus lane preflight) is a later wave.

CI (`.github/workflows/desktop.yml`, matrix ubuntu/macos/windows,
`fail-fast: false`) proves the app per platform: every leg builds and tests
the shells, Linux runs the lane for real under Xvfb (apt
`webkit2gtk-driver`, pinned tauri-driver, lane log uploaded as
`desktop-e2e-ubuntu-latest`), macOS enables `safaridriver` and Windows
installs `msedgedriver` pinned to the runner's Edge and each records the
lane's Linux-only guard as block evidence (pass on a real lane pass or that
exact guard, fail closed otherwise). Every leg then bundle-smokes:
Linux installs the `deb` (`sudo dpkg -i`) and launches it briefly under
Xvfb (a 20 s stay-alive proves install + launch + webview init; the window
shell has no `--version` flag), macOS mounts the `dmg` and execs the binary
directly (unsigned local build, Gatekeeper/SIP untouched), Windows installs
silently (`nsis` `/S`, or the direct-exe fallback when WiX/NSIS are absent).
Smoke logs upload as `desktop-bundle-smoke-<os>`; smokes never precede the
E2E legs. No update flow is exercised anywhere (updater inert).

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
