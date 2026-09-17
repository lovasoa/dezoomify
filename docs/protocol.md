# Cross-language contracts

`crates/dezoomify-protocol` is the single source of truth for job commands,
host effects, job events, errors, configuration, buffer references, catalogs,
and Native Messaging requests. Its Rust definitions derive `Serialize`,
`Deserialize`, and `Tsify`. The real `wasm-bindgen` declaration is tracked in
`packages/wasm-bindings` and imported by every TypeScript boundary.

`cargo xtask protocol generate` builds `dezoomify-wasm` and writes that
declaration. `cargo xtask protocol generate --check` builds it in a temporary
directory and compares it byte-for-byte with the tracked package. TypeScript
compilation against the declaration is part of `cargo xtask check`.

## WASM session ABI

One JavaScript `Session` owns one Rust job and byte arena:

- `new Session(SessionConfig)` validates typed quotas;
- `dispatch(JobCommand)` returns a `DispatchResult` immediately;
- a successful result contains ordered `HostMessage[]` values;
- `dispose()` returns its final `DispatchResult` and is repeat-safe;
- arena methods exchange generated `ArenaHandle` and `BufferHandle` objects.

Commands, effects, events, configuration, errors, URLs, and handles cross as
native JavaScript objects converted fallibly by `tsify` and
`serde-wasm-bindgen`. Binary resource bodies stay in the bounded WASM arena.
Closed concepts such as processing recipes and output formats are generated
string-literal unions, never free-form strings. Available probe observations
deserialize into non-zero dimensions; a missing observation is a separate
union variant.

## Commands, effects, and events

`JobCommand` expresses user intent or answers one correlated effect. `Start`
carries ordered discovery roots. Resource answers carry a job-scoped request
number and either a buffer reference or a `FetchFailureDto`. Image and level
choices are zero-based positions in the immutable catalog. Recovery choices
carry the outstanding decision generation.

`HostEffect` is exhaustive: resource acquisition, tile/probe acquisition,
output finalization, host cancellation, and recovery decisions. `JobEvent` is
also exhaustive and carries state, catalog, progress, warnings, recovery, and
terminal outcomes. Website, extension, and worker boundaries use exhaustive
typed handler tables over these generated unions.

## Errors

`ErrorDto` contains a stable code, phase, retryability, user message, recovery
actions, and optional request URI, transport, resource kind, blocked reason,
HTTP status, bounded server signal, and diagnostic detail. A browser fetch
failure crosses as `FetchFailureDto`, which contains only facts the host can
observe. The Rust session recovers the correlated request and derives phase,
request URI, and resource kind, so a product classifier cannot omit or invent
them. See [Errors and recovery](errors.md).

An adapter fault is a separate `DispatchResult` branch. It represents invalid
external input or session misuse and never replaces a job failure.

## Native Messaging version check

The independently installed extension and desktop app perform an explicit
version check. `NativeHostRequest` is generated from Rust and the
native host rejects unsupported versions; it does not translate schemas.
Browser allowlisting authenticates the extension sender. A fresh challenge and
single-use nonce bind one consented credential handoff and prevent replay.

Website and deep-link handoff inputs are product inputs, not part of the WASM
session ABI. They remain independently validated as untrusted URLs.

## Product capabilities

The website baseline reports encoders `[png, jpeg, tiff]`. Capability values
belong to product integrations; the job engine still validates requested work.
