# Native apps

The CLI and Tauri desktop application share `crates/dezoomify-native`. This runtime drives `crates/dezoomify-job` and executes its effects with native HTTP, filesystem, decoder, processor, and output encoder implementations (PNG, JPEG, TIFF, ZIF pyramid, WebP, and static IIIF tile trees).

## Native runtime

`crates/dezoomify-native` provides:

- HTTP requests with redirects, user headers, authentication, bounded concurrency (16 tile fetches per the capability-negotiated policy: website 6, extension 6, native 16), per-host tile pacing at 5/s (200 ms spacing, `max(--min-interval, 200 ms)` so the floor applies even at the default 0), retry backoff (2s base delay with doubling, `--retries 0` means no retries), 30s request and 6s connect timeouts, HTTP/1.1 keep-alive with 32 idle connections per host for 15 s (100 total; ureq 3.4.1 is HTTP/1.1-only with no HTTP/2 path, so both the mainline and insecure paths negotiate `http/1.1` and reuse persistent connections), transport retries 1 with persistent throttles failing closed, and cancellation;
- format selection via `PipelineConfig::format` (`None`/`auto` auto-detects through `default_registry`; a named format selects the single program through `registry_for`, unknown names fail with typed `discovery.unknown-dezoomer`);
- remote metadata and tile fetch with local output file access, plus filesystem reads for plain local paths and `file://` URIs (single local `tiles.yaml` inputs and local tile URIs flow end-to-end; `file://` only names local absolute paths, credentials stay scoped and errors redacted);
- level selection with `--largest`, exact `--zoom-level` (out-of-range uses the last level), width and height caps, and exact `--image-index` (out-of-range uses the last image);
- fixed-pool tile fetch plus decode (16 std workers, no async runtime) with per-host start pacing, and tile decode plus canvas assembly bounded by an 8 GiB canvas cap with a 512 MiB spill threshold;
- PNG (deflate tier from `--compression`), JPEG (quality `100 - compression`, default 95), TIFF (deflate level from `--compression`, lossless at every level), ZIF (TIFF-compatible multi-directory pyramid, each level deflate-compressed per `--compression`), WebP (lossless), and `iiif-dir` encode with atomic final publication, preserving the first tile ICC profile (JPEG, PNG, TIFF, ZIF, WebP) and EXIF metadata (PNG);
- a tile resume cache on by default: each fetched tile body persists under `<cache-dir>/<job>/<key>` (custom `--tile-cache` or the default on-disk cache) and a later run of the same job skips fetching tiles whose stored bytes still decode;

Temporary files are job-scoped. Successful output is moved into place atomically where the filesystem permits. Cancellation and failure remove uncommitted output. Pause v1 (`--pause-after N` demo, plus engine `Pause`/`Resume` commands) suspends acquisition instead: new `acquire-tile` scheduling stops, in-flight work finishes, decoded output is retained, FIFO order and retry wakeups are preserved, and resume re-drives the pending queue (or completes when everything arrived paused). Hosts still own clocks; the engine never sleeps. The resume cache holds tile response bodies only, keyed by versioned digests of their URLs under a per-job namespace derived from the input URL; request headers, cookies, and credentials never enter the cache, and a corrupt entry quietly falls back to a fresh fetch.

The canvas holds 4 bytes per pixel plus one transient encode buffer, so the gate compares twice the canvas bytes against the budget: a 20000 by 20000 image needs about 1.5 GiB of pixels (about 3 GiB with its buffer) and streams through the spill path within the 8 GiB desktop budget, while a 40000 by 40000 image needs about 6 GiB (about 12 GiB with its buffer) and fails with typed `output.canvas-limit` before allocating; saving a smaller level with `--max-width` fits the budget. Canvases beyond 512 MiB spill decoded tiles to a temp dir one at a time and stream the encode directly to the destination file, so peak memory stays near one canvas plus one tile; small canvases keep the in-memory encode path byte for byte. See `cargo xtask test perf --smoke` and the criterion `native_pipeline` benches for the tracked numbers.

