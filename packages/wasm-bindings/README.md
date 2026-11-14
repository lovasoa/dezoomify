# WASM bindings

Provides the TypeScript declarations and output-format metadata shared by
JavaScript products and the Rust core. They are generated from the Rust
definitions so both languages describe the same capabilities and values.

This package describes the boundary; [dezoomify-wasm](../../crates/dezoomify-wasm/)
provides the executable bridge used by [browser-runtime](../browser-runtime/).
