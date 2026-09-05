# Web Application (preview scaffold)

The Dezoomify website preview: paste a URL, run direct-first metadata fetch
through the shared classifier, and get honest negative/error handling.

- Preview scope: generic pages fail with `NO_IMAGE_FOUND` (no fake tiles);
  zoomable signals stop at a preview message — tile download and save are not
  wired yet.
- Entry: [`index.html`](index.html) (+ [`privacy.html`](privacy.html),
  [`terms.html`](terms.html)); logic in [`src/`](src/).
- Transport, always visible in the UI: direct browser fetch first; only after
  a classified network/CORS failure, eligible public metadata (never tiles)
  retries automatically through the same-origin metadata proxy, with an
  opt-out and zero credentials on either hop.
- Server endpoints live in [`functions/`](functions/) (metadata proxy only).

Contributing: no open proxy, no credential forwarding, no private/local proxy
destinations, no hand-written protocol copies. Tests: `cargo xtask test web`.
