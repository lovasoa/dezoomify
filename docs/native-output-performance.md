# Native output performance

The parallel pipeline reduces memory and overlaps encoding with downloads. It
does **not** make every output faster. Immediate tile responses expose raster
CPU overhead, especially JPEG's synchronized pixel reads.

Measured on Linux, AMD Ryzen AI 7 350 (8 cores, 16 threads), with output on an
NVMe-backed Btrfs filesystem and a Node 22.22.2 fixture server. Release CLI binaries compare master `9fafe8f6`
with the pixel-stripe implementation in PR #1190 after cleanup. The CLI and
desktop share this native backend; desktop window startup and IPC are excluded.

The input is an 8192×8192 image: 1024 JPEG tiles of 256×256 pixels, repeating
the four captured generic-map fixtures. Each run uses an empty tile cache,
16 acquisition workers, compression 5, no pacing, and no retries. Timings run
from process launch through acquisition, output publication, cleanup, and exit;
builds and fixture setup are excluded. Each pair alternates run order. Tables
show medians of three runs, or five for JPEG; all runs completed successfully.

## End-to-end wall time

The delayed server waits 50 ms per tile response. This deterministic delay
models download latency without WAN variability; it is not a throughput limit.

| Output | Immediate: master → current | Change | 50 ms/tile: master → current | Change |
|---|---:|---:|---:|---:|
| PNG | 0.791 → 1.244 s | 57% slower | 3.929 → 3.400 s | 13% faster |
| JPEG | 1.441 → 3.808 s | 164% slower | 4.505 → 3.431 s | 24% faster |
| TIFF | 0.676 → 0.990 s | 46% slower | 3.774 → 3.373 s | 11% faster |
| IIIF | 4.100 → 3.226 s | 21% faster | 7.289 → 6.120 s | 16% faster |
| ZIF | 2.023 → 2.128 s | 5% slower | 5.212 → 5.432 s | 4% slower |

Immediate JPEG runs ranged from 1.365–1.483 s on master and 3.758–3.903 s
currently. Their median process CPU times were 2.12 and 4.39 s respectively.
Delayed JPEG ranges were 4.470–5.438 and 3.406–4.089 s. The slowest immediate
TIFF run was 1.488 s, so its three-run result merits a larger sample before
drawing conclusions about small changes.

WebP uses the contiguous-buffer fallback. On a smaller 2048×2048 input,
three immediate runs measured 0.076 → 0.061 s, with identical output lengths.
This short workload says little about larger WebP jobs; the default RAM limit
rejects the 8192×8192 codec workspace before downloading tiles.

## Peak process RSS

These are GNU `time` process measurements, not the internal reservation counter.
Immediate responses can queue many decoded tiles; delayed acquisition lets the
encoder release them before the next arrivals.

| Output | Immediate: master → current | 50 ms/tile: master → current |
|---|---:|---:|
| PNG | 518 → 250 MiB | 515 → 28 MiB |
| JPEG | 496 → 295 MiB | 494 → 37 MiB |
| TIFF | 296 → 205 MiB | 294 → 29 MiB |
| IIIF | 883 → 16 MiB | 881 → 16 MiB |
| ZIF | 871 → 16 MiB | 870 → 16 MiB |

## What the comparison establishes

PNG, JPEG, and TIFF decoded pixels were checked against master across the
entire output. JPEG files were also byte-for-byte identical. PNG sizes differ
by less than 0.02%; TIFF's row strips increase size by 3.4% in this fixture.

IIIF preserves the source's 256-pixel grid instead of reencoding 512-pixel
tiles. It writes 29.4 MB instead of 62.0 MB. ZIF now writes conforming tiled
BigTIFF with JPEG payloads, rather than the old TIFF-frame pyramid; its output
is 27.2 MB instead of 20.6 MB. Those are end-to-end product comparisons, not
comparisons of identical containers or codec settings. Lower pyramid levels
still require local decoding and encoding.

Current publication syncs staging output; master did not provide that same
durability guarantee. Filesystem caches are warm, but application caches are
fresh. This is one machine and one textured fixture, not a general benchmark.

Cleanup removes duplicate full-canvas encoders, unused spool configuration and
metrics, and tests of retired paths. Active encoder tests cover all four raster
codecs, metadata, cancellation, shuffled arrivals, and JPEG padding. Pixel reads
now avoid duplicate locking/tree lookup and per-read allocation or atomics;
opaque producers publish a tile's stripes under one lock. The remaining JPEG
adapter still locks and indexes for every requested pixel. That is a plausible
source of its CPU overhead, not a profiler-confirmed attribution. Further speed
work needs to preserve the single-buffer design and measured memory benefits.

## Reproduce

Build the old and current CLI in separate checkouts and Cargo target directories
using `cargo build --release --locked -p dezoomify-cli`, then:

```sh
node scripts/bench-native-output.mjs /path/to/old-cli /path/to/current-cli
DELAY=50 node scripts/bench-native-output.mjs /path/to/old-cli /path/to/current-cli
FORMATS=jpg REPEATS=5 node scripts/bench-native-output.mjs /path/to/old-cli /path/to/current-cli
SIDE=2048 FORMATS=webp node scripts/bench-native-output.mjs /path/to/old-cli /path/to/current-cli
```

The Linux script writes one JSON record per run, including wall time, CPU time,
peak RSS, tile request count, exit code, and output bytes. Outputs and fresh
caches live under ignored `target/`; `KEEP=1` retains them for inspection.
