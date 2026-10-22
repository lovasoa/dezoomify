# Contributing a format

Implement a pure parser and tile plan in `crates/dezoomify`, then register its
stable id in `core/registry.rs`. Parsing uses supplied bytes and injected Host
capabilities, per [Architecture](architecture.md).
Follow [Caller contracts](code-quality.md): state parser input assumptions,
URL/base handling, pixel/grid coordinate conventions, and malformed-input behavior
at the owning declarations. Reuse shared geometry contracts where they apply.

Decoding and metadata parsing designate the decoded resource as canonical by
default. That URL must be able to reconstruct the image or catalog on its own.
Use `non_canonical()` for intermediate routes, and `decode_intermediate_with()`
or `then_decode_intermediate()` for decoder-bound targets needing earlier context.
These opt-outs retain the preceding canonical source. Discovery preserves redirects and
reports the selected image's canonical URL; browser handoff falls back to the
entered URL when no route designates one.
See [`DiscoveryRoute`](../crates/dezoomify/src/core/discovery.rs) for the contract.

For container formats, request bounded metadata and tile slices with the existing
`Request` headers instead of fetching the entire file. Hosts validate partial
responses and distinguish slices in their caches; this transport is shared across
formats. Incremental parsers can replay discovery resources, including their
original requests, to reconstruct state without owning I/O. The
[`ZIF adapter`](../crates/dezoomify/src/zif.rs) demonstrates using a Sans-I/O library
this way. Keep container parsing in that library rather than duplicating it in Hosts.

Add a folder under [`fixtures/<format>/<variant>/`](../fixtures/README.md):
a `viewer.html`, minimal metadata, and links to shared tile images. Add `input.txt`
only to override the viewer entry point with a relative input URL. Static responses
use ordinary files. Query protocols use a fixture-local handler as described
in that README. Adding the viewer
automatically adds a saved-pixel check to each product's matrix.

Distill public metadata into the smallest reproduction that preserves the bug.
Record the original URL, issue, and license in the fixture README. Retain copied
copyright notices; real credentials and private URLs never belong in fixtures.

Run `cargo xtask check`, the focused core tests, then `cargo xtask test all`.
Desktop fixture changes also run the real-window matrix in CI. The PR includes
the source URL and evidence of the produced pixels. Public live checks remain
opt-in and advisory.
