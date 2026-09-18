# `@dezoomify/bindings`

Stable typed subpaths over the generated WASM contract
(`@dezoomify/wasm-bindings`, emitted by `cargo xtask protocol generate`
from the Rust types in `crates/dezoomify-protocol`). Types-only: no
runtime, no network, no bytes. Boundary modules import these
subpaths and never redeclare Rust contract types.

| Subpath | Contents |
|---|---|
| `@dezoomify/bindings` | Everything below. |
| `@dezoomify/bindings/protocol` | Job commands, host effects, events, catalog, requests, buffers. |
| `@dezoomify/bindings/engine` | Authoritative per-job snapshot projection. |
| `@dezoomify/bindings/errors` | Stable error codes, transports, recovery actions. |

The live `Session` class and its `SessionConfig` stay in
`@dezoomify/wasm-bindings`, next to the WASM runtime they construct.
