# TypeScript Packages

Shared browser-side code consumed by the apps:

- [`shared-ui/`](shared-ui/): the host-neutral interface (status card,
  progress, guidance) embedded by every graphical app.
- [`browser-runtime/`](browser-runtime/): fetch, decode, display, and save
  behind a readable-bytes vs. display-only distinction.
- [`wasm-bindings/`](wasm-bindings/): the declaration emitted from the
  authoritative Rust contracts by the real WASM build (never hand-edited; regenerate with
  `cargo xtask protocol generate`).

Contributing: packages stay host-neutral; no app entry points, no direct
extension/native APIs, and no second contract source.
