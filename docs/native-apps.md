# Native apps

The CLI and Tauri desktop application share `crates/dezoomify-native`. This runtime drives `crates/dezoomify-job` and executes its effects with native HTTP, filesystem, decoder, processor, and output encoder implementations (PNG, JPEG, TIFF, and static IIIF tile trees).

## Native runtime

`crates/dezoomify-native` provides:

- HTTP requests with redirects, user headers, authentication, bounded concurrency (16 tile fetches), per-tile throttling, retry backoff (2s base delay with doubling, `--retries 0` means no retries), 30s request and 6s connect timeouts, 32 idle connections per host, and cancellation;
- format selection via `PipelineConfig::format` (`None`/`auto` auto-detects through `default_registry`; a named format selects the single program through `registry_for`, unknown names fail with typed `discovery.unknown-dezoomer`);
- remote metadata and tile fetch with local output file access, plus filesystem reads for plain local paths and `file://` URIs (single local `tiles.yaml` inputs and local tile URIs flow end-to-end; `file://` only names local absolute paths, credentials stay scoped and errors redacted);
- level selection with `--largest`, exact `--zoom-level` (out-of-range uses the last level), width and height caps, and exact `--image-index` (out-of-range uses the last image);
- in-memory tile decode and canvas assembly bounded by an 8 GiB canvas cap;
- PNG (deflate tier from `--compression`), JPEG (quality `100 - compression`, default 95), TIFF (deflate level from `--compression`, lossless at every level), and `iiif-dir` encode with atomic final publication, preserving the first tile ICC profile (JPEG, PNG, TIFF) and EXIF metadata (PNG);
- an optional tile resume cache: with a cache directory configured, each
  fetched tile body persists under `<cache-dir>/<job>/<key>` and a later run
  of the same job skips fetching tiles whose stored bytes still decode;

Temporary files are job-scoped. Successful output is moved into place atomically where the filesystem permits. Cancellation and failure remove uncommitted output. The resume cache holds tile response bodies only, keyed by versioned digests of their URLs under a per-job namespace derived from the input URL; request headers, cookies, and credentials never enter the cache, and a corrupt entry quietly falls back to a fresh fetch.

The canvas holds 4 bytes per pixel plus transient encode buffers, so a save needs that much free memory: a 20000 by 20000 image needs about 1.5 GiB, a 40000 by 40000 image about 6 GiB. Jobs that exceed the 8 GiB budget fail with typed `output.canvas-limit` before allocating, naming the required memory; saving a smaller level with `--max-width` fits the budget.

Native is the authoritative runtime for images larger than a browser tab and local sources, within an 8 GiB in-memory canvas cap, with single-job file and `iiif-dir` output. The output file name selects the encoder: `.png` saves PNG, `.jpg`/`.jpeg` saves JPEG at quality `100 - compression`, `.tif`/`.tiff`/`.zif` saves TIFF (single-image re-encode; there is no byte-preserving passthrough fast path and no source-pyramid multi-level encode), `.iiif` saves an `iiif-dir` tile tree at that path, and an extensionless path (or an existing directory) saves an `iiif-dir` tile tree. Any other extension fails with a typed error before any work starts. JPEG addresses at most 65535 px per side, so larger canvases save as PNG, TIFF, or `iiif-dir`. An `iiif-dir` destination holds an IIIF Image API v2 `info.json` plus JPEG tiles stored at their real IIIF request paths (`{x},{y},{w},{h}/{tw},/0/default.jpg`, size by width) with one `full/max/0/default.jpg` overview, so a plain static file server answers IIIF URLs; its output digest hashes `info.json` plus tile bytes in sorted path order. Failed tiles fail the job with `tile.download-failed` and no output by default; the `Keep` partial policy (blank regions, marked partial output) is available programmatically but has no CLI switch, while the reference keeps partial output by default. The native baseline reports encoders `[png, jpeg, tiff]`, destination modes `[file, iiif-dir]`, storage modes `[cache]`, `max_concurrency` 16, and `bulk_supported` false, with no pause command. Capability negotiation exposes actual codec and resource limits to callers; see [Protocol](protocol.md#capabilities).

## Desktop

The Tauri application hosts the same shared UI used by the website and extension. Its integration maps generated protocol commands to Tauri invocations and maps native events back to the shared UI. File pickers and save destinations are represented as native handles rather than browser paths.

Desktop treats website and deep-link [handoffs](protocol.md#handoff) as bounded, non-secret, untrusted input. It validates them and asks the user to confirm the source and output; these handoffs use no client-side signing. Extension handoff uses allowlisted Native Messaging: browser enforcement of allowed extension IDs authenticates the extension sender to the native host, while a fresh challenge and one-use nonce bind one session and prevent replay rather than establish identity. Cookies transfer only after separate origin-scoped consent and are not intentionally persisted.

## CLI

The CLI maps arguments to the same commands and prints the same typed events as human-readable progress or machine-readable records. It runs non-interactively: missing arguments print help, retries use a fixed budget of 3, and failures exit with the final typed error class. Flags are `--overwrite`, `--json`, `--max-width <px>`, `--accept-invalid-certs`, and `-H "Name: value"` with two positionals (`<input-url> <output>`). Each run saves one job to one output file or IIIF tile folder.

Exit status reflects the final typed error class. A kept partial output remains distinguishable from complete success. See [Errors](errors.md) and [Job engine](job-engine.md).
