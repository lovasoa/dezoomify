# Rust Crates

Reusable engine libraries and repository tooling, layered from pure logic
outward to hosts:

- [`dezoomify/`](dezoomify/): canonical model, pure discovery formats, and
  deterministic job engine (no I/O).
- [`dezoomify-native/`](dezoomify-native/): native HTTP, cache, codecs.
- [`dezoomify-wasm/`](dezoomify-wasm/): browser ABI and tile processing entrypoint.
- [`fixture-server/`](fixture-server/): deterministic local test server.
- [`xtask/`](xtask/): `cargo xtask`, the repo task runner.

Contributing: dependencies inside `dezoomify` flow engine to formats to model;
the crate stays free of I/O, clocks, tasks, and host frameworks (enforced by
structured Cargo-metadata checks, semantic Clippy path bans, and separate
module-boundary tests).
