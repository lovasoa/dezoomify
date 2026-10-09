# Native Host

CLI and desktop supply NativeHost to the shared Rust algorithm. The Host owns
HTTP and local resources, cache, codecs, output publication, and cleanup;
Rust owns discovery, selection, retries, and partial choices.

## Memory and output

Raster encoding can run while tiles arrive. Keep composition on producer-owned
pixels: the encoder reads exclusively owned strips without per-pixel locking.
Unknown geometry and automatic format selection can require more buffering;
explicit output formats can reduce memory use.

Do not wait for memory while holding acquisition slots. A missing early tile can
block the encoder, so waiting would prevent the work needed to unblock it.
Return the typed resource-limit failure instead. Reservations track owned working
memory, not total process RSS.

Tiled outputs preserve compatible compressed source bytes. Convert locally only
when required by the chosen output; preserve failures in acquisition's retry and
partial handling. Encoder compatibility rules live in
[tile_output.rs](src/tile_output.rs) and [zif_output.rs](src/zif_output.rs).

## Publication and cleanup

All output routes share [staging and publication](src/output.rs). Reserve unique
staging paths; check cancellation and destination conflicts before committing.
An uncommitted cancellation publishes nothing and preserves existing files;
committed output survives retirement. Cleanup waits for owned decoders and
encoders before removing staging. Keep partial output at a distinct `.partial`
sibling so it cannot masquerade as a complete save.

Tests: `cargo xtask test native` and `cargo xtask test scenario`.
User-facing formats and limits: [command-line guide](../../docs/user/command-line.md).
Desktop build prerequisites: [desktop README](../../apps/desktop/README.md).
