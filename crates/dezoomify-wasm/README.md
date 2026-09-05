# dezoomify-wasm

Runs the core/job engine inside browsers as WebAssembly, translating protocol
messages across the JS boundary for `packages/browser-runtime`. It owns no
fetch, DOM, storage, or worker lifecycle: the JavaScript host does that.

```sh
cargo xtask build wasm   # wasm32 build
cargo xtask test wasm    # adapter + node harness + transcript parity
```
