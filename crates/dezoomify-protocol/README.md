# dezoomify-protocol

- **Responsibility:** Own the single canonical versioned Rust wire contract
  shared by jobs, hosts, workers, TypeScript runtimes, and UIs; it is the source
  from which `packages/protocol-ts` is generated.
- **Allowed dependencies:** Serialization/schema libraries that work on native
  and WebAssembly targets; remain independent of core and host implementations.
- **Forbidden responsibilities:** No orchestration, I/O, UI state, browser/native
  types, secrets, or unversioned exposure of internal domain structures.
- **Interfaces and tests:** Define commands, events, capability requests/results,
  progress, stable error envelopes, and typed recovery actions in Rust. Require
  bounded versioned non-secret DTOs for website/deep-link handoff; receivers
  still treat them as untrusted and validate them before confirmation. Require
  deterministic TypeScript generation through `crates/xtask`, serialization
  compatibility, schema fingerprints, version handshakes, golden fixtures, and
  Rust/TypeScript round-trip tests.
- **Migration source:** Derive required events and errors from both
  `migration-sources/dezoomify-rs` and `migration-sources/dezoomify-web`; no
  legacy protocol is copied verbatim.
