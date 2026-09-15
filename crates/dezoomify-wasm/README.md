# dezoomify-wasm

Runs the core/job engine inside browsers as WebAssembly, translating protocol
messages across the JS boundary for `packages/browser-runtime`. It owns no
fetch, DOM, storage, or worker lifecycle: the JavaScript host does that.

```sh
cargo xtask build wasm   # wasm32 build
cargo xtask test wasm    # adapter + node harness + transcript parity
```

Bare `cargo xtask test` covers the crate's native Rust tests but does not
generate WASM bindings. `cargo xtask test wasm` and the WASM portion of
`test all` generate current Node bindings and run the dot-reporter harness;
website browser coverage is Chromium and remains a separate E2E step.
