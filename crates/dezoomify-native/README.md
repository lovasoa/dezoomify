# Native Host

The CLI and desktop call `dezoomify::dezoomify` with `NativeHost`. It provides
HTTP and local resource reads, bounded blocking image decoding, tile caching,
canvas assembly, and atomic file publication. Each invocation owns its pooled
HTTP client, cancellation and pause controls, temporary files, and decode work.
The shared Rust algorithm owns discovery, selection, retry limits, and backoff.
Native acquisitions await user approval before optional retries.

The output encoders support PNG, JPEG, TIFF, ZIF pyramids, lossless WebP, and
static IIIF directories. Response bodies are cached under URL digests; headers
and cookies are never stored. Cancelling waits for blocking decode work to finish
before returning and leaves existing destination files untouched.

```sh
cargo xtask test native
cargo xtask test scenario
cargo xtask build cli
```

See [native apps](../../docs/native-apps.md) for the product contract.
