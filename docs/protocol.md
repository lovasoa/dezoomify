# Protocol

`crates/dezoomify-protocol` is the Rust source of the exercised job/WASM and Native Messaging boundaries. It generates `packages/protocol-ts` bindings and owns serialization and compatibility tests. A protocol type exists only when production code has both a producer and a consumer; `cargo xtask check` enforces those ownership markers.

## Protocol v2 boundary interactions

| Interaction | Producer | Consumer | Direction | Ordering | Payload ownership | Failure | Deterministic test |
|---|---|---|---|---|---|---|---|
| Discovery fetch need | job | host | job→host effect | FIFO per job | job allocates request ID; host returns bytes or typed failure | typed fetch/decode error | `P05-VARIANTS` golden round trip |
| Deferred image selection | job | UI | job→UI event | once per catalog | job owns catalog IDs | invalid selection rejected | `P05-CATALOG` |
| Fixed tile acquisition | job | host | job→host effect | bounded concurrency | out-of-band buffer handles | retry/partial policy | `P05-BUFFERS` |
| Adaptive probe/observation | job | host | effect/response pair | deterministic priority | host reports observation | probe limit error | `P05-VARIANTS` |
| Decode/process/write/encode/finalize/publication | host | job | host→job response | correlated by effect ID | buffers released exactly once | typed outcome | `P05-OUTPUT` |
| Destination request/response | job | host | effect/response pair | before any write | opaque destination ID | rejection recovers | `P05-OUTPUT` |
| Recovery choice | job/UI | job | event/command pair | correlated by recovery ID | typed allowed actions | stale choice rejected | `P05-RECOVERY` |
| Progress snapshot | job | UI | job→UI event | monotonic | absolute counts | n/a (transient) | `P05-VARIANTS` |
| Terminal outcome | job | UI | job→UI event | exactly once | output ID or error | terminal wins | `P05-VARIANTS` |

## Commands

Commands express user intent and carry a request or job identifier. They cover discovery, selection, job start, cancellation, pause and resume (Pause v1 suspend-acquisition), recovery choice, output confirmation, and handoff import. Pause stops scheduling new tiles while in-flight work finishes and decoded output is retained; resume re-drives the pending queue. Duplicate pause is ignored; resume without pause is rejected. Commands are idempotent where retries are expected; duplicate identifiers do not duplicate work.

## Events

Events are ordered per job and include state snapshots, selection requests, phase changes, progress, active transport and transport transitions where applicable, warnings, recovery requests, output readiness, completion, cancellation, failure, and pause/resume (`paused`/`resumed`, replayable, never terminal). Every event has a schema version, sequence number, and correlation identifier. Consumers can request a fresh snapshot after a gap.

## Capabilities

The website baseline reports encoders `[png, jpeg, tiff]`.

Each product reports its concrete capabilities at its product boundary. Capability documents are not a cross-version job DTO and carry no synthetic schema fingerprint. The job engine validates final requests, so UI gating is never the only check.

## Errors

Protocol errors contain a stable code, phase, retryability, safe user message, structured context, and permitted recovery actions. Host exception text is diagnostic data and never becomes the contract. See [Errors](errors.md).

## Handoff

A website or deep-link handoff is application input rather than a general protocol envelope. The receiver treats every field as untrusted, validates it by URL parsing plus exact sensitive-key matching, and requires user confirmation. No credentials travel in the URL and no client-side signing is used.

Extension-to-native handoff uses only allowlisted Native Messaging. Browser enforcement of the native host's allowed extension IDs authenticates the extension sender to the native host. A fresh challenge and one-use nonce bind the handoff messages to one explicit consent session and prevent replay; they do not establish sender identity. Cookies use that separate consent-bound channel, are scoped to named origins, and are not intentionally persisted; consent names origins, scope, recipient, and job, stays memory-only, and never carries over to later jobs. See [Security](security.md#credentials).

## Version handshake

Every job/WASM or Native Messaging connection requires protocol 2.0 before exchanging job data. Protocol 1.x is rejected through `protocol.incompatible`; there is no translation or version alias. Declared fields, challenges, and nonces do not establish identity. On the extension-to-native channel, sender authentication comes from browser enforcement of the native host's allowed extension IDs; challenge and nonce provide session binding and replay defense only.

Release automation verifies generated files, compatibility fixtures, and the supported version matrix. See [Releases](releases.md).
