# Product fixtures

Add `format/variant/viewer.html` with minimal metadata and relative links to
shared images under `tiles/`. Optional `input.txt` overrides the entry point
with a relative URL. Every basic fixture produces the same 512×512 image from
shared tiles. Adding a viewer automatically adds a saved-pixel check to the
CLI, website, packaged extension, and desktop window matrices.

Comparisons are exact by default. Prefix a variant with `approximate-` only
when JPEG decoding requires a two-value RGB tolerance; dimensions and alpha
remain exact. No per-fixture registration or generated expectations are needed.

## Viewer readiness and responses

`viewer.html` sets `data-viewer-ready="true"` after response bodies have loaded,
so the extension snapshot includes them. Headers alone are insufficient.
For direct inputs, link to the shared viewer template; the server substitutes
`{{input}}` from `input.txt`, or defaults to `viewer.html`.

Use ordinary files and relative symlinks for static responses. A fixture-local
`server.js` can export `serve(request, { file, origin }): Response | null`
(optionally async) for query protocols, authentication, or special responses.
Return null to yield to another handler or a matching static file; a returned
404 is final. `file` is the matching static resource. Handlers may reuse
`tiles/server.js`; the generic Node server knows no image formats.

## Provenance

These bytes are synthetic GPL-3.0-or-later data. Record the source URL, issue,
and license when adding a reproduction; retain any copied notices. Never include
real credentials or private URLs. Historical reproductions and their grants live
in [`testdata/scenarios/`](../testdata/scenarios/README.md).