Native is the authoritative runtime for images larger than a browser tab and local sources, within an 8 GiB in-memory canvas cap, with single-job file and `iiif-dir` output. The output file name selects the encoder: `.png` saves PNG, `.jpg`/`.jpeg` saves JPEG at quality `100 - compression`, `.tif`/`.tiff` saves a single deflate-compressed TIFF image, `.webp` saves lossless WebP, `.zif` saves a TIFF-compatible multi-directory pyramid (full resolution plus halved levels, each deflate-compressed per `--compression`; encoded-tile passthrough cannot cross the job-engine boundary, so the assembled canvas is re-encoded at every pyramid resolution instead), `.iiif` saves an `iiif-dir` tile tree at that path, and an extensionless path (or an existing directory) saves an `iiif-dir` tile tree. Any other extension fails with a typed error before any work starts. JPEG addresses at most 65535 px per side, WebP at most 16383 px per side, so larger canvases save as PNG, TIFF, ZIF, or `iiif-dir`. An `iiif-dir` destination holds an IIIF Image API v2 `info.json` plus JPEG tiles stored at their real IIIF request paths (`{x},{y},{w},{h}/{tw},/0/default.jpg`, size by width) with one `full/max/0/default.jpg` overview, so a plain static file server answers IIIF URLs; its output digest hashes `info.json` plus tile bytes in sorted path order. Tile failures after retries keep a partial output with blank regions published to a `.partial` sibling (`out.png` becomes `out.partial.png`) and `partial: true` by default; `--no-partial` fails with `tile.download-failed` and no output instead. The desktop shell never claims a complete save for partial bytes: the driver announces the redacted missing ledger via `recovery-requested`/`missing-work` and waits up to 60s for an explicit keep/discard/retry choice (fail-closed to the configured policy), the shell surfaces `AwaitingPartialDecision` with the ledger, and the terminal is `partial-completed` carrying the missing ids plus the sibling basename (never the granted path); discarding fails with `tile.download-failed` and no output. The native baseline reports encoders `[png, jpeg, tiff, zif, webp]`, destination modes `[file, iiif-dir]`, storage modes `[cache]`, `max_concurrency` 16, `bulk_supported` true, and `paused_supported` true (Pause v1 suspend-acquisition with `--pause-after` demo). Capability negotiation exposes actual codec and resource limits to callers; see [Protocol](protocol.md#capabilities).

## Desktop

The Tauri application hosts the same shared UI used by the website and extension. Its integration maps generated protocol commands to Tauri invocations and maps native events back to the shared UI. File pickers and save destinations are represented as native handles rather than browser paths.

Desktop treats website and deep-link [handoffs](protocol.md#handoff) as bounded, non-secret, untrusted input. It validates them and asks the user to confirm the source and output; these handoffs use no client-side signing. Extension handoff uses allowlisted Native Messaging: browser enforcement of allowed extension IDs authenticates the extension sender to the native host, while a fresh challenge and one-use nonce bind one session and prevent replay rather than establish identity. Cookies transfer only after separate origin-scoped consent and are not intentionally persisted.

### Desktop queue

The desktop app runs a sequential multi-job queue in its integration layer
(`apps/desktop/src/queue.ts`) over the single-job engine: an address
submitted while a job runs waits in a table instead of replacing the running
job. Each row shows its redacted origin, status, and progress; one entry can
be cancelled without touching the rest, cancel-all stops new work, and failed
or cancelled entries retry behind the line. A failed entry never stops the
rest, and the totals mirror the CLI bulk contract
(`bulk: X succeeded, Y failed, Z total`). The engine still validates each
queued request on its own, so capability checks are never UI-only.

### Desktop output and settings

Each desktop job saves one output; the queue saves entries one at a time in
submission order. The UI format picker offers `png`, `jpeg`, and `tiff`
(`NATIVE_FORMATS` in `apps/desktop/src/desktopIntegration.ts`), defaulting to
`png`. The choice is first-class persisted state: `apps/desktop/src/settings.ts`
stores `outputFormat` in localStorage (`dezoomify.desktop.settings.v1`),
validates it fail-closed on load, and seeds both the picker radios and the
destination-grant format on relaunch. The shell grant gate accepts the full
`png`/`jpeg`/`tiff`/`zif`/`webp`/`iiif-dir` id set (`SUPPORTED_FORMATS` in
`apps/desktop/src-tauri/src/commands.rs`), but the UI only ever sends the
three picker ids; the format travels in the `request_destination` grant, never
in `start_job` (`settingsToInvokeArgs` carries compression, retries, caps,
directories, and headers only, and the Rust `DesktopSettings` has no format
field). JPEG quality is `100 - compression` with the shipped default
compression 5 pinning quality 95; the settings panel (output directory,
compression, width/height caps, retries, cache directory, `-H` headers) plus
the aux-panel format radios persist across relaunches and fail closed to
defaults on invalid drafts. Overwrite is always false: no overwrite
confirmation UI exists, so `request_destination` validates and grants with
`overwrite=false` and an existing destination is denied with the typed
`output.exists` reason for choose-output recovery instead of replaced.
User-visible behavior lives in the [Desktop app guide](user/desktop-app.md);
this section states the mechanism only.

The native desktop path emits no catalog notice and no display-only branch.
The driver folds the catalog internally (first image, largest fitting level;
only an explicit `answer_choice` overrides them before the grant), the shell
progress allowlist carries counts only (no `imageCount`), and only the browser
tainted-canvas path produces display-only. The frontend `catalogNotice` is
local-only aux geometry for the save-name suggestion, never a protocol notice;
the shared view's choice-count and display-only sections stay for other apps.
The window E2E pins both absences on the native save path.

### Desktop partial-output honesty

Partial policy defaults to `Keep` (`PipelineConfig::default`; desktop
`pipeline_config_for` does not override it). After retries, missing tiles stay
blank and the kept output publishes to a `.partial` sibling
(`out.png` becomes `out.partial.png` via `partial_path_for`); the granted
destination is never touched, so a partial file never masquerades as the
complete save, and `--no-partial`/`Fail` writes nothing with typed
`tile.download-failed`. The native driver answers the engine's
`request-decision{partial}` itself from the configured policy, so the shell
never surfaces `AwaitingPartialDecision` and no interactive partial dialog is
expected; `answer_choice` keep/discard markers still map onto the policy for
the pre-grant window. The shell honors the file-level distinction today but
not the terminal label: the real-driver pump maps every successful driver
finish to `Completed`/`completed` on `job-output` (`DriverSuccess` drops the
`PipelineOutcome.partial` flag), so a kept-partial save reports completion
while the bytes live at the sibling path. The `PartiallyCompleted` state and
the `partial-completed` output projection exist and the frontend already
handles them, but only test helpers reach them today. When the sibling fix
lands (thread `partial` through `DriverSuccess` and project kept-partial
finishes as `PartiallyCompleted` with a `partial-completed` event), update
this paragraph to state the labeled terminal and re-check the window E2E
sibling assertions.

### Desktop updater

The desktop updater is inert. `tauri.conf.json` ships empty
`plugins.updater.endpoints` and an empty `pubkey`; `release/config.toml` sets
`[updater] enabled = false` with empty endpoints and no key file;
`UPDATER_PUBKEY` stays empty so validation fails closed; the updater plugin is
not registered (the `tauri_shell.rs` registration gate skips it while the
pubkey is empty, so no endpoint is ever polled); the frontend issues no update
calls; and the capability document sets `updater.enabled: false` with an empty
allowlist while granting only `updater:allow-check`, which no shipped code
exercises. Users install new versions manually from GitHub Releases with the
GPG-detached `SHA256SUMS` verification in the
[Desktop app guide](user/desktop-app.md#install). Activation requires a key
ceremony that has not happened: a real public key, deployed endpoints,
`enabled = true`, and plugin registration. No host or key is invented until
then; see [Releases](releases.md#desktop-updater).

### Desktop bundles

`cargo xtask build desktop` compiles the lean shell first, then the frontend, then the Tauri window shell, then generates icons, then bundles. `--unsigned-test` stops before the bundler and produces no bundle. The bundle target follows the host: Linux produces `deb` via `cargo tauri build --bundles deb`; Windows produces `msi`/`nsis`; macOS produces `dmg`. A target is available only when its recipe and host tools are present; otherwise the build fails closed naming the exact prerequisites.

Linux needs the webview system packages `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential` for the window shell plus `dpkg-deb` (package `dpkg-dev`) for the `deb` bundler; icons come from `scripts/gen-desktop-icons.py`, which runs before the bundler. macOS ships WebKit and needs the Xcode Command Line Tools plus `icons/icon.icns` for the `dmg` target. Windows ships WebView2 and needs WiX v3 for the `msi` target and NSIS for the `nsis` target, plus `icons/icon.ico`. Installers ship unsigned.

Install smoke runs per OS in the desktop CI `bundle-smoke` matrix (see
[Testing](testing.md#desktop-real-window)): Linux installs the `deb` with
`dpkg -i` (repairing deps from apt when reported missing) and proves launch
with a timed stay-alive run under Xvfb; macOS mounts the `dmg` (answering the
embedded license prompt from stdin) and execs the app binary directly from
the image; Windows prefers the `nsis` `/S` silent install and falls back to a
direct release-exe launch smoke when WiX/NSIS are absent from the runner (the
bundler fails closed by design there, so installer coverage stays with
nsis-capable hosts). The window shell has no `--version` flag, so every smoke
proves install plus launch by keeping the app alive for its window
(15-20 s) and stopping it. Gatekeeper and SIP are never touched on macOS; the
locally built unsigned Windows binary carries no Mark-of-the-Web, so
SmartScreen does not intervene and no OS policy is bypassed anywhere. Only
the Linux `.deb` ships as a release artifact today; the user-facing install
note lives in the [Desktop app guide](user/desktop-app.md#install).

### Real-window E2E hook

Discovery completion moves a discovering job to `AwaitingDestination` with
one `job-state` event, which is the frontend cue to offer the save
destination. Image and level ride the pipeline defaults (first image,
largest fitting level); only an explicit `answer_choice` overrides them
before the grant.

The native save dialog is not WebDriver-automatable, so the window shell
honors a fail-closed fixed destination: `request_destination` grants
`DEZOOMIFY_E2E_FIXED_DESTINATION` without showing the dialog only when
`DEZOOMIFY_E2E_WINDOW` is also `1`. Either variable unset restores the
dialog, so production behavior never changes. Path validation and the typed
grant still run, so refused destinations keep their stable codes. The lane
is `cargo xtask test desktop --e2e-window` (Linux, display, tauri-driver,
and WebKitWebDriver required); it runs `window.spec.mjs` (native-feature
flows) then `formats.spec.mjs` (per-format byte-exact matrix) sequentially.
The harness lives in `apps/desktop/tests/window-e2e/`.

## CLI

The CLI maps arguments to the same commands and prints the same typed events as human-readable progress or machine-readable records. It runs non-interactively: missing arguments print help, retries use a fixed budget of 3, and failures exit with the final typed error class. Flags include `--overwrite`, `--json`, `-d/--dezoomer`, `--largest`, `--max-width`, `--max-height`, `--zoom-level`, `--image-index`, `--retries`, `--keep-partial` (default) / `--no-partial`, `--tile-cache`, `--bulk`, `--pause-after <n>` (Pause v1 demo: pause after n tiles, verify no new work, resume and complete), and `-H "Name: value"` with two positionals (`<input-url> <output>`). Each run saves one job to one output file (`.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.zif`, `.webp`, `.iiif`, or extensionless `iiif-dir`).

Exit status reflects the final typed error class. A kept partial output remains distinguishable from complete success. See [Errors](errors.md) and [Job engine](job-engine.md).

The CLI `--bulk` loop keeps its one-bounded-single-job-run-per-entry shape
and shares the queue reporting: per-entry outcomes plus a totals summary, and
exit 1 when any entry fails.
