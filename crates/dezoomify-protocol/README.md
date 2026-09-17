# dezoomify-protocol

The authoritative Rust contract between the job engine and its hosts:
commands, effects, events, stable errors, and Native Messaging requests.
`Tsify` and `wasm-bindgen` emit the declaration tracked in
`packages/wasm-bindings`.

```sh
cargo xtask protocol generate   # regenerate the real WASM declaration
cargo xtask protocol check      # drift, TypeScript, Rust, WASM portability
cargo xtask test protocol
```
