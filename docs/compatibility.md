# Compatibility

## Protocol versions

Current protocol is 1.0; N-1 is 1.0 (single-version rollout; see `release/compatibility.toml`).

Every connection starts with the [version handshake](protocol.md#version-handshake):
application version, protocol version range, schema fingerprint, runtime kind,
and capabilities. Peers select a mutually supported protocol version before
exchanging job data. Handoff data carries app version, protocol version, schema
fingerprint, required capabilities, and expiration; receivers treat every field
as untrusted input, validate it, and require user confirmation before effects.
No version overlap stops safely with `protocol.incompatible` and an update
recovery action. N-2 and future versions fail with guided update or manual
flows. Store and updater lag never activates unsupported features; website
offers follow published capabilities. Release automation verifies generated
bindings, schema fingerprints, compatibility fixtures, and this matrix (see
[Releases](releases.md)).

## Browsers and operating systems

| App | Supported platform | Verified by |
|---|---|---|
| Website | Current browsers with WebAssembly, workers, and canvas | Real-Chromium end-to-end runs (`cargo xtask test web --e2e`) plus supported browser and OS smoke tests in the release gates |
| Extension (Chromium) | Chrome 121 or later, plus Edge, Brave, and other Chromium-based browsers (`minimum_chrome_version` 121, required for `wasm-unsafe-eval`) | Headless Chromium end-to-end in `cargo xtask test extension` |
| Extension (Firefox) | Firefox 128.0 or later (`strict_min_version` 128.0, event-page background) | Headless Firefox end-to-end in `cargo xtask test extension` via Selenium and geckodriver |
| Desktop app | Windows, macOS, and Linux through the Tauri shell (WebView2 on Windows, WebKit on macOS, webkit2gtk on Linux) | `cargo xtask test desktop`; the Linux `.deb` builds on a Linux host while Windows and macOS bundles build only on their matching hosts |
| CLI | Native binary (Linux `cli-linux-x86_64` target; the same native runtime as the desktop app) | `cargo xtask test native` plus scenario parity |

Desktop installers ship unsigned (no paid Apple or Azure signing); only the
Linux `.deb` is buildable while Windows and macOS targets stay unavailable
(see [Releases](releases.md)). Automatic in-app updates are disabled: there
is no update host or key, so users check GitHub Releases manually. The
user-facing install note lives in the [Desktop app
guide](user/desktop-app.md#install).

## Canvas and save limits

| Surface | Budget | Past the budget |
|---|---|---|
| Browser tab (website, extension) | Browser memory and save limits; the browser promises no fixed size | The job stops with a typed error that names the desktop app as the next step |
| Desktop app | 8 GiB in-memory canvas: 4 bytes per pixel plus transient encode buffers, so a save needs that much free memory (about 1.5 GiB for 20000 by 20000, about 6 GiB for 40000 by 40000) | Typed `output.canvas-limit` before allocation; nothing is written; a smaller level fits the budget |
| CLI | 1 GiB in-memory canvas budget | Same `output.canvas-limit` behavior as the desktop app |

Encoder side caps apply on top of the canvas budget: JPEG addresses at most
65535 pixels per side and WebP at most 16383 pixels per side, so larger canvases
save as PNG, TIFF, ZIF, or an `iiif-dir` tile tree. The native baseline reports
encoders `[png, jpeg, tiff, zif, webp]`, destination modes `[file, iiif-dir]`,
storage modes `[cache]`, and `bulk_supported` true.

## Ordinary display without readable bytes

For unprocessed ordinary tiles, browser apps may render through plain `<img>`
elements and draw into a canvas even when the source taints it. The picture
stays visible (with browser right-click save where available), but the canvas
is not origin-clean: the runtime never runs pixel reads, hashing, processing,
`toBlob`, or `toDataURL` on it and never promises a clean programmatic save.
The website labels this limitation before rendering and points at a readable
route (the extension or the desktop app) when the job needs processing or a
clean save.

## Format support by app

Discovery is one shared core (`crates/dezoomify-core`): every app recognizes
the same formats in the same precedence order and selects automatically. Apps
differ in reach (authentication), saving (tainted display or clean bytes), and
bulk behavior, as detailed below the table. See [Supported
formats](user/supported-formats.md) for what to paste per format.

| Format | Website | Extension | Desktop app | CLI |
|---|---|---|---|---|
| Zoomify | Yes | Yes | Yes | Yes |
| Deep Zoom (Seadragon) | Yes | Yes | Yes | Yes |
| IIIF | Yes | Yes | Yes | Yes |
| Arts and Culture | Yes | Yes | Yes | Yes |
| IIPImage | Yes | Yes | Yes | Yes |
| TopViewer (Memorix) | Yes | Yes | Yes | Yes |
| krpano | Yes | Yes | Yes | Yes |
| FSI Viewer | Yes | Yes | Yes | Yes |
| LizardTech ImageServer | Yes | Yes | Yes | Yes |
| Visual Library Server (VLS) | Yes | Yes | Yes | Yes |
| XLimage | Yes | Yes | Yes | Yes |
| Hungaricana | Yes | Yes | Yes | Yes |
| ArcGIS MapServer | Yes | Yes | Yes | Yes |
| WMTS | Yes | Yes | Yes | Yes |
| pnav | Yes | Yes | Yes | Yes |
| Generic tile pattern | Yes | Yes | Yes | Yes |
| Custom tiles (`tiles.yaml`) | Yes, over http(s) tile URLs | Yes, over http(s) tile URLs | Yes, plus local files | Yes, plus local files |
| Bulk text (URL list) | Single-queue, one at a time | Deferred entries, one at a time | Multi-job queue, one at a time | `--bulk` loop, one bounded run per entry |

### Authentication

- The website never signs in anywhere: direct browser fetch and
  browser-to-proxy requests omit cookies, `Authorization`, and browser
  credentials. Only eligible public, non-credential metadata requests fall back
  to the metadata CORS proxy (never tiles); signed or token-bearing URLs are
  ineligible. Members-only collections need the extension.
- The extension works inside the user browser session, but only for origins
  covered by granted host permissions (activeTab on the scanned tab, or
  explicitly granted hosts). Cookies pass to native only after explicit consent
  that names the destination origins, scope, recipient, and job; they stay in
  memory only and consent never carries over to later jobs.
- The desktop app and CLI accept user-supplied headers such as `Referer` for
  sites that only serve their own viewer pages, and read local paths and
  `file://` URIs. The resume cache stores tile response bytes only, never
  headers, cookies, or credentials.

### Tainted canvas

Browser apps show tainted tiles but cannot produce clean saves from them (see
[Ordinary display without readable bytes](#ordinary-display-without-readable-bytes)
above). The extension assembles on an origin-clean canvas under its own fetch
grant, so its saves are clean. Native apps decode bytes directly and have no
canvas taint.

### Bulk

Queues run sequential single-job runs in the integration layer over the
single-job engine, never in the engine: `bulk_supported` is true on the
website (single-queue: an address submitted while a job runs waits its turn)
and native (multi-job queue with progress per job, cancel one or all, and
retry of failed jobs) baselines. Each job still saves one output, and a
failed entry never stops the rest. The CLI `--bulk` loop runs one bounded
single-job run per list entry (a failed entry never stops the rest; a
per-image summary plus totals print at the end and the exit is 1 when any
entry fails). Bulk text discovery yields deferred entries that resolve one
at a time.

## Reporting a problem

One template covers every app. Copy the diagnostics block from the error
details in the app (it already redacts secrets) and open an issue at
<https://github.com/lovasoa/dezoomify/issues> with:

- the page or manifest address, with tokens removed;
- the exact error message plus error code, phase, transport, resource kind,
  and blocked reason;
- the redacted source origin and the capability snapshot from the diagnostics
  copy;
- app and protocol versions, browser name and version;
- what was tried already (retry later, extension, desktop app);
- a screenshot where it helps.

Never include passwords, cookies, session contents, `Authorization` headers,
signed query values, full URLs with sensitive queries, local path details, or
response content. Before reporting, check the [troubleshooting
guide](user/troubleshooting.md): a site that limits request rates needs a later
retry or a personal connection through the extension or desktop app; a busy
site needs a few minutes; a picture that shows but cannot save needs the
extension; an approval step when sending a signed-in image to another app is
expected. Support is free and done by volunteers; a precise report gets
answered faster. Owners triage per [Incident response](incident-response.md).

## Live canary

The deterministic suites never contact public source sites. Public
compatibility checks run only through the explicit `cargo xtask test live`
target: `cargo xtask test live --dry-run --fixtures` validates the target list
with no network, while `cargo xtask test live --public [--limit <n>] [--site
<name>]` runs the real CLI against real sites with bounded sequential requests.

`.github/workflows/live-compat.yml` schedules a weekly canary
(`--public --limit 2`, every Monday plus manual dispatch). The canary is
advisory: it never blocks pull requests or releases. A failing target is fixed
or removed from `crates/xtask/src/live.rs` with the reason in the commit
message; failures are never tolerated silently and never replace deterministic
coverage (see [Testing](testing.md)).
