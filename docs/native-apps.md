# Native apps

CLI and desktop construct NativeHost and await the shared Rust `dezoomify(inputs, options, host)` function. The Host owns HTTP, local files, cache, inert HTML/CSS parsing, decoding, assembly, encoders, output publication, and resource cleanup. User behavior: [Desktop app guide](../apps/desktop/desktop-app.md) and [Command-line guide](user/command-line.md).

The HTML parser includes unmodified MPL-2.0 dependencies; source and license notices at the locked versions: [cssparser](https://docs.rs/crate/cssparser/0.37.0/source/), [cssparser-macros](https://docs.rs/crate/cssparser-macros/0.7.1/source/), [dtoa-short](https://docs.rs/crate/dtoa-short/0.3.5/source/), and [selectors](https://docs.rs/crate/selectors/0.38.0/source/).

## Native runtime

- One reusable reqwest transport per invocation, with connection reuse, scoped authentication, manual redirect handling, and local-resource support.
- Sixteen concurrent tile operations by default. One acquisition includes fetch, processing, decode, and placement. Per-host pacing has a 200 ms floor.
- Requests have a 30 s timeout and 6 s connection timeout. Each transport call makes one attempt; shared Rust code classifies failures and schedules retries.
- Blocking decoding reserves body bytes before scheduling and releases them when the decoder exits. Cleanup waits for owned tasks and decoder tails.
- Cache keys use versioned URL digests under an input-specific namespace. Cached bytes must still decode; corrupt entries trigger a fresh fetch. Headers, cookies, and credentials never enter cache keys.

Selection preserves `--largest`, exact `--zoom-level`, width/height caps, and `--image-index`. Deferred catalogs resolve within the invocation with follow and cycle bounds. Unknown formats and invalid settings fail before output.

`sink.rs` owns deterministic placement and memory accounting. Known geometry paints directly. Unknown geometry spools under the configured disk cap; overlapping tiles retain plan order under the retained-memory cap. The canvas uses four bytes per pixel and cannot exceed available system memory.

Tile placement borrows cropped pixels rather than copying them into a temporary image. Output encoders borrow the assembled canvas without cloning its pixel buffer. Single-file encoders write through a 64 KiB buffer directly to staging; JPEG borrows RGB channels without a full RGB copy. Codec workspace and pyramid pixels may require additional memory. IIIF directory rendering still buffers its encoded tile set.

Output publication checks cancellation and the destination before committing. Uncommitted temporary resources are invocation-owned and cleaned after failure. Published files remain intact. A publication that has committed returns success; otherwise cancellation publishes nothing and preserves any existing destination.

File and IIIF directory publication reserve unique staging paths exclusively. Failed writes or renames attempt to remove their own staging output before returning the original error. Single-file writes check cancellation during encoding and before publication. Without overwrite permission, file publication uses a same-filesystem hard link so a destination created after validation remains intact.

Instrumentation records attempts, acquired tiles, failures, retries, wait time, fetched bytes, peak in-flight work, retained/spooled bytes, decode bytes, canvas, and encoded output. `encoded_bytes` counts published bytes; `peak_encoded_bytes` counts the output buffer separately from codec workspace.

### Output naming and encoders

Native handles images beyond browser-tab size and local sources, within available memory, with single-job file and `iiif-dir` output. The output name picks the encoder:

- `.png` PNG; `.jpg`/`.jpeg` JPEG at quality `100 - compression`;
- `.tif`/`.tiff` single deflate TIFF; `.webp` lossless WebP;
- `.zif` multi-level pyramid (full resolution plus halvings, each deflate-compressed; the canvas is re-encoded per level, never passed through as tiles);
- `.iiif` an `iiif-dir` tree at that path; extensionless paths (or existing directories) also save `iiif-dir`.

Other extensions fail typed before any work. JPEG caps at 65535 px per side, WebP at 16383; larger canvases save as PNG, TIFF, ZIF, or `iiif-dir`. An `iiif-dir` holds IIIF Image API v2 `info.json` plus JPEG tiles at real request paths (`{x},{y},{w},{h}/{tw},/0/default.jpg`) with one `full/max/0/default.jpg` overview, servable from a static file server.

### Partial output

Post-retry failures can save a gappy result at a `.partial` sibling (`out.png` → `out.partial.png`). The intended complete destination stays untouched. Retry acquires only missing tiles with a fresh budget and preserves good tiles. Discard writes nothing and reports `job.partial-discarded`; CLI reporting uses its public `tile.download-failed` code.

The CLI applies its configured partial policy immediately. The desktop awaits a user keep/discard/retry choice and applies the configured default after 60 seconds. Missing-tile details and partial naming remain visible in the result.

## Desktop

Tauri owns the actual native tasks and saved-file handles. Its dezoomify call returns
the shared algorithm's Output alongside an optional saved-file reference. Progress
and awaited partial choices use generated values associated with the owning
invocation. Dedicated pause, resume, cancel, answer, and release calls control that task.

The frontend subscribes before starting and waits for native registration before exposing task controls, so a quick cancel or replacement reaches the registered task. Retired tasks cannot update a replacement view. Releasing unfinished work cancels it; the invocation completes after cleanup. A completed result keeps its output handle until retirement, without deleting the published file.

Every start carries an immutable copy of current settings. The shared native validation path checks input, dimensions, retries, cache, headers, and output. Titles determine output names; numeric suffixes avoid overwriting existing files.

### Desktop output and settings

Formats are PNG, JPEG, TIFF, ZIF, lossless WebP, and iiif-dir; PNG is the default. Settings persist under `dezoomify.desktop.settings.v1` and fall back to defaults on invalid saved data. Output directory, compression, width/height caps, retries, cache directory, and headers accompany each invocation. JPEG quality is `100 - compression` (default compression 5 gives quality 95).

Settings render while idle. History opens saved images by a durable native reference;
attempts without a saved file prefill input without starting work. These references
outlive invocation resources and keep paths out of IPC. Persistence, availability
checks, and opening run on workers: history must never delay rendering or job
completion. A missing file shows Deleted; access errors remain distinct.
Open/reveal from a completed result uses its registered published path, including
a partial sibling; pending or failed actions belong to that result.

### Desktop updater

No update host or key exists, so new versions install manually from GitHub
Releases. Do not enable updater flags without implementing the update service
and key provisioning.

### Desktop bundles

`cargo xtask build desktop` compiles lean shell, frontend, Tauri window shell, icons, then bundles. `--unsigned-test` stops before the bundler. Targets follow the host: Linux `deb` (prebuilt Tauri CLI), Windows `msi`/`nsis`, macOS `dmg`. Missing tools fail naming prerequisites.

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential` plus `dpkg-deb` (`dpkg-dev`); icons come from `favicon.svg` via the pinned Tauri CLI (`scripts/gen-desktop-icons.mjs`) before the bundler, following [Tauri's icon guidance](https://v2.tauri.app/develop/icons/). macOS needs Xcode Command Line Tools plus `icons/icon.icns`. Windows needs WiX v3 (`msi`), NSIS (`nsis`), plus `icons/icon.ico`. Linux x86_64 `.deb` and Windows x86_64 `.msi` installers are unsigned; the app inside the Apple silicon `.dmg` is ad-hoc signed without Developer ID or notarization. User note: [Desktop app guide](../apps/desktop/desktop-app.md#install).

Per-OS install smoke runs in the desktop CI `bundle-smoke` matrix: Linux installs
and launches under Xvfb, macOS verifies the signature with
`codesign --verify --deep --strict` and launches from the mounted image, and
Windows uses a silent MSI install. There is no `--version` flag; smoke checks
require the window to stay alive for 15–20 seconds. macOS smoke does not cover
Finder approval of a quarantined browser download; validate that on a clean Mac.

The DMG background uses installation steps from the desktop guide. Bundling
writes it under `target/desktop-dmg/`; packaged smoke checks verify the PNG and
Finder layout and capture the installation window for review.

### Real-window E2E hook

`cargo xtask test desktop --e2e-window` (display required; headless Linux uses Xvfb) builds fixtures, frontend, and the shell with the test-only `testing-webdriver` feature, then drives the real window over its embedded W3C WebDriver server (`tauri-plugin-wdio-webdriver`, no IPC commands, no capability entry). `specs/desktop.e2e.mjs` covers auto submit-to-save, cancellation, and kept partials as `.partial` siblings. No external driver needed; same lane on Linux, macOS, Windows. Output directory is a fail-closed temp dir set through the settings panel. Harness: `apps/desktop/tests/window-e2e/`.

## CLI

The CLI awaits NativeHost and prints progress and results as human output or stable machine records with `--json`. Missing arguments print help. A typed failure determines exit status. Public arguments, JSON keys, local-resource support, output formats, metadata preservation, and overwrite behavior remain part of the [command-line contract](user/command-line.md).

`--bulk` processes one bounded invocation per list entry, prints per-entry and total results, and exits 1 if any entry fails. `--retry-delay` sets the shared backoff base; `--retries 0` settles a failed tile after its first attempt.
