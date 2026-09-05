# dezoomify-protocol

The single versioned contract between the engine and every app: commands,
events, progress, stable error codes, and typed recovery actions. The Rust
types here generate `packages/protocol-ts`, so both sides stay in lockstep
(checked by golden round-trip tests).

```sh
cargo xtask protocol generate   # regenerate TypeScript + schemas
cargo xtask protocol check      # goldens, fingerprints, WASM portability
cargo xtask test protocol
```
