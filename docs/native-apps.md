# Native apps

CLI and desktop construct NativeHost and await the shared Rust
`dezoomify(inputs, options, host)` function. The Host owns HTTP, local files,
cache, decoding, assembly, encoders, output publication, and resource cleanup.
User behavior: [Desktop app guide](user/desktop-app.md) and
[Command-line guide](user/command-line.md).

## Native runtime

- One reusable reqwest transport per invocation, with connection reuse, scoped
  authentication, manual redirect handling, and local-resource support.
- Sixteen concurrent tile operations by default. One acquisition includes
  fetch, processing, decode, and placement. Per-host pacing has a 200 ms floor.
- Requests have a 30 s timeout and 6 s connection timeout. Each transport call
  makes one attempt; shared Rust code classifies failures and schedules retries.
- Blocking decoding reserves body bytes before scheduling and releases them
  when the decoder exits. Cleanup waits for owned tasks and decoder tails.
- Cache keys use versioned URL digests under an input-specific namespace.
  Cached bytes must still decode; corrupt entries trigger a fresh fetch.
  Headers, cookies, and credentials never enter cache keys.

Selection preserves `--largest`, exact `--zoom-level`, width/height caps, and
`--image-index`. Deferred catalogs resolve within the invocation with follow
and cycle bounds. Unknown formats and invalid settings fail before output.

`sink.rs` owns deterministic placement and memory accounting. Known geometry
paints directly. Unknown geometry spools under the configured disk cap;
overlapping tiles retain plan order under the retained-memory cap. The canvas
uses four bytes per pixel and cannot exceed available system memory.

Output publication checks cancellation and the destination before committing.
Uncommitted temporary resources are invocation-owned and cleaned after failure.
Published files remain intact. A publication that has committed returns success;
otherwise cancellation publishes nothing and preserves any existing destination.

Instrumentation records attempts, acquired tiles, failures, retries, wait time,
fetched bytes, peak in-flight work, retained/spooled bytes, decode bytes, canvas,
and encoded output. Performance gates use the actual native pipeline.

### Output naming and encoders

Native handles images beyond browser-tab size and local sources, within available memory, with single-job file and `iiif-dir` output. The output name picks the encoder:

- `.png` PNG; `.jpg`/`.jpeg` JPEG at quality `100 - compression`;
- `.tif`/`.tiff` single deflate TIFF; `.webp` lossless WebP;
- `.zif` multi-level pyramid (full resolution plus halvings, each deflate-compressed; the canvas is re-encoded per level, never passed through as tiles);
- `.iiif` an `iiif-dir` tree at that path; extensionless paths (or existing directories) also save `iiif-dir`.

Other extensions fail typed before any work. JPEG caps at 65535 px per side, WebP at 16383; larger canvases save as PNG, TIFF, ZIF, or `iiif-dir`. An `iiif-dir` holds IIIF Image API v2 `info.json` plus JPEG tiles at real request paths (`{x},{y},{w},{h}/{tw},/0/default.jpg`) with one `full/max/0/default.jpg` overview, servable from a static file server.

### Partial output

Post-retry failures can save a gappy result at a `.partial` sibling
(`out.png` → `out.partial.png`). The intended complete destination stays
untouched. Retry acquires only missing tiles with a fresh budget and preserves
good tiles. Discard writes nothing and reports `job.partial-discarded`; CLI
reporting uses its public `tile.download-failed` code.

The CLI applies its configured partial policy immediately. The desktop awaits
a user keep/discard/retry choice and applies the configured default after
60 seconds. Missing-tile details and partial naming remain visible in the result.

## Desktop

Tauri owns the actual native tasks and saved-file handles. Its dezoomify call
returns the same Output value as the shared algorithm. Progress and awaited
partial choices use generated values associated with the owning invocation.
Dedicated pause, resume, cancel, answer, and release calls control that task.

The frontend subscribes before starting and waits for native registration before
exposing task controls. A quick cancel or replacement therefore reaches the
registered task. Retired tasks cannot update a replacement view. Releasing
unfinished work cancels it; the invocation completes after cleanup.
A completed result keeps its output handle until retirement, without deleting the
published file.

