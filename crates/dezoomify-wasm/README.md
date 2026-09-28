# dezoomify-wasm

Exposes the async Rust `dezoomify` function and generated `Host` contract to
JavaScript. The function awaits the capabilities supplied by `BrowserHost` in
`packages/browser-runtime`. Rust owns the algorithm; the Host owns browser I/O.

```sh
cargo xtask build wasm   # wasm32 build
cargo xtask test wasm    # real WASM Host ABI and promise harness
```

Bare `cargo xtask test` covers the crate's native Rust tests but does not
generate WASM bindings. `cargo xtask test wasm` and the WASM portion of
`test all` generate current Node bindings and run the dot-reporter harness;
website browser coverage is Chromium and remains a separate E2E step.
