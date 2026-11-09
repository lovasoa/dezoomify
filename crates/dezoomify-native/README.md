# Native Host

CLI and desktop supply NativeHost to the shared Rust algorithm. The Host owns
HTTP and local resources, image and resolution choices, cache, codecs, output
publication, and cleanup; Rust owns discovery, retry limits, and backoff.
Desktop acquisitions await user approval before optional retries.

## Memory and output

Raster composition uses a private disk-backed canvas beside the destination.
The OS caches file pages; only active tiles and the encoder's current strip
need application buffers. Completed strips freeze before encoding, so downloads
can arrive out of order without waiting for the encoder or retaining queued pixels
in RAM. Probes and automatic-format tiles also spool to disk until output starts.
Temporary storage must accommodate uncompressed pixels as well as the output.

Buffered codecs still need the complete RGBA image, but encode directly to staging.
Their preflight estimate includes conservative codec headroom, not a hard RSS limit.
The synchronous codec cannot be interrupted mid-encode; cancellation waits for
the worker and prevents publication.

AVIF uses the shared Rayon pool and SIMD assembly. Keep the native `image`
features `rayon` and `nasm` enabled; release optimization alone does not enable
either. Native build prerequisites are in [Development](../../docs/development.md).

To add a default `image` encoder, enable its native Cargo feature and add one
entry to `output_codecs!` in [`model.rs`](../dezoomify/src/model.rs), then run
`cargo xtask bindings generate`. Override construction in [`imaging.rs`](src/imaging.rs)
only when the encoder needs explicit quality settings or metadata handling.

Staging uses fallible file I/O so disk failures remain ordinary output errors.
The blocking-task scope owns cancellation and settlement; publication awaits
its commit decision even after cancellation.

Tiled outputs preserve compatible compressed source bytes. Convert locally only
when required by the chosen output; preserve failures in acquisition's retry
handling. Encoder compatibility rules live in
[tile_output.rs](src/tile_output.rs) and [zif_output.rs](src/zif_output.rs).

## Publication and cleanup

All output routes share [staging and publication](src/output.rs). Reserve unique
staging paths; check cancellation and destination conflicts before committing.
An uncommitted cancellation publishes nothing and preserves existing files;
committed output survives retirement. Cleanup waits for owned decoders and
encoders before removing staging. Every required tile must succeed before
finalization; incomplete downloads are not published.

Tests: `cargo xtask test native` and `cargo xtask test scenario`.
User-facing formats and limits: [command-line guide](../../docs/user/command-line.md).
Desktop build prerequisites: [desktop README](../../apps/desktop/README.md).
