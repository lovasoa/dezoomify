# Protocol

`crates/dezoomify-protocol` is the Rust source of the boundary between the shared UI, CLI front ends, and runtimes. It generates the schema and `packages/protocol-ts` bindings plus serialization and compatibility tests. Other handwritten protocol types are not accepted.

## Protocol v1 boundary interactions

| Interaction | Producer | Consumer | Direction | Ordering | Payload ownership | Failure | Deterministic test |
|---|---|---|---|---|---|---|---|
| Discovery fetch need | job | host | job→host effect | FIFO per job | job allocates request ID; host returns bytes or typed failure | typed fetch/decode error | `P05-VARIANTS` golden round trip |
| Deferred image selection | job | UI | job→UI event | once per catalog | job owns catalog IDs | invalid selection rejected | `P05-CATALOG` |
| Fixed tile acquisition | job | host | job→host effect | bounded concurrency | out-of-band buffer handles | retry/partial policy | `P05-BUFFERS` |
| Adaptive probe/observation | job | host | effect/response pair | deterministic priority | host reports observation | probe limit error | `P05-VARIANTS` |
| Decode/process/write/encode/finalize/publication | host | job | host→job response | correlated by effect ID | buffers released exactly once | typed outcome | `P05-OUTPUT` |
| Scan candidate | extension | job | host→job | first-seen order | scan-scoped IDs | stale scan rejected | `P05-SCAN` |
| Website/deep-link handoff | website/OS | app | inbound intent | one-shot + confirm | receiver validates untrusted input | `handoff.rejected` | `P05-HANDOFF` |
| Destination request/response | job | host | effect/response pair | before any write | opaque destination ID | rejection recovers | `P05-OUTPUT` |
| Recovery choice | job/UI | job | event/command pair | correlated by recovery ID | typed allowed actions | stale choice rejected | `P05-RECOVERY` |
| Progress snapshot | job | UI | job→UI event | monotonic | absolute counts | n/a (transient) | `P05-VARIANTS` |
| Terminal outcome | job | UI | job→UI event | exactly once | output ID or error | terminal wins | `P05-VARIANTS` |

## Commands

Commands express user intent and carry a request or job identifier. They cover discovery, selection, job start, cancellation, pause and resume (Pause v1 suspend-acquisition), recovery choice, output confirmation, and handoff import. Pause stops scheduling new tiles while in-flight work finishes and decoded output is retained; resume re-drives the pending queue. Duplicate pause is ignored; resume without pause is rejected. Commands are idempotent where retries are expected; duplicate identifiers do not duplicate work.

## Events

Events are ordered per job and include state snapshots, selection requests, phase changes, progress, active transport and transport transitions where applicable, warnings, recovery requests, output readiness, completion, cancellation, failure, and pause/resume (`paused`/`resumed`, replayable, never terminal). Every event has a schema version, sequence number, and correlation identifier. Consumers can request a fresh snapshot after a gap.

## Capabilities

At connection time a runtime reports supported input schemes, fetch modes, decoders, encoders, processing operations, storage features, concurrency, practical size limits, bulk support, pause support, and handoff support. The shared UI gates controls from this declaration. The job engine also validates the final request, so capability checks are not UI-only. Bulk text discovery yields deferred entries that resolve one at a time; the website single-queue and the desktop multi-job queue run sequential single-job runs in their integration layers, so `bulk_supported` is true on the browser and native baselines. Queue availability is negotiated per connection: both peers must advertise `bulk_supported`, and an N-1 peer without it runs single jobs with the queue controls hidden. Pause v1 is negotiated the same way: both peers must advertise `paused_supported` (N-1 payloads omit it and default to false, hiding pause controls without breaking the 1.0 handshake). Handoff import is supported through validated `HandoffDto`. The native baseline reports encoders `[png, jpeg, tiff]`, destination modes `[file, iiif-dir]`, storage modes `[cache]`, `bulk_supported` true, and `paused_supported` true. The CLI `--bulk` loop runs one bounded single-job run per list entry and shares the queue per-entry plus totals reporting.

## Errors

Protocol errors contain a stable code, phase, retryability, safe user message, structured context, and permitted recovery actions. Host exception text is diagnostic data and never becomes the contract. See [Errors](errors.md).

## Handoff

A website or deep-link handoff contains bounded non-secret input such as the source, selection, recipe, output intent, required capabilities, expiration, and originating application version. The sender offers it as a one-click Send to desktop action with an origin/scope summary (origin, no-credential scope, desktop recipient, single memory-only job); the receiver treats every field as untrusted, validates it by URL parsing plus exact sensitive-key matching, and requires user confirmation. Validation rejects userinfo, non-http(s) schemes, oversize input, unknown or duplicate fields, unsupported versions, malformed encoding, and sensitive query or fragment keys; `/cookie-recipe/` stays valid while `?token=secret` is rejected. No credentials travel in the URL and no client-side signing is used. Error text redaction has a single source in `crates/dezoomify-protocol`; all hosts delegate to it.

Extension-to-native handoff uses only allowlisted Native Messaging. Browser enforcement of the native host's allowed extension IDs authenticates the extension sender to the native host. A fresh challenge and one-use nonce bind the handoff messages to one explicit consent session and prevent replay; they do not establish sender identity. Cookies use that separate consent-bound channel, are scoped to named origins, and are not intentionally persisted; consent names origins, scope, recipient, and job, stays memory-only, and never carries over to later jobs. See [Security](security.md#credentials).

## Version handshake

Every connection starts with application version, protocol version range, schema fingerprint, runtime kind, and capabilities. Peers select a mutually supported protocol version before exchanging job data. Declared fields, challenges, and nonces do not establish identity. On the extension-to-native channel, sender authentication comes from browser enforcement of the native host's allowed extension IDs; challenge and nonce provide session binding and replay defense only. No version overlap produces `protocol.incompatible` with an update recovery action, and unknown fields never authorize behavior.

Release automation verifies generated files, schema fingerprints, compatibility fixtures, and the supported version matrix. See [Releases](releases.md).
