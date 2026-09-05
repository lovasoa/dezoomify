# Web Application

The Dezoomify website: paste a zoomable-image URL, pick a format (or let it
detect), press **Dezoomify !**, and save the full-resolution result.

- Entry: [`index.html`](index.html) (+ [`privacy.html`](privacy.html),
  [`terms.html`](terms.html)); logic in [`src/`](src/).
- Transport, always visible in the UI: direct browser fetch first; only after
  a classified network/CORS failure, eligible public metadata (never tiles)
  retries automatically through the same-origin metadata proxy, with an
  opt-out and zero credentials on either hop.
- Server endpoints live in [`functions/`](functions/) (metadata proxy only).

Contributing: no open proxy, no credential forwarding, no private/local proxy
destinations, no hand-written protocol copies. Tests: `cargo xtask test web`.
