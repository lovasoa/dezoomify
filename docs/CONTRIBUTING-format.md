# Contributing a format

Implement a pure parser and tile plan in `crates/dezoomify`, then register its
stable id in `core/registry.rs`. Parsing uses supplied bytes and injected Host
capabilities, per [Architecture](architecture.md).

Routes designate the forwarded target as canonical by default, or the matched
resource when decoding returns an image or catalog directly. That URL must be
able to reconstruct the image or catalog on its own. Use `non_canonical()` for
intermediate resources which need earlier context, or `canonical_source()` when
the matched page is needed by later decoders. Discovery preserves redirects and
reports the selected image's canonical URL; browser handoff falls back to the
entered URL when no route designates one.
See [`DiscoveryRoute`](../crates/dezoomify/src/core/discovery.rs) for the contract.

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
