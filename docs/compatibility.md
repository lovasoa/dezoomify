# Compatibility

## Browsers and operating systems

| App | Supported platform | Verified by |
|---|---|---|
| Website | Current browsers with WebAssembly, workers, and canvas | Chromium end-to-end runs (`cargo xtask test web --e2e`) plus supported browser and OS smoke tests in the release gates |
| Extension (Chromium) | Chrome 140 or later, plus Edge, Brave, and other Chromium-based browsers (`minimum_chrome_version` 140, required for `wasm-unsafe-eval` and native base64 bytes) | Headless Chromium end-to-end in `cargo xtask test extension` |
| Extension (Firefox) | Firefox 133.0 or later (`strict_min_version` 133.0, event-page background) | Headless Firefox end-to-end in `cargo xtask test extension` via Selenium and geckodriver |
| Desktop app | Windows x86_64, Apple silicon macOS, and Linux x86_64 through the Tauri shell (WebView2 on Windows, WebKit on macOS, webkit2gtk on Linux) | Display-free `cargo xtask test desktop` plus explicit `test desktop --e2e-window`; each installer builds and launches on its matching host |
| CLI | Native binary (Linux `cli-linux-x86_64` target; the same native runtime as the desktop app) | `cargo xtask test native` plus scenario parity |

Linux and Windows desktop installers ship unsigned; macOS apps are ad-hoc signed without Developer ID or notarization. No in-app updates exist (see [Releases](releases.md#desktop-updater)). User install note: [Desktop app guide](user/desktop-app.md#install).

## Canvas and save limits

This table is canonical; user pages state the user-facing facts and link back.

| Surface | Budget | Past the budget |
|---|---|---|
| Browser tab (website, extension) | Automatic selection within 32,768 px per side and 268,435,456 pixels of area on desktop, 8,192 px per side and 67,108,864 pixels on mobile (about 1 GiB of picture on a computer, about 256 MiB on phones and tablets) | Job stops typed, naming the desktop app as next step |
| Desktop app | In-memory canvas, 4 bytes per pixel, within memory available to the process | Typed `output.canvas-limit` before allocation; nothing written; a smaller level fits |
| CLI | Same in-memory canvas rule as desktop | Same `output.canvas-limit` behavior |

Encoder side caps add to the memory check: JPEG 65535 px per side max, WebP 16383; larger canvases save as PNG, TIFF, ZIF, or `iiif-dir`. Encoder behavior: [Native apps](native-apps.md#output-naming-and-encoders).

## Format support

One shared domain crate (`crates/dezoomify`): every app recognizes the same formats in the same precedence order, automatically. Apps differ in reach (auth), saving (tainted display vs clean bytes), and bulk (below). Paste guide: [Supported formats](user/supported-formats.md); no matrix duplicated here.

### Authentication

- Website: never signs in. Direct and proxy requests omit cookies, `Authorization`, credentials. Only eligible public, non-credential metadata falls back to the proxy (never tiles); signed/token URLs are ineligible. Members-only collections need the extension. Order: [Browser runtime](browser-runtime.md#request-order).
- Extension: works inside the browser session, only for origins under granted host permissions (activeTab on the scanned tab, or explicit host grants). It does not transfer browser cookies or credentials to another product. See [Extension](extension.md), [Security](security.md).
- Desktop/CLI: accept user-supplied headers such as `Referer` for self-viewer-only sites; read local paths and `file://` URIs. Resume cache keeps tile bytes only, never headers, cookies, credentials. See [Native apps](native-apps.md).

### Tainted canvas

Browser apps show tainted tiles but save nothing clean from them ([Browser runtime](browser-runtime.md#ordinary-image-display)). The extension assembles on an origin-clean canvas under its fetch grant, so its saves are clean. Native apps decode bytes directly; no taint exists.

### Bulk

CLI `--bulk` runs one bounded run per entry (per-image plus totals summary; exit 1 when any entry fails). Bulk text discovery yields deferred entries resolving one at a time. User behavior: [Command-line guide](user/command-line.md#saving-many-images).

## Reporting a problem

Copy the diagnostics block from the app's error details (stays on your device) and open an issue at <https://github.com/lovasoa/dezoomify/issues> with:

- page or manifest address;
- exact message plus code, phase, transport, resource kind, blocked reason;
- diagnostics copy (failure details name the full request URL and quote the server reply);
- app version, browser name and version;
- what was tried already (retry later, extension, desktop app);
- a screenshot where it helps.

Never include passwords, cookies, session contents, `Authorization` headers, signed query values, or local paths. Check the [troubleshooting guide](user/troubleshooting.md) first. Support is volunteer-run; precise reports get answered faster. Triage: [Operations](operations.md#incident-response).

## Live canary

Deterministic suites never touch public source sites. Public checks run only via explicit `cargo xtask test live`: `cargo xtask test live --dry-run --fixtures` validates the target list with no network; `cargo xtask test live --public [--limit <n>] [--site <name>]` runs the real CLI against real sites with bounded sequential requests.

`.github/workflows/live-compat.yml` schedules a weekly canary (`--public --limit 2`, Mondays plus manual dispatch). Advisory only: it never blocks PRs or releases. A failing target is fixed or removed from `crates/xtask/src/live.rs` with the reason in the commit message; failures are never silently tolerated and never replace deterministic coverage (see [Testing](testing.md)).
