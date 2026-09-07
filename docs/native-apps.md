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

Temporary files are job-scoped. Successful output is moved into place atomically where the filesystem permits. Cancellation and failure remove uncommitted output. The resume cache holds tile response bodies only, keyed by versioned digests of their URLs under a per-job namespace derived from the input URL; request headers, cookies, and credentials never enter the cache, and a corrupt entry quietly falls back to a fresh fetch.

The canvas holds 4 bytes per pixel plus one transient encode buffer, so the gate compares twice the canvas bytes against the budget: a 20000 by 20000 image needs about 1.5 GiB of pixels (about 3 GiB with its buffer) and streams through the spill path within the 8 GiB desktop budget, while a 40000 by 40000 image needs about 6 GiB (about 12 GiB with its buffer) and fails with typed `output.canvas-limit` before allocating; saving a smaller level with `--max-width` fits the budget. Canvases beyond 512 MiB spill decoded tiles to a temp dir one at a time and stream the encode directly to the destination file, so peak memory stays near one canvas plus one tile; small canvases keep the in-memory encode path byte for byte. See `cargo xtask test perf --smoke` and the criterion `native_pipeline` benches for the tracked numbers.

Native is the authoritative runtime for images larger than a browser tab and local sources, within an 8 GiB in-memory canvas cap, with single-job file and `iiif-dir` output. The output file name selects the encoder: `.png` saves PNG, `.jpg`/`.jpeg` saves JPEG at quality `100 - compression`, `.tif`/`.tiff` saves a single deflate-compressed TIFF image, `.webp` saves lossless WebP, `.zif` saves a TIFF-compatible multi-directory pyramid (full resolution plus halved levels, each deflate-compressed per `--compression`; encoded-tile passthrough cannot cross the job-engine boundary, so the assembled canvas is re-encoded at every pyramid resolution instead), `.iiif` saves an `iiif-dir` tile tree at that path, and an extensionless path (or an existing directory) saves an `iiif-dir` tile tree. Any other extension fails with a typed error before any work starts. JPEG addresses at most 65535 px per side, WebP at most 16383 px per side, so larger canvases save as PNG, TIFF, ZIF, or `iiif-dir`. An `iiif-dir` destination holds an IIIF Image API v2 `info.json` plus JPEG tiles stored at their real IIIF request paths (`{x},{y},{w},{h}/{tw},/0/default.jpg`, size by width) with one `full/max/0/default.jpg` overview, so a plain static file server answers IIIF URLs; its output digest hashes `info.json` plus tile bytes in sorted path order. Tile failures after retries keep a partial output with blank regions published to a `.partial` sibling (`out.png` becomes `out.partial.png`) and `partial: true` by default; `--no-partial` fails with `tile.download-failed` and no output instead. The native baseline reports encoders `[png, jpeg, tiff, zif, webp]`, destination modes `[file, iiif-dir]`, storage modes `[cache]`, `max_concurrency` 16, and `bulk_supported` false, with no pause command. Capability negotiation exposes actual codec and resource limits to callers; see [Protocol](protocol.md#capabilities).

## Desktop

The Tauri application hosts the same shared UI used by the website and extension. Its integration maps generated protocol commands to Tauri invocations and maps native events back to the shared UI. File pickers and save destinations are represented as native handles rather than browser paths.

Desktop treats website and deep-link [handoffs](protocol.md#handoff) as bounded, non-secret, untrusted input. It validates them and asks the user to confirm the source and output; these handoffs use no client-side signing. Extension handoff uses allowlisted Native Messaging: browser enforcement of allowed extension IDs authenticates the extension sender to the native host, while a fresh challenge and one-use nonce bind one session and prevent replay rather than establish identity. Cookies transfer only after separate origin-scoped consent and are not intentionally persisted.

### Desktop bundles

`cargo xtask build desktop` compiles the lean shell first, then the frontend, then the Tauri window shell, then generates icons, then bundles. `--unsigned-test` stops before the bundler and produces no bundle. The bundle target follows the host: Linux produces `deb` via `cargo tauri build --bundles deb`; Windows produces `msi`/`nsis`; macOS produces `dmg`. A target is available only when its recipe and host tools are present; otherwise the build fails closed naming the exact prerequisites.

Linux needs the webview system packages `libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev librsvg2-dev libayatana-appindicator3-dev build-essential` for the window shell plus `dpkg-deb` (package `dpkg-dev`) for the `deb` bundler; icons come from `scripts/gen-desktop-icons.py`, which runs before the bundler. macOS ships WebKit and needs the Xcode Command Line Tools plus `icons/icon.icns` for the `dmg` target. Windows ships WebView2 and needs WiX v3 for the `msi` target and NSIS for the `nsis` target, plus `icons/icon.ico`. Installers ship unsigned.

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
and WebKitWebDriver required); the harness lives in
`apps/desktop/tests/window-e2e/`.

## CLI

The CLI maps arguments to the same commands and prints the same typed events as human-readable progress or machine-readable records. It runs non-interactively: missing arguments print help, retries use a fixed budget of 3, and failures exit with the final typed error class. Flags include `--overwrite`, `--json`, `-d/--dezoomer`, `--largest`, `--max-width`, `--max-height`, `--zoom-level`, `--image-index`, `--retries`, `--keep-partial` (default) / `--no-partial`, `--tile-cache`, `--bulk`, and `-H "Name: value"` with two positionals (`<input-url> <output>`). Each run saves one job to one output file (`.png`, `.jpg`/`.jpeg`, `.tif`/`.tiff`, `.zif`, `.webp`, `.iiif`, or extensionless `iiif-dir`).

Exit status reflects the final typed error class. A kept partial output remains distinguishable from complete success. See [Errors](errors.md) and [Job engine](job-engine.md).
