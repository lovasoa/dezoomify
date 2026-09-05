# Rust Crates

Reusable engine libraries and repository tooling, layered from pure logic
outward to hosts:

- [`dezoomify-core/`](dezoomify-core/) — pure image discovery (no I/O).
- [`dezoomify-protocol/`](dezoomify-protocol/) — the versioned wire contract.
- [`dezoomify-job/`](dezoomify-job/) — portable download state machine.
- [`dezoomify-native/`](dezoomify-native/) — native HTTP, cache, codecs.
- [`dezoomify-wasm/`](dezoomify-wasm/) — browser adapter for core/job.
- [`fixture-server/`](fixture-server/) — deterministic local test server.
- [`xtask/`](xtask/) — `cargo xtask`, the repo task runner.

Contributing: dependencies flow toward `core`/`protocol`, never away; `core`
and `job` stay free of I/O, clocks, and host frameworks (enforced by purity
tests).
