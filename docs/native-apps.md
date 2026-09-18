# Native apps

The CLI and Tauri desktop app share `crates/dezoomify-native`: native HTTP, filesystem, decoding, processing, and encoders driving `crates/dezoomify-job`. Effect meanings are in the [host-effect contract](job-engine.md#host-effect-contract); native execution only below. User behavior: [Desktop app guide](user/desktop-app.md), [Command-line guide](user/command-line.md).

## Native runtime

- HTTP with redirects, user headers, auth, 16 concurrent tile fetches (website 6, extension 6, native 16), per-host pacing 5/s (200 ms floor, `max(--min-interval, 200 ms)`), engine-driven retry timing (1 s base doubling to 30 s max, `Retry-After` honored to 300 s; `--retries 0` means none; `--retry-delay` is accepted but currently unused), 30 s request / 6 s connect timeouts, HTTP/1.1 keep-alive through one reqwest transport (32 idle per host, 15 s idle), single-attempt fetches with manual redirect handling, persistent throttles fail closed, cancellation;
- format selection (`PipelineConfig::format`: `None`/`auto` detects; a name picks one program; unknown names fail `discovery.unknown-dezoomer`);
- remote fetch plus local reads (plain paths, `file://` absolute paths only; single local `tiles.yaml` and local tile URIs flow end to end; credentials stay scoped, errors redacted);
- level selection (`--largest`, exact `--zoom-level`, width/height caps, `--image-index`; out-of-range picks the last);
- fixed-pool fetch plus decode (16 tile workers on scoped threads over one reqwest transport with a 2-worker Tokio I/O runtime), assembly bounded by available memory;
- PNG (deflate tier from `--compression`), JPEG (quality `100 - compression`, default 95), TIFF (deflate, always lossless), ZIF (multi-level pyramid, per-level deflate), lossless WebP, `iiif-dir`, atomic publication, first-tile ICC preserved (JPEG, PNG, TIFF, ZIF, WebP) and EXIF (PNG);
- tile resume cache on by default (`<cache-dir>/<job>/<key>`, custom `--tile-cache`); reruns skip tiles whose stored bytes still decode.

Temp files are job-scoped. Success moves output into place atomically where possible; cancellation and failure remove uncommitted output. Pause v1 (`--pause-after N` demo plus engine `Pause`/`Resume`) stops new `acquire-tile` scheduling, finishes in-flight work, keeps decoded output and queue order, and resumes the pending queue on resume. The cache keeps response bodies keyed by versioned URL digests under a per-job namespace from the input URL; never headers, cookies, or credentials. Corrupt entries fall back to fresh fetch.

The canvas costs 4 bytes per pixel. Before allocating, the runtime compares against `System::available_memory()` and fails `output.canvas-limit` when larger; no safety margin. `--max-width` fits a smaller level into memory. Tracked numbers: `cargo xtask test perf --smoke`, criterion `native_pipeline` benches.

### Output naming and encoders

Native handles images beyond browser-tab size and local sources, within available memory, with single-job file and `iiif-dir` output. The output name picks the encoder:

- `.png` PNG; `.jpg`/`.jpeg` JPEG at quality `100 - compression`;
- `.tif`/`.tiff` single deflate TIFF; `.webp` lossless WebP;
- `.zif` multi-level pyramid (full resolution plus halvings, each deflate-compressed; the canvas is re-encoded per level, never passed through as tiles);
- `.iiif` an `iiif-dir` tree at that path; extensionless paths (or existing directories) also save `iiif-dir`.

Other extensions fail typed before any work. JPEG caps at 65535 px per side, WebP at 16383; larger canvases save as PNG, TIFF, ZIF, or `iiif-dir`. An `iiif-dir` holds IIIF Image API v2 `info.json` plus JPEG tiles at real request paths (`{x},{y},{w},{h}/{tw},/0/default.jpg`) with one `full/max/0/default.jpg` overview, servable from a static file server; its digest hashes `info.json` plus tile bytes in sorted path order.

### Partial output

Post-retry tile failures keep a gappy output at a `.partial` sibling (`out.png` → `out.partial.png`), `partial: true` by default; `--no-partial` fails `tile.download-failed` with no output. The shell never presents partial bytes as complete: the driver announces the redacted missing ledger (`recovery-requested`/`missing-work`), waits up to 60 s for keep/discard/retry (fail-closed to policy), and ends `partial-completed` with missing ids plus sibling basename (never the granted path). Discarding fails `tile.download-failed` with no output.

### Capability baseline

The native baseline reports encoders `[png, jpeg, tiff, zif, webp]`, destination modes `[file, iiif-dir]`, storage modes `[cache]`, `max_concurrency` 16, `bulk_supported` true, `paused_supported` true. Negotiation exposes real codec and resource limits; see [Protocol](protocol.md#product-capabilities).

## Desktop

The Tauri app hosts the shared UI. Its integration maps protocol commands to Tauri invocations and native events back. A start carries every output setting from the main screen; the driver names output from the catalog title and saves straight into the configured folder, no second dialog.

Website and deep-link [handoffs](protocol.md#handoff) are bounded, secret-free, untrusted input: validated, then user-confirmed, never client-signed. Extension handoff uses allowlisted Native Messaging (browser-enforced extension IDs authenticate the sender); challenge plus one-use nonce bind one session against replay. Cookies transfer only after separate origin-scoped consent and persist nowhere.

### Desktop queue

Sequential multi-job queue in the integration layer (`apps/desktop/src/queue.ts`) over the single-job engine: submitted-while-running addresses wait in a table. Rows show redacted origin, status, progress; cancel one or cancel-all; failed/cancelled entries retry behind the line. Failures never stop the rest; totals mirror the CLI bulk contract (`bulk: X succeeded, Y failed, Z total`). The engine validates each entry itself, so checks are never UI-only.

### Desktop output and settings

One output per job, saved in submission order. The format picker offers `png`, `jpeg`, `tiff`, `zif`, `webp`, `iiif-dir` (default `png`), persisted in localStorage (`dezoomify.desktop.settings.v1`, fail-closed on load) and sent with `start_job` alongside the output directory. Basename comes from the catalog title plus format extension, with numeric suffixes instead of overwrites (overwrite is always false; no confirmation UI exists). JPEG quality is `100 - compression` (default 5 → 95). Panel settings (output directory, compression, width/height caps, retries, cache directory, `-H` headers) persist across relaunches and fall back to defaults on invalid drafts. User behavior: [Desktop app guide](user/desktop-app.md).

Settings render only while idle. History selection prefills the input without starting. Completion uses native open/reveal on the published path (completed or partially completed only) via the platform launcher on a blocking worker with fallbacks; file-existence, launcher, and IPC errors stay distinct, and every failed file action updates the visible error plus diagnostics. No caller-supplied path crosses IPC. Encoding progress never erases tile counts.

No catalog notice, no display-only branch on the native path. The driver folds the catalog internally (first image, largest fitting level; only pre-grant `answer_choice` overrides); the shell progress allowlist carries counts only. The frontend `catalogNotice` is local-only save-name geometry, never protocol; window E2E pins both absences.

### Desktop partial-output honesty

Default policy is `Keep`. Kept partials publish to the `.partial` sibling; the granted destination stays untouched, so partials never masquerade as complete; `--no-partial`/`Fail` writes nothing (`tile.download-failed`). The driver answers `request-decision{partial}` from policy itself, so the shell shows no partial dialog (`answer_choice` markers still map onto policy pre-grant). The pump retains partial flag, missing ledger, and published path. Kept partials end `PartiallyCompleted` with a distinct label; open/reveal resolve the sibling, never the untouched destination.

### Desktop updater

Inert. `tauri.conf.json` ships empty updater endpoints and pubkey; `release/config.toml` sets `[updater] enabled = false` with no key file; the plugin is unregistered and the frontend makes no update calls. New versions install manually from GitHub Releases. Enabling needs a new implemented update design plus deployed endpoints; none is invented. See [Releases](releases.md#desktop-updater).

### Desktop bundles

`cargo xtask build desktop` compiles lean shell, frontend, Tauri window shell, icons, then bundles. `--unsigned-test` stops before the bundler. Targets follow the host: Linux `deb` (prebuilt Tauri CLI), Windows `msi`/`nsis`, macOS `dmg`. Missing tools fail naming prerequisites.

Linux needs `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential` plus `dpkg-deb` (`dpkg-dev`); icons come from `scripts/gen-desktop-icons.py` before the bundler. macOS needs Xcode Command Line Tools plus `icons/icon.icns`. Windows needs WiX v3 (`msi`), NSIS (`nsis`), plus `icons/icon.ico`. Installers ship unsigned (Linux x86_64 `.deb`, Windows x86_64 `.msi`, Apple silicon `.dmg`); user note: [Desktop app guide](user/desktop-app.md#install).

Per-OS install smoke runs in the desktop CI `bundle-smoke` matrix (see [Testing](testing.md#desktop-real-window)): Linux `dpkg -i` plus timed stay-alive launch under Xvfb; macOS mounts the `dmg` and execs the binary from the image; Windows silent `msi` install (WiX and NSIS required). No `--version` flag exists, so every smoke proves install plus launch by holding the window 15–20 s. Gatekeeper/SIP untouched; the unsigned Windows binary carries no Mark-of-the-Web, so SmartScreen stays out and no OS policy is bypassed.

### Real-window E2E hook

`cargo xtask test desktop --e2e-window` (display required; headless Linux uses Xvfb) builds fixtures, frontend, and the shell with the test-only `testing-webdriver` feature, then drives the real window over its embedded W3C WebDriver server (`tauri-plugin-wdio-webdriver`, no IPC commands, no capability entry). `specs/desktop.e2e.mjs` covers auto submit-to-save, cancellation, confirmed deep-link save, and kept partials as `.partial` siblings. No external driver needed; same lane on Linux, macOS, Windows. Output directory is a fail-closed temp dir set through the settings panel. Harness: `apps/desktop/tests/window-e2e/`.

## CLI

Maps arguments to commands; prints typed events as human or machine records (`--json`). Non-interactive: missing arguments print help, fixed retry budget 3, failures exit with the typed error class. Flags: `--overwrite`, `--json`, `-d/--dezoomer`, `--largest`, `--max-width`, `--max-height`, `--zoom-level`, `--image-index`, `--retries`, `--keep-partial` (default) / `--no-partial`, `--tile-cache`, `--bulk`, `--pause-after <n>` (Pause v1 demo), `-H "Name: value"`, positionals `<input-url> <output>`. One job per run, one output (`.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.zif`, `.webp`, `.iiif`, extensionless `iiif-dir`).

`--bulk` runs one bounded single-job run per list entry with per-entry plus totals reporting; exit 1 when any entry fails. Options reference: [Command-line guide](user/command-line.md#useful-options). Errors: [Errors](errors.md). Engine: [Job engine](job-engine.md).
