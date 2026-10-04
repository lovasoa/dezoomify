# Native output performance

Owned full-width strips reduce memory and overlap encoding with downloads.
On this fixture, raster outputs are faster than master even with immediate
tile responses. JPEG indexes its owned strip without per-pixel synchronization.

Measured on Linux, AMD Ryzen AI 7 350 (8 cores, 16 threads), with output on an
NVMe-backed Btrfs filesystem and a Node 24.19.0 fixture server. Release CLI binaries compare master `9fafe8f6`
with the owned-strip implementation in PR #1190. The CLI and
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
| PNG | 0.802 → 0.674 s | 16% faster | 3.930 → 3.542 s | 10% faster |
| JPEG | 1.457 → 1.169 s | 20% faster | 4.610 → 3.711 s | 20% faster |
| TIFF | 0.667 → 0.254 s | 62% faster | 3.662 → 3.385 s | 8% faster |
| IIIF | 4.488 → 3.576 s | 20% faster | 7.565 → 6.636 s | 12% faster |
| ZIF | 2.232 → 2.232 s | unchanged | 5.317 → 5.415 s | 2% slower |

Immediate JPEG ranges were 1.429–1.764 s on master and 1.154–1.378 s
currently; median process CPU times were 2.15 and 2.02 s. Delayed JPEG ranges
were 4.482–4.644 and 3.702–3.738 s. ZIF ranges overlap substantially, so its
small median change does not establish a meaningful speed difference.

WebP uses the contiguous-buffer fallback. On a smaller 2048×2048 input,
three immediate runs measured 0.077 → 0.061 s, with identical output lengths.
This short workload says little about larger WebP jobs; the default RAM limit
rejects the 8192×8192 codec workspace before downloading tiles.

## Peak process RSS

These are GNU `time` process measurements, not the internal reservation counter.
The ready queue holds two strips. Raster lookahead is also bounded, preventing
a slow early tile from allowing unlimited later decoding.

| Output | Immediate: master → current | 50 ms/tile: master → current |
|---|---:|---:|
| PNG | 519 → 60 MiB | 517 → 49 MiB |
| JPEG | 495 → 62 MiB | 494 → 55 MiB |
| TIFF | 295 → 62 MiB | 294 → 39 MiB |
| IIIF | 882 → 16 MiB | 881 → 16 MiB |
| ZIF | 871 → 16 MiB | 871 → 15 MiB |

## Ownership handoff versus shared stripes

Five alternating immediate-response pairs compare the previous implementation
(`44d6f0b5`) directly with owned strips under the same Node 24 server:

| Output | Shared stripes → owned strips | Peak RSS |
|---|---:|---:|
| PNG | 1.586 → 0.669 s | 244 → 58 MiB |
| JPEG | 4.612 → 1.223 s | 294 → 60 MiB |
| TIFF | 1.009 → 0.263 s | 209 → 56 MiB |

JPEG process CPU time drops from 5.34 to 2.08 s. Its 67 million pixels now
require 128 ownership handoffs instead of synchronization on every pixel read.

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

The producer copies contributions once into 64-row strips, then releases
decoded tile buffers. Placement, clipping and alpha composition precede handoff;
the encoder only reads owned memory. Active tests cover strip boundaries,
JPEG padding, metadata, retry holes, full-queue cancellation and RAM release.
Retired canvas/spool paths and shared-stripe read counters have been removed.

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
