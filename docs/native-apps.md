# Native apps

The CLI, desktop backend, and Native Messaging host share one native runner (`crates/dezoomify-native/src/runner.rs`): native HTTP, filesystem, decoding, processing, and encoders driving `crates/dezoomify-engine`. Effect meanings are in the [host-effect contract](job-engine.md#host-effect-contract); native execution only below. User behavior: [Desktop app guide](user/desktop-app.md), [Command-line guide](user/command-line.md).

## One native runner

`NativeRunner::start` validates `JobOptions` and spawns one background driver thread per job. The runner builds one output specification and calls `exec::execute` once; it is the sole end-to-end native execution entry point. There is one engine-driven path only: no dummy engines or transient cancellation engines. Snapshots forward the engine `JobSnapshot` verbatim (revision, `JobState` lifecycle, paused overlay, progress, selection with catalog/deferred, decision with generation, terminal `SnapshotTerminalDto`, output) plus the native publication record once committed. No runner-local lifecycle, terminal, or recovery fold exists. Commands are the engine `UserCommand` vocabulary verbatim: `SelectImage`, `FollowDeferred`, `SelectLevel`, `AnswerPartial{generation, decision: RecoveryChoice}`, `Pause`, `Resume`, `Cancel`. Commands never supply bytes and never claim publication; publication is reported by the driver through `OutputCommitted{NativePublication}` only after finalization.

Deferred catalog entries resolve in place on the same job via `FollowDeferred` (engine-bounded follow/cycle guard, no host recursive replacement jobs). A rejected follow (cycle, budget exhausted) ends the job as `discovery.deferred`, preserving the host-loop code.

## Native runtime

- One reusable reqwest transport per job (connection reuse across metadata/probe/tiles; 32 idle per host, 15 s idle), 16 concurrent tile fetches (website 6, extension 6, native 16), per-host pacing 5/s (200 ms floor, `max(--min-interval, 200 ms)`), engine-driven retry timing (1 s base doubling to 30 s max, `Retry-After` honored to 300 s; `--retries 0` means first failure settles the tile), 30 s request / 6 s connect timeouts, HTTP/1.1 keep-alive, single-attempt fetches with manual redirect handling, persistent throttles fail closed, cancellation. One engine slot covers the full acquire/process/decode/place path: at most `max_concurrent` fetches plus chained decodes are ever in flight, with no second scheduler and no unbounded decoded-result queue beyond the engine budget;
- format selection (`PipelineConfig::format`: `None`/`auto` detects; a name picks one program; unknown names fail `discovery.unknown-format`);
- remote fetch plus local reads (plain paths, `file://` absolute paths only; single local `tiles.yaml` and local tile URIs flow end to end; credentials stay scoped, errors redacted);
- level selection (`--largest`, exact `--zoom-level`, width/height caps, `--image-index`; out-of-range picks the last; pre-start options seed the engine, live `SelectImage`/`SelectLevel`/`FollowDeferred` travel on the runner command channel);
- fixed-pool fetch plus decode over one reqwest transport with a 2-worker Tokio I/O runtime, assembly bounded by available memory;
- PNG (deflate tier from `--compression`), JPEG (quality `100 - compression`, default 95), TIFF (deflate, always lossless), ZIF (multi-level pyramid, per-level deflate), lossless WebP, `iiif-dir`, atomic publication, first-tile ICC preserved (JPEG, PNG, TIFF, ZIF, WebP) and EXIF (PNG);
- tile resume cache on by default (`<cache-dir>/<job>/<key>`, custom `--tile-cache`); reruns skip tiles whose stored bytes still decode.

Temp files are job-scoped. Success moves output into place atomically where possible; cancellation and failure remove uncommitted output. Pause (`Pause`/`Resume` over the runner channel) stops new `acquire-tile` scheduling, finishes in-flight work, keeps decoded output and queue order, and resumes the pending queue on resume. The cache keeps response bodies keyed by versioned URL digests under a per-job namespace from the input URL; never headers, cookies, or credentials. Corrupt entries fall back to fresh fetch.

One output owner (`sink.rs`): streaming paint with deterministic plan-order overlapping-tile placement. Tiles spool to job-owned files only while canvas geometry is unknown; the actual `output_spool_cap` bounds that disk use. Known-geometry work paints directly, while overlapping tiles remain in memory under `output_retain_cap`; tracked in-flight decode bytes remain bounded by engine slots. One commit point checks cancellation first, then destination validation, then performs exactly one atomic publication with job-owned-temp-only cleanup. Every blocking decode reserves its body bytes up front and releases them when its closure finishes; cancellation detaches an uninterruptible decode tail but keeps it accounted until it exits. Cancel reports only after quiescence (every tracked task aborted and joined, plus every tracked decode tail released; detached tails drop their results and publish nothing). The cancel/publication race is ordered: a committed publication is reported as completed, otherwise nothing is published and pre-existing destinations stay byte-identical. Results distinguish native publication (`NativePublication`) from browser dispositions (`BrowserSaveInitiated`, `BrowserSaveReady`, `DisplayOnly`); native never claims an initiated browser download reached disk.

The canvas costs 4 bytes per pixel. Before allocating, the runtime compares against `System::available_memory()` and fails `output.canvas-limit` when larger; no safety margin. `--max-width` fits a smaller level into memory. Honest accounting (`Instrumentation`): attempts, acquired, transient/permanent failures, scheduled retries, timer wait, fetched bytes, peak in-flight, peak retained/spool, peak in-flight decode bytes, canvas/encoded bytes, and the accounted peak (canvas plus peak retained plus encoded). Tracked numbers: `cargo xtask test perf --smoke`, criterion `native_pipeline` benches.

### Output naming and encoders

Native handles images beyond browser-tab size and local sources, within available memory, with single-job file and `iiif-dir` output. The output name picks the encoder:

- `.png` PNG; `.jpg`/`.jpeg` JPEG at quality `100 - compression`;
- `.tif`/`.tiff` single deflate TIFF; `.webp` lossless WebP;
- `.zif` multi-level pyramid (full resolution plus halvings, each deflate-compressed; the canvas is re-encoded per level, never passed through as tiles);
- `.iiif` an `iiif-dir` tree at that path; extensionless paths (or existing directories) also save `iiif-dir`.

Other extensions fail typed before any work. JPEG caps at 65535 px per side, WebP at 16383; larger canvases save as PNG, TIFF, ZIF, or `iiif-dir`. An `iiif-dir` holds IIIF Image API v2 `info.json` plus JPEG tiles at real request paths (`{x},{y},{w},{h}/{tw},/0/default.jpg`) with one `full/max/0/default.jpg` overview, servable from a static file server; its digest hashes `info.json` plus tile bytes in sorted path order.

### Partial output

Post-retry tile failures keep a gappy output at a `.partial` sibling (`out.png` → `out.partial.png`), `partial: true` by default; `--no-partial` fails `tile.download-failed` with no output. The shell never presents partial bytes as complete: the driver announces the redacted missing ledger with the engine generation, waits up to 60 s for keep/discard/retry (`RecoveryChoice` verbatim, fail-closed to policy), and ends `partial-completed` with missing ids plus sibling basename (never the granted path). A retry requeues exactly the settled-as-failed tiles in plan order with a fresh budget and preserves successes (good tiles are never refetched). Discarding fails `tile.download-failed` with no output. The CLI auto-answers partial decisions from its policy immediately (non-interactive, no 60 s wait); the desktop forwards the user choice with the pending generation (stale generations are rejected by the engine).

### Capability baseline

The native baseline reports encoders `[png, jpeg, tiff, zif, webp]`, destination modes `[file, iiif-dir]`, storage modes `[cache]`, `max_concurrency` 16, `bulk_supported` true, `paused_supported` true. Negotiation exposes real codec and resource limits; see [Protocol](protocol.md#product-capabilities).

## Desktop

The Tauri app hosts the shared UI. Its integration maps protocol commands to Tauri invocations and native events back. A start carries every output setting from the main screen; the driver names output from the catalog title and saves straight into the configured folder, no second dialog. The standalone Native Messaging host (`dezoomify-native-host`) runs the same `JobTable` on the same runner for compatible clients. The shipped browser extension does not connect to it.

Website and deep-link [handoffs](protocol.md#handoff) are untrusted input: validated, then user-confirmed, never client-signed. The Native Messaging host validates requests from compatible clients against its allowlisted senders and protocol version. The shipped extension does not transfer browser cookies or connect to Native Messaging.

### Desktop queue

Sequential multi-job queue in the integration layer (`apps/desktop/src/queue.ts`) over the single-job engine: submitted-while-running addresses wait in a table. Rows show redacted origin, status, progress; cancel one or cancel-all; failed/cancelled entries retry behind the line. Failures never stop the rest; totals mirror the CLI bulk contract (`bulk: X succeeded, Y failed, Z total`). The engine validates each entry itself, so checks are never UI-only.

### Desktop output and settings

One output per job, saved in submission order. The format picker offers `png`, `jpeg`, `tiff`, `zif`, `webp`, `iiif-dir` (default `png`), persisted in localStorage (`dezoomify.desktop.settings.v1`, fail-closed on load) and sent with `start_job` alongside the output directory. Basename comes from the catalog title plus format extension, with numeric suffixes instead of overwrites (overwrite is always false; no confirmation UI exists). JPEG quality is `100 - compression` (default 5 → 95). Panel settings (output directory, compression, width/height caps, retries, cache directory, `-H` headers) persist across relaunches and fall back to defaults on invalid drafts. User behavior: [Desktop app guide](user/desktop-app.md).

Settings render only while idle. History selection prefills the input without starting. Completion uses native open/reveal on the published path (completed or partially completed only) via the platform launcher on a blocking worker with fallbacks; file-existence, launcher, and IPC errors stay distinct, and every failed file action updates the visible error plus diagnostics. No caller-supplied path crosses IPC. Encoding progress never erases tile counts.

No catalog notice, no display-only branch on the native path. The driver folds the catalog internally (first image, largest fitting level; pre-grant `answer_choice` seeds options plus a live engine command when already awaiting selection); the shell progress allowlist carries counts only. Engine terminals map once to native product codes for IPC (`job.no-images` → `discovery.no-image`, etc.; already-native codes pass through), so the frontend renders one vocabulary. The frontend `catalogNotice` is local-only save-name geometry, never protocol; window E2E pins both absences. Pause/resume travel live (`answer_choice` pause/resume plus the runner channel); open/reveal resolve the published sibling, never a caller-supplied path.

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

Maps arguments to commands on the shared runner; prints typed events as human or machine records (`--json`). Engine lifecycles map to stable kinds (`discovery`, `downloading`, `recovery-requested`, `encoding`); the first snapshot always prints as `started` and the terminal revision is reused for the machine completion record. Non-interactive: missing arguments print help, fixed retry budget 3, failures exit with the typed error class. Flags: `--overwrite`, `--json`, `-d/--format`, `--largest`, `--max-width`, `--max-height`, `--zoom-level`, `--image-index`, `--retries`, `--retry-delay`, `--keep-partial` (default) / `--no-partial`, `--tile-cache`, `--bulk`, `-H "Name: value"`, positionals `<input-url> <output>`. One job per run, one output (`.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.zif`, `.webp`, `.iiif`, extensionless `iiif-dir`). `--retry-delay` sets the engine backoff base (doubling per attempt).

`--bulk` runs one bounded single-job run per list entry with per-entry plus totals reporting; exit 1 when any entry fails. Options reference: [Command-line guide](user/command-line.md#useful-options). Errors: [Errors](errors.md). Engine: [Job engine](job-engine.md).
