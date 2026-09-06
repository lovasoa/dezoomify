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
- Installers ship unsigned (no paid Apple/Azure signing in this free project); update
  payloads carry free self-generated signatures.

- Shell: lean `src-tauri/` (no Tauri SDK vendored); frontend contract from `packages/shared-ui`.
- Deep links are validated, bounded, and confirmed before any work starts.
- Installers ship unsigned (no paid Apple/Azure signing in this free project); update
  payloads carry free self-generated signatures.

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

The full Tauri window shell E2E stays a manual or CI-runner job because
it needs a display-capable webview plus a WebDriver stack next to the
app under test:

1. Install the platform webview packages (Linux:
   `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev
   libayatana-appindicator3-dev build-essential`; macOS ships WebKit,
   Windows ships WebView2) and the Tauri CLI
   (`cargo install tauri-cli --version "^2"`), plus `tauri-driver` and a
   WebDriver-compatible browser on an isolated profile.
2. Build the app: `cargo xtask build desktop --unsigned-test` (lean
   shell, frontend, and window shell, no bundle).
3. Serve fixtures hermetically in a second terminal:
   `cargo xtask fixtures serve --port 0 --write-address /tmp/dz-e2e/server.addr`
   and read the allocated `127.0.0.1:PORT` address from that file.
4. Launch the window shell under `tauri-driver` with a fresh profile and
   ephemeral ports only, pointing the submit URL at the allocated
   fixture address (`/fetch?url=https://fixtures.test/cli/pyramid.dzi`).
5. Drive submit, image choice (`img:0`), level choice, the native save
   dialog destination, and save; verify the saved PNG matches the
   `native/cli-dzi` golden exactly as the hermetic gate does.
6. Repeat with a `dezoomify://open?v=2&src=...` deep link (confirm
   dialog accepts or declines before any work) and with cancel before
   completion (terminal once, uncommitted output removed). Keep reports
   redacted and seeds fixed as in the hermetic gate.

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
project; update payloads carry free self-generated signatures. The
user-facing install note lives in the
[Desktop app guide](../../docs/user/desktop-app.md#install).
