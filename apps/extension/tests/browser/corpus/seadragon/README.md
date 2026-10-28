# Seadragon release fixtures

The gzip files preserve unmodified distributions, including their notices:

| Release               | Source                                                                                        | Decompressed SHA-256                                               |
| --------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Seadragon Ajax 0.8.9  | [Upstream tag](https://github.com/aseemk/seadragon-ajax/blob/v0.8.9/seadragon-min.js)         | `7452ba7280068028a21a0ddf7ecc11454ee8143f2d6397f07cb9def2cb254508` |
| OpenSeadragon 0.9.129 | [Distribution](https://cdnjs.cloudflare.com/ajax/libs/openseadragon/0.9.129/openseadragon.js) | `e0c591c79c22edce0ab8dfef8e1efd04ee694ba9cd44f4744c344f73953c9942` |
| OpenSeadragon 1.2.1   | [Distribution](https://cdnjs.cloudflare.com/ajax/libs/openseadragon/1.2.1/openseadragon.js)   | `3eac6dd090035f6229218b8b7c74533c572ffa7ba07ad2255e3ca141e073ee40` |

Seadragon's accompanying license is preserved in [seadragon-license.txt](seadragon-license.txt).
OpenSeadragon's BSD license is included in each distribution. Newer releases use
test-only npm aliases pinned by the workspace lockfile; the matrix lives in
[seadragon-fixture.mjs](../../seadragon-fixture.mjs).

Tests replay all requests locally. They cover exposed and hidden viewers,
single-image and multi-image ownership, custom tile URLs, sparse/custom bounds,
overlapping edge tiles, failures and released sessions in both browser engines.
Seadragon 0.8.9 and OpenSeadragon 0.9.129 lack the later keyboard probe, so fully
hidden instances remain undiscoverable. OpenSeadragon 1.2.1 needs its global
namespace for its own image loader and keeps it during replay.
