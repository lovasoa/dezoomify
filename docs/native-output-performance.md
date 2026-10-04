# Native output performance

Owned full-width strips reduce raster wall time and memory. Final review fixes
were measured against master `9fafe8f6`, using release code at `7095e228`.
The CLI and desktop share this backend; desktop startup and IPC are excluded.

Measurements use Linux, an AMD Ryzen AI 7 350, NVMe-backed Btrfs, and a Node
24.19.0 fixture server. The input is 8192×8192: 1024 JPEG tiles of 256×256,
repeating four captured generic-map fixtures. Each run starts with an empty
tile cache, 16 acquisition workers, compression 5, no pacing, and no retries.
Time covers process launch, acquisition, publication, cleanup, and exit.
Builds and fixture setup are excluded. Run order alternates between binaries.
All runs succeeded; tables show medians of five immediate-response pairs and
three pairs with a 50 ms delay per tile response.

| Output | Immediate: master → current | Change | Delayed: master → current | Change |
|---|---:|---:|---:|---:|
| PNG | 0.745 → 0.627 s | 16% faster | 3.951 → 3.584 s | 9% faster |
| JPEG | 1.354 → 1.115 s | 18% faster | 4.596 → 3.719 s | 19% faster |
| TIFF | 0.555 → 0.243 s | 56% faster | 3.786 → 3.446 s | 9% faster |
| IIIF | 4.103 → 3.247 s | 21% faster | 7.315 → 6.127 s | 16% faster |
| ZIF | 2.041 → 2.153 s | 6% slower | 5.227 → 5.438 s | 4% slower |

Immediate JPEG ranges were 1.348–1.377 s and 1.102–1.117 s; ZIF ranges
were 2.019–2.048 s and 2.105–2.166 s. ZIF's small slowdown is consistent
in this run. Its process CPU median still drops from 2.67 to 2.15 s.

GNU `time` measures peak process RSS independently of reservation counters:

| Output | Immediate: master → current | Delayed: master → current |
|---|---:|---:|
| PNG | 519 → 60 MiB | 517 → 50 MiB |
| JPEG | 496 → 55 MiB | 494 → 58 MiB |
| TIFF | 296 → 58 MiB | 294 → 38 MiB |
| IIIF | 883 → 16 MiB | 882 → 16 MiB |
| ZIF | 872 → 16 MiB | 870 → 16 MiB |

Compatible single-tile reuse was also measured separately at 256×256 with
five alternating pairs: IIIF 12.6 → 9.9 ms; ZIF 11.6 → 7.3 ms. These short
runs include process startup and have no missing pyramid levels. Native tests
confirm zero pixel decodes and unchanged JPEG/RGB PNG payloads for this
route; the pipe is bypassed.

The measured configuration limited the ready queue to two 64-row strips.
The current pipeline instead bounds all strips by a shared budget based on
80% of available memory; the tables above measure the identified revision,
before that budgeting change. An 8192×8192 raster requires 128
ownership handoffs. Previously measured direct comparisons with shared stripes
(`44d6f0b5`) reduced PNG/JPEG/TIFF from 1.586/4.612/1.009 s to
0.669/1.223/0.263 s; JPEG CPU dropped from 5.34 to 2.08 s. Those comparisons
preceded the review corrections above.

PNG and TIFF pixels were checked across the entire output against master;
JPEG files were identical. PNG sizes differ by less than 0.02%; TIFF's row
strips increase size by 3.4%. IIIF now preserves the 256-pixel source grid and
publishes width-only plus explicit-dimension aliases: 58.7 MB of logical file
bytes versus 62.0 MB. Hard links share payload storage where available.
ZIF writes conforming tiled BigTIFF with JPEG payloads, rather than the old
TIFF-frame pyramid: 27.2 MB versus 20.6 MB. Container comparisons therefore
include changed packaging; lower pyramid levels still require local codecs.

Current publication syncs staging output; master did not provide the same
durability guarantee. Filesystem caches are warm and application caches fresh.
This is one machine and one fixture; unrelated machine activity can affect runs.
Retired canvas/spool paths and shared-stripe counters have been removed.

Build each CLI in a separate checkout and Cargo target directory with
`cargo build --release --locked -p dezoomify-cli`, then reproduce on Linux:

```sh
REPEATS=5 node scripts/bench-native-output.mjs /path/to/old-cli /path/to/current-cli
DELAY=50 node scripts/bench-native-output.mjs /path/to/old-cli /path/to/current-cli
SIDE=256 FORMATS=iiif,zif REPEATS=5 node scripts/bench-native-output.mjs /path/to/old-cli /path/to/current-cli
```

Each JSON record includes wall and CPU time, peak RSS, request count, exit
code, and published bytes. `KEEP=1` retains outputs under ignored `target/`.