Every start carries an immutable copy of current settings. The shared native
validation path checks input, dimensions, retries, cache, headers, and output.
Titles determine output names; numeric suffixes avoid overwriting existing files.

### Desktop queue

The FIFO queue activates one address at a time, advances after failure, and
supports cancel-one, cancel-all, and retry at the back. Rows show the address,
progress, and result. Aggregate totals use the same succeeded/failed/total
meaning as CLI bulk output. Rust validates each entry independently.

### Desktop output and settings

Formats are PNG, JPEG, TIFF, ZIF, lossless WebP, and iiif-dir; PNG is the default.
Settings persist under `dezoomify.desktop.settings.v1` and fall back to defaults
on invalid saved data. Output directory, compression, width/height caps, retries,
cache directory, and headers accompany each invocation. JPEG quality is
`100 - compression` (default compression 5 gives quality 95).

Settings render while idle. History prefills input without starting work.
Open/reveal uses the registered published path, including a partial sibling;
caller-supplied paths never cross IPC. File existence, launcher, and IPC errors
remain distinct. Pending or failed actions belong to the owning completed result.
Encoding progress retains acquired tile counts.

### Desktop updater

Inert. `tauri.conf.json` ships empty updater endpoints and pubkey; `release/config.toml` sets `[updater] enabled = false` with no key file; the plugin is unregistered and the frontend makes no update calls. New versions install manually from GitHub Releases. Enabling needs a new implemented update design plus deployed endpoints; none is invented. See [Releases](releases.md#desktop-updater).

### Desktop bundles

`cargo xtask build desktop` compiles lean shell, frontend, Tauri window shell, icons, then bundles. `--unsigned-test` stops before the bundler. Targets follow the host: Linux `deb` (prebuilt Tauri CLI), Windows `msi`/`nsis`, macOS `dmg`. Missing tools fail naming prerequisites.

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential` plus `dpkg-deb` (`dpkg-dev`); icons come from `scripts/gen-desktop-icons.py` before the bundler. macOS needs Xcode Command Line Tools plus `icons/icon.icns`. Windows needs WiX v3 (`msi`), NSIS (`nsis`), plus `icons/icon.ico`. Installers ship unsigned (Linux x86_64 `.deb`, Windows x86_64 `.msi`, Apple silicon `.dmg`); user note: [Desktop app guide](user/desktop-app.md#install).

Per-OS install smoke runs in the desktop CI `bundle-smoke` matrix (see [Testing](testing.md#desktop-window)): Linux `dpkg -i` plus timed stay-alive launch under Xvfb; macOS mounts the `dmg` and execs the binary from the image; Windows silent `msi` install (WiX and NSIS required). No `--version` flag exists, so every smoke proves install plus launch by holding the window 15–20 s. Gatekeeper/SIP untouched; the unsigned Windows binary carries no Mark-of-the-Web, so SmartScreen stays out and no OS policy is bypassed.

### Real-window E2E hook

`cargo xtask test desktop --e2e-window` (display required; headless Linux uses Xvfb) builds fixtures, frontend, and the shell with the test-only `testing-webdriver` feature, then drives the real window over its embedded W3C WebDriver server (`tauri-plugin-wdio-webdriver`, no IPC commands, no capability entry). `specs/desktop.e2e.mjs` covers auto submit-to-save, cancellation, confirmed deep-link save, and kept partials as `.partial` siblings. No external driver needed; same lane on Linux, macOS, Windows. Output directory is a fail-closed temp dir set through the settings panel. Harness: `apps/desktop/tests/window-e2e/`.

## CLI

The CLI awaits NativeHost and prints progress and results as human output or
stable machine records with `--json`. Missing arguments print help. A typed
failure determines exit status. Public arguments, JSON keys, local-resource
support, output formats, metadata preservation, and overwrite behavior remain
part of the [command-line contract](user/command-line.md).

`--bulk` processes one bounded invocation per list entry, prints per-entry and
total results, and exits 1 if any entry fails. `--retry-delay` sets the shared
backoff base; `--retries 0` settles a failed tile after its first attempt.
