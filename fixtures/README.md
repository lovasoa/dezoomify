# Product fixtures

Each `format/variant/input.txt` contains one relative input URL. The same fixtures
run through CLI, website, and packaged extension tests, and the desktop window lane.
Every basic fixture produces the same 512×512 image from shared 256×256 PNG or JPEG tiles in `tiles/`.
Tests check every saved pixel exactly by default. Prefix the variant directory
with `approximate-` when the result needs a two-value RGB tolerance, such as
JPEG decoding. Dimensions and alpha are always exact. This naming convention
is interpreted by shared discovery, without per-fixture registration.

The historical CLI tile paths link to the shared PNGs; no product owns those bytes.

Static resources are ordinary files and relative symlinks. `viewer.html` loads the
input so the extension observes it as a real viewer request. The server substitutes
`{{input}}` with the adjacent `input.txt` URL in the viewer template. `server.js` exports
`serve(Request): Response` only where a protocol needs query-based tile requests.
Handlers share the ordinary `tiles/server.js` helper; the HTTP server knows no formats.

All bytes here are synthetic GPL-3.0-or-later test data. Fixture changes are reviewed
as ordinary source changes. No hash manifest, registration, or generated expectations.
Focused tests still cover malformed input, credentials, retries, limits, and cancellation.

Variants exercise viewer-to-metadata discovery (British Library, NLA, WDL,
Hungaricana, National Gallery, Zoomify brokers and ETE), inline Zoomify geometry,
IIIF v1 and constrained tile sizes, a multilingual IIIF manifest, TopViewer asset
selection, and descending custom tile coordinates. They reuse the basic metadata
and shared tiles; adding a variant requires no test or server changes.

Additional variants exercise FSI viewer discovery, WMTS matrix limits and geographic
bounds, skipping unsupported WMTS layers and unusable Krpano levels, IIIF viewer
parameters and upscaling recovery, inferred custom geometry, and alternate image
entry points. Viewer syntax and metadata shapes reuse the small reproductions in
`dezoomify-rs/dezoomify-core/testdata/coverage`; image bytes remain shared here.
Captured Krpano and Google Arts pages already live in the historical corpus.

CONTENTdm fixes its API paths at `/digital/`; its ordinary response files therefore
live under `testdata/scenarios/formats/contentdm/payloads/127.0.0.1/`. The four
viewer variants exercise absolute, site-relative, `/digital/`, and relative IIIF
references. The existing historical iframe replay also follows a Polona record
through its item JSON, preserving the same geometry and tile URL assertions.
