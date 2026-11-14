# Native Host

CLI and desktop supply NativeHost to the shared Rust algorithm. The Host owns
HTTP and local resources, image and resolution choices, cache, codecs, output
publication, and cleanup; Rust owns discovery, retry limits, and backoff.
Desktop acquisitions await user approval before optional retries.

## Memory and output

Raster composition uses a private disk-backed canvas beside the destination.
The OS caches file pages; only active tiles and the encoder's current region
need application buffers. Completed regions freeze before encoding, so downloads
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

Input inspection, metadata, and decoding share the native codec factory in
[`codecs.rs`](src/codecs.rs). External decoders implement `image::ImageDecoder`.
Raster encoders negotiate regions and
workspace through `RasterEncoder` in [`raster.rs`](src/raster.rs).

JPEG 2000 uses the safe Rust `openjp2` API. JP2 output keeps the regular source
grid, crops redundant overlap and writes one tile at a time in raster order.
Irregular layouts and grids beyond the format's tile limit are rejected rather
than retiled. RGB output discards alpha; the origin tile's RGB ICC profile supplies
the header, so later profiles cannot change it. Input supports grayscale/RGB
with optional alpha and 8/16-bit conversion; subsampled and other color spaces
require conversion before use. No color-management transform is applied.

Staging uses fallible file I/O so disk failures remain ordinary output errors.
The blocking-task scope owns cancellation and settlement; publication awaits
its commit decision even after cancellation.

Tiled outputs preserve compatible compressed source bytes. Convert locally only
when required by the chosen output; preserve failures in acquisition's retry
handling. Encoder compatibility rules live in
[IIIF](src/iiif_output.rs), [ZIF](src/zif_output.rs), and
[PDF](src/pdf_images.rs); inspection, native byte spooling, geometry, and pyramids
are shared independently of the container.

PDF writes tile objects directly to staging and keeps its cross-reference index
on disk. Compatible JPEG and PNG payloads need no pixel decoding; other inputs
use bounded, lossless tile conversion with transparency. Its dependency only
serializes individual objects. Ordinary tests use a minimal parser without image
codecs; independent rendering uses installed Poppler through `cargo xtask test pdf`.

## Publication and cleanup

All output routes share [staging and publication](src/output.rs). Reserve unique
staging paths; check cancellation and destination conflicts before committing.
Single-image cancellation publishes nothing. In the shared batch runtime, a
multi-image document owner closes and publishes completed pages after all page
Hosts settle, including after an error or cancellation; the unfinished page is
rolled back. Page preparation is distinct from file publication. Committed
output survives retirement, and existing destinations remain protected. Every
required tile must succeed before its image can be finalized.

Tests: `cargo xtask test native` and `cargo xtask test scenario`.
User-facing formats and limits: [command-line guide](../../docs/user/command-line.md).
Desktop build prerequisites: [desktop README](../../apps/desktop/README.md).
