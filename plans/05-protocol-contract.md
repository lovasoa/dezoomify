# Phase 05: Protocol Contract

## Objective

Define and freeze protocol version 1 for communication between host runtimes
and shared Rust logic. Author every DTO once in Rust, then deterministically
generate the TypeScript declarations, JSON schema, capability artifacts, and
golden vectors consumed by native and web code. Cover scanning, handoff, output,
and recovery as well as discovery/job control without exposing internal core
types or browser/native capabilities.

## Non-Goals

- Do not implement the job state machine; phase 06 owns behavior.
- Do not perform network, filesystem, clock, image decode/encode, DOM, or UI
  operations in the protocol crate.
- Do not serialize arbitrary internal Rust debug representations.
- Do not carry large resource/tile bytes inside JSON control messages.
- Do not design a remote multi-user service protocol, persistence format, or
  extension transport. The DTOs may carry transport-neutral handoff intent.
- Do not remove or weaken core APIs to fit a convenient wire shape.
- Do not hand-maintain TypeScript DTOs, a second schema, capability declarations,
  or golden payload shapes. They are generated from the canonical Rust DTOs.
- Do not invent a universal client signature. Website/deep-link handoff input is
  non-secret and untrusted; Native Messaging identity is a later host concern.

## Dependencies and Preconditions

- Phases 00-04 are complete.
- `dezoomify-core` parity, purity, native/WASM compilation, and deterministic
  aggregate tests pass.
- Catalog/model invariants and all required host effects are documented.
- Phase-02 decisions identify user-visible errors, request headers, selections,
  cancellation, retries, and progress semantics that cross runtime boundaries.
- No unresolved representation decision remains for URLs, IDs, byte payloads,
  integer ranges, or optional fields.
- The approved pnpm version is available and is pinned in the root
  `packageManager` field before the first lockfile generation.
- Phase-03 scenarios cover the known scan, handoff, destination/output, partial,
  and recovery flows or mark the missing protocol vectors as phase-05 blockers.

## Exact Source and Destination Paths

| Input/concern | Exact source | Exact destination |
|---|---|---|
| Core concepts | `crates/dezoomify-core/src/core/{discovery,model,tile_plan,adaptive}.rs` | Protocol DTO modules only; core remains unchanged unless a proven core bug exists |
| Parity requirements | `docs/migration/parity-matrix.csv`, `docs/migration/parity-decisions.md` | Existing flat `docs/protocol.md`, plus relevant links in `docs/architecture.md` |
| Transcript shape | `testdata/scenarios/schema/transcript.schema.json`, scenario-local expected files | Versioned protocol fields generated from the canonical DTOs and referenced by scenario schemas |
| Protocol crate | New | `crates/dezoomify-protocol/Cargo.toml`, `src/lib.rs` |
| Canonical DTO source | New | `crates/dezoomify-protocol/src/dto.rs`; the only authored command/effect/response/event/capability/handoff/output/recovery DTO definitions |
| Codec/generator support | New | `crates/dezoomify-protocol/src/{codec,generate}.rs` and `src/bin/generate-protocol.rs`; may consume DTO metadata but may not redeclare DTOs |
| Generated TypeScript package | New | `packages/protocol-ts/package.json`, `src/generated.ts`, `schema/protocol-v1.schema.json`, `schema/capabilities-v1.schema.json`, generated fingerprints/manifests, and tests |
| Root JavaScript workspace | New | Root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`; includes `packages/*` and uses the phase-approved pinned package manager |
| Capability artifacts | Canonical capability DTOs | Generated TypeScript declarations, schemas, capability-key manifest, and fingerprints under `packages/protocol-ts`; capability message examples remain scenario payloads |
| Golden vectors | New | Rust/TypeScript test harnesses in their owning crate/package; canonical payloads and expected bytes under `testdata/scenarios/protocol-v1-<id>/**` |
| Xtask check | Phase-03 xtask | `crates/xtask/src/protocol.rs`, `crates/xtask/src/main.rs` registration |
| Workspace | Existing Cargo workspace plus new pnpm workspace | Root Cargo and pnpm manifests/locks |

## Protocol V1 Required Surface

Protocol types must cover these concepts, using final names approved during the
phase:

| Category | Required concepts |
|---|---|
| Version | Major/minor or exact v1 marker, supported-version query, incompatible-version error |
| Stable IDs | Session, scan, candidate, job, operation, request, image, level, tile, attempt, effect, buffer, destination, output, recovery, and handoff IDs with documented scope/lifetime |
| Scan DTOs | Start/cancel scan, candidate observation, candidate list/snapshot, source/frame identity, confidence/reason, dedup key, and scan completion/failure without privileged page data |
| Job commands | Start, provide resource/tile bytes or fetch failure, select image/level, provide decode/process/write/encode/finalize/publication outcomes, retry-ready, partial/recovery choice, destination response, cancel |
| Host effects | Scan/acquire resource or tile; request destination; decode and process pixels; open/write/finalize encoder; publish output; release bytes; cancel work; request explicit user/recovery/partial decision |
| Events | Scan snapshot, job state, catalog, selection, destination, progress, warning, recovery/partial decision, output readiness/publication, completion, partial completion, failure, cancellation |
| Catalog DTO | Ordered entries/images/levels, dimensions, names/format IDs, fixed/adaptive source summary, safe integer values |
| Capabilities | Versioned input schemes, scan/fetch modes, decoders, pure processing operations, encoders, destination/publication modes, storage/cache, concurrency/size limits, bulk and handoff support |
| Handoff | Non-secret input/source intent, selected candidate/catalog identity, selection/recipe/output intent, required capabilities, provenance label, expiry hint, and optional reusable opaque references; no credentials or universal signature requirement |
| Output | Destination request/response, format/options, dimensions, metadata, partial marker/missing tiles, write/encode/finalize/publication outcomes, output reference, digest/size where available |
| Recovery | Stable recovery action IDs/kinds, allowed choices, scope, preconditions, user-safe prompt data, retry/skip/partial/escalate/open-settings intent, and correlated choice/result |
| Errors | Stable code, phase, retryability, human message, recovery actions, optional source/request/tile/output IDs, and structured details without unstable debug text |
| Byte transport | Out-of-band byte-buffer handle plus length/checksum where needed; JSON references the handle, not base64 payload by default |

## Command Status

### Available from Completed Phases

```sh
cargo xtask sources verify
cargo xtask fixtures verify
cargo xtask parity validate
cargo xtask test core --purity
cargo xtask test core --parity
cargo xtask test
cargo test -p dezoomify-core
```

No root pnpm workspace, protocol package, generated declaration/schema, or
protocol-specific xtask command exists at phase start; their absence is expected
until the creation steps below.

### Added by This Phase

```sh
cargo xtask protocol generate
cargo xtask protocol check
cargo xtask protocol generate --check
cargo xtask test protocol
pnpm --filter @dezoomify/protocol-ts test
```

The Cargo commands become valid only after the protocol crate/generator and
step 12 xtask integration exist. The pnpm test command becomes valid only after
step 10 creates generated artifacts and real tests; step 3 only makes pnpm
workspace/install commands available.

## Numbered Atomic Steps

1. Enumerate all boundary interactions before defining types.

   Trace each phase-02 parity row and core operation. Create a table in
   the protocol-v1 section of existing `docs/protocol.md`, mapping interaction,
   producer, consumer,
   direction, ordering, payload ownership, failure, and required deterministic
   test. Include discovery fetches, deferred images, selections, fixed tiles,
   adaptive probes/observations, decode acceptance, retries, cancellation,
   progress, and terminal outcomes.

   Validation:

   ```sh
   cargo xtask parity validate
   git diff --check -- docs/protocol.md docs/architecture.md
   ```

2. Define protocol compatibility rules.

   Version 1 must define unknown enum/message behavior, required versus optional
   fields, additive minor changes, breaking major changes, sender/receiver
   version negotiation, duplicate message handling, and terminal-state rules.
   Reject unsupported major versions before starting work. Preserve unknown
   structured details only where safe; never reinterpret an unknown command.

   Define handoff trust separately from protocol compatibility. Website query/
   fragment and OS deep-link envelopes are untrusted, non-secret input that the
   receiver validates, capability-checks, and confirms with the user. They do
   not require or imply a universal client signature. Native Messaging sender
   authentication and extension installation trust are deferred to phase 12:
   the browser enforces the native-host manifest's exact allowed extension IDs
   and thereby authenticates the sender of the browser-established channel.
   Challenge/nonce fields provide only session binding and replay defense; they
   do not authenticate the sender and must not be simulated as a protocol
   signature field.

   Validation:

   ```sh
   git diff --check -- docs/protocol.md
   ```

3. Create the pure Rust protocol crate and root pnpm workspace skeleton.

   Add `crates/dezoomify-protocol` to the Cargo workspace. Create root
   `package.json`, `pnpm-workspace.yaml`, and `pnpm-lock.yaml` with a pinned
   package-manager declaration and `packages/*` membership, then create the
   minimal `packages/protocol-ts/package.json`. Allow deterministic portable
   serialization/schema/generation libraries only. Do not depend on
   `dezoomify-core` if DTOs can remain independent; conversion belongs in
   `dezoomify-job`. Ban networking, async runtime, image codecs, filesystem,
   browser bindings, and platform-specific dependencies from protocol code.

   Validation:

   ```sh
   cargo check -p dezoomify-protocol --no-default-features
   cargo tree -p dezoomify-protocol --edges normal --depth 1
   cargo check -p dezoomify-protocol --target wasm32-unknown-unknown --no-default-features
   pnpm install --lockfile-only
   pnpm install --frozen-lockfile
   pnpm --filter @dezoomify/protocol-ts exec node --version
   git diff --check -- package.json pnpm-workspace.yaml pnpm-lock.yaml packages/protocol-ts
   ```

4. Define strongly typed IDs and integer constraints.

   Author them in `crates/dezoomify-protocol/src/dto.rs`; do not create parallel
   wire declarations in other Rust modules. IDs must not be reused within their
   documented scope. Choose a wire form that
   is lossless in JavaScript; values larger than JavaScript's safe integer range
   must be strings or bounded. Define coordinate/dimension/count maximums and
   checked conversion failures. Do not expose Rust `usize` on the wire. Test
   equality, ordering, display/parse, wrong-kind rejection, and boundary values.

   Validation:

   ```sh
   cargo test -p dezoomify-protocol id
   cargo clippy -p dezoomify-protocol --all-targets -- -D warnings
   ```

5. Define request and byte-buffer ownership types.

   Continue the canonical declarations in `dto.rs`. Preserve URI text exactly
   after the core's approved normalization; preserve
   ordered headers if duplicate/order semantics matter, otherwise document
   canonical case-insensitive handling. Include request purpose and IDs. Define
   who allocates, transfers, consumes, and releases byte buffers. A repeated or
   stale buffer handle must produce a typed protocol error, not use-after-free
   behavior. Secret headers must be redacted from logs/transcripts according to
   explicit rules but delivered intact to hosts.

   Validation:

   ```sh
   cargo test -p dezoomify-protocol request
   cargo test -p dezoomify-protocol buffer
   ```

6. Define catalog and selection DTOs.

   Define scan candidate/list/snapshot DTOs first, including source/frame
   provenance, confidence/reason, dedup identity, and safe observed metadata.
   Project core catalogs into a stable representation without exposing private
   enums. Preserve semantic ordering and include enough fields for UI/native
   selectors: stable image/level IDs, display labels, format, dimensions,
   available levels, readiness/deferred state, and source kind. Explicitly
   represent absent values. Validate every numeric conversion.

   Validation:

   ```sh
   cargo test -p dezoomify-protocol catalog
   cargo test -p dezoomify-protocol bounds
   ```

7. Define complete commands, effects, responses, and events.

   Make direction impossible to confuse through separate enums in `dto.rs`.
   Cover scanning and handoff import; discovery and selection; destination
   request/response; tile acquisition; decode and pure-processing outcomes;
   writer/encoder creation and writes; encoder finalization; publication;
   partial-result and recovery choices; cleanup/release acknowledgements; and
   cancellation. Every effect expecting a response has a correlation ID and
   exactly documented response variants. Every event says whether it is
   replayable, transient, decision-requesting, or terminal. Progress is an
   absolute phase snapshot, not timing-dependent increments alone.

   Validation:

   ```sh
   cargo test -p dezoomify-protocol messages
   cargo test -p dezoomify-protocol correlation
   ```

8. Define capabilities, handoff, output, recovery, and stable errors.

   Define complete capability DTOs and generated declaration/schema/key artifacts for
   runtime negotiation. Define website/deep-link handoff as untrusted non-secret
   input; exclude credentials, cookies, authorization headers, local paths, and
   any universal signature requirement. Include enough output DTOs to request a
   destination, configure encoding, report writes/finalization/publication, and
   identify complete or marked-partial results. Define typed recovery actions
   and correlated choices rather than human-message parsing.

   Create reviewed codes for invalid command/state, unsupported version,
   malformed input, discovery exhaustion/limits, fetch/decode failure, invalid
   selection, resource limits, cancellation, and internal invariant violation.
   Separate stable code/details from human presentation. Ensure URLs/headers in
   errors use redaction rules. Do not serialize arbitrary error chains or
   platform-specific text as compatibility assertions.

   Validation:

   ```sh
   cargo test -p dezoomify-protocol capability
   cargo test -p dezoomify-protocol handoff
   cargo test -p dezoomify-protocol output
   cargo test -p dezoomify-protocol recovery
   cargo test -p dezoomify-protocol error
   cargo test -p dezoomify-protocol redaction
   ```

9. Implement canonical control-message encoding.

   Define UTF-8 JSON (or another explicitly approved format) with one stable
   externally tagged message representation, sorted/canonical object fields for
   golden output, no NaN/infinity, LF line endings, and deterministic omission
   rules. Decoder must reject duplicate object keys if ambiguity is unsafe,
   trailing garbage, wrong version, wrong ID kind, invalid bounds, and unknown
   commands. It must ignore approved additive optional fields only under the
   documented compatibility rule.

   Validation:

   ```sh
   cargo test -p dezoomify-protocol codec
   cargo test -p dezoomify-protocol malformed
   ```

10. Generate the TypeScript declarations, schemas, capabilities, and vectors.

    Generate TypeScript type declarations and validators in
    `packages/protocol-ts/src/generated.ts` and every file below
    `packages/protocol-ts/schema/` from `crates/dezoomify-protocol/src/dto.rs`
    and its checked generator metadata. Generate capability declarations,
    schemas, a capability-key manifest, schema fingerprint, and artifact manifest
    in the same pass. Capability message examples/goldens are scenario payloads,
    never package-local test data. Generated files carry a do-not-edit marker and source
    fingerprint. No hand-maintained duplicate JSON schema or TypeScript wire
    interface is permitted.

    Put success vectors for every variant and failure vectors for malformed
    version/type/ID/range/duplicate/trailing cases under
    `testdata/scenarios/protocol-v1-<id>/**`. Each vector includes protocol version
    and parity/test IDs. Generate twice into separate temporary directories and
    require byte-identical trees before updating checked-in derivatives.

    Validation:

    ```sh
    cargo test -p dezoomify-protocol --test golden
    cargo run -p dezoomify-protocol --bin generate-protocol -- --check
    pnpm --filter @dezoomify/protocol-ts test
    git diff --check -- packages/protocol-ts testdata/scenarios
    ```

11. Add Rust/TypeScript golden and core-projection tests without reversing dependencies.

    Put conversion code in protocol test support that may depend on both crates,
    or defer production conversion to phase 06. Do not make core depend on
    protocol. Rust tests encode/decode every canonical vector. TypeScript tests
    import only generated declarations/schema, validate and round-trip the same
    vectors, verify capability artifacts, and compare canonical bytes and schema
    fingerprints with Rust. For representative catalogs and errors, assert
    stable IDs, preserved order, checked numeric conversion, and exact v1
    golden output.

    Validation:

    ```sh
    cargo test -p dezoomify-protocol --test golden
    pnpm --filter @dezoomify/protocol-ts test
    cargo xtask test core --purity
    cargo tree -p dezoomify-core --invert dezoomify-protocol
    ```

    The final command must show that `dezoomify-core` does not depend on
    `dezoomify-protocol`; interpret Cargo's normal "nothing to print" result as
    the expected direction and record it explicitly.

12. Implement the protocol commands and `test protocol` target.

    `cargo xtask protocol generate` writes the deterministic Rust-derived
    TypeScript/schema/capability artifacts when generation is explicitly
    requested. Its `--check` mode generates to a temporary tree and compares
    bytes without updating tracked output. `cargo xtask protocol check`
    validates generated markers/fingerprints, scenario manifest links,
    all Rust and TypeScript golden/negative vectors, crate portability, pnpm
    lock consistency, protocol documentation version, and checked-in golden
    vector bytes. Golden verification is read-only; updates require an explicit
    `cargo xtask protocol generate` run and review of its diff. The
    `cargo xtask test protocol` target runs all protocol tests and checks. A
    missing generated artifact/vector is a failure. No other protocol subcommand
    is registered.

    Validation:

    ```sh
    cargo xtask protocol generate
    cargo xtask protocol check
    cargo xtask protocol generate --check
    cargo xtask test protocol
    cargo test -p xtask protocol
    pnpm --filter @dezoomify/protocol-ts test
    ```

13. Run deterministic round-trip and compatibility workflows.

    For every message in Rust and TypeScript: construct or load, encode, decode,
    re-encode, and compare bytes. Exercise scan, untrusted website/deep-link
    handoff, capability negotiation, destination/output lifecycle, partial
    choice, and every recovery action. For optional additive fields, decode with
    a v1-compatible reader and retain documented semantics. Reject incompatible
    versions/unknown commands before emitting effects. Repeat native and
    WASM-target compilation.

    Validation:

    ```sh
    cargo test -p dezoomify-protocol --all-features
    cargo check -p dezoomify-protocol --target wasm32-unknown-unknown --no-default-features
    pnpm --filter @dezoomify/protocol-ts test
    cargo xtask protocol check
    cargo xtask protocol generate --check
    ```

14. Extend the aggregate deterministic suite and close the gate.

    Add `cargo xtask test protocol` to the phase-03 aggregate. Record the
    canonical DTO source hash, generated artifact manifest and schema
    fingerprints, golden scenario hash/list, protocol version, command results,
    and any approved compatibility exception.

    Validation:

    ```sh
    cargo xtask test protocol
    cargo xtask test
    cargo xtask protocol generate --check
    pnpm --filter @dezoomify/protocol-ts test
    cargo xtask test core --purity
    cargo fmt --all -- --check
    cargo clippy -p dezoomify-protocol --all-targets -- -D warnings
    git diff --exit-code -- migration-sources
    git diff --check
    ```

## Deterministic Workflow Tests Required in This Phase

| Test ID | Workflow | Required assertion |
|---|---|---|
| `P05-VARIANTS` | Round-trip every command/effect/response/event/error | Canonical bytes and semantics are stable |
| `P05-MALFORMED` | Decode malformed/ambiguous/out-of-range vectors | Typed rejection; no panic or partial action |
| `P05-VERSION` | Negotiate supported, additive, and incompatible versions | Only documented compatibility succeeds |
| `P05-CORRELATION` | Pair effects and responses | Wrong/duplicate/stale IDs are rejected deterministically |
| `P05-BUFFERS` | Allocate/consume/release buffer handles | Ownership is explicit; stale reuse fails safely |
| `P05-CATALOG` | Project representative core catalogs | Order, identity, dimensions, and optionality are preserved |
| `P05-SCAN` | Round-trip scan commands/candidates/results | Candidate identity, provenance, dedup, and terminal scan state are complete |
| `P05-HANDOFF` | Decode website query/deep-link vectors | Input is non-secret and untrusted; no credential or universal-signature field exists |
| `P05-OUTPUT` | Round-trip destination/write/encode/finalize/publication variants | Every lifecycle outcome is representable and correlated |
| `P05-RECOVERY` | Round-trip every recovery action and choice | Typed allowed choices and scope survive Rust/TypeScript encoding |
| `P05-CAPABILITIES` | Generate declarations/schema/key manifest and validate scenario examples | Runtime features and bounds have one Rust source and stable fingerprints |
| `P05-CANONICAL` | Generate declarations, schemas, capabilities, and vectors twice | Byte-identical generated trees/messages, no timestamps or hand-edited duplicate |
| `P05-RUST-TS` | Consume identical goldens from Rust and TypeScript | Acceptance, rejection, bytes, and schema fingerprints agree |
| `P05-PORTABLE` | Compile protocol for native and WASM target | No platform/runtime dependency leaks in |

## Explicit Stop Conditions

- A boundary interaction lacks producer, consumer, ordering, ownership, or
  failure semantics.
- A wire integer cannot round-trip losslessly through JavaScript.
- Bytes are copied/base64-encoded by default without an approved performance
  and size decision.
- Protocol exposes unstable Rust debug text, private enum layout, `usize`, or
  platform-specific values.
- Unknown/incompatible messages can trigger work before rejection.
- Golden generation is nondeterministic or mutates files during validation.
- Core would need to depend on protocol or a host/runtime crate.
- A parity-required error/request/header/selection field is omitted.
- Scan, handoff, destination, output, partial-result, publication, capability,
  or recovery behavior cannot be represented without an ad hoc host-only DTO.
- A generated TypeScript/schema/capability file has a second hand-maintained
  source or cannot be reproduced byte-for-byte from `dto.rs`.
- A website/deep-link handoff carries secrets, is trusted without validation and
  confirmation, or requires a universal signature.
- Native Messaging sender authentication is defined as a protocol signature or
  challenge/nonce property rather than browser enforcement of exact allowed
  extension IDs at the phase-12 transport/installation boundary.
- Source snapshots or unrelated paths change.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Protocol mirrors internals and freezes them | Use explicit DTO projection and stable semantic fields. |
| JavaScript loses large IDs/counts | Bound values or encode IDs as validated strings. |
| Message order/duplicates become ambiguous | Separate directional enums and strict correlation/state rules. |
| JSON carries huge binary payloads | Out-of-band buffer handles with explicit ownership. |
| Error messages become accidental API | Stable codes/details; human text is non-contractual. |
| Schema evolves without compatibility | Version rules, golden vectors, and read-only schema check. |
| Rust and TypeScript drift | Generate declarations and schemas from `dto.rs`; run shared goldens in both languages. |
| Handoff trust is overstated | Treat website/deep-link input as untrusted and non-secret; defer Native Messaging sender authentication to browser enforcement of allowed extension IDs, with challenge/nonce limited to session/replay binding. |

## Rollback Guidance

Limit rollback to `crates/dezoomify-protocol`, `packages/protocol-ts`, root pnpm
workspace manifests/lock, scenario-local protocol vectors,
`crates/xtask/src/protocol.rs`, its registration, Cargo workspace/lockfile
hunks, relevant `docs/protocol.md` and `docs/architecture.md` sections, and the
phase 05 gate row. Inspect concurrent edits before reversal. Never change core
behavior to make rollback easier and never remove legacy sources. If a protocol
version was consumed outside this branch, do not silently rewrite v1; stop and
create a versioned successor or compatibility decision. Do not reset/clean the
repository.

## Deliverables

- Pure, portable `crates/dezoomify-protocol`
- One authoritative `crates/dezoomify-protocol/src/dto.rs`
- Reviewed updates to flat `docs/protocol.md` and `docs/architecture.md`
- Root pinned pnpm workspace and generated `packages/protocol-ts`
- Deterministic TypeScript declarations, protocol/capability schemas,
  capability-key/artifact manifests, and fingerprints generated from Rust DTOs
- Complete positive and negative v1 goldens under `testdata/scenarios`
- Stable ID, bounds, ownership, compatibility, and error rules
- `cargo xtask protocol generate|check` and `cargo xtask test protocol`
- Aggregate deterministic protocol gate and phase-05 record

## Completion Checklist

- [ ] Every host/shared interaction appears in the boundary table.
- [ ] Scan, handoff, capability, destination, output, partial, publication, and recovery DTOs are complete.
- [ ] IDs and numeric values round-trip losslessly in JavaScript.
- [ ] Byte ownership and release semantics are explicit.
- [ ] Commands/effects/responses/events cannot be directionally confused.
- [ ] Error codes and redaction are stable and tested.
- [ ] Every variant has canonical positive and required negative vectors.
- [ ] Rust and TypeScript run the same vectors and produce the same canonical bytes.
- [ ] Generated TypeScript/schema/capability artifacts reproduce byte-for-byte from `dto.rs` and have no hand-maintained duplicate.
- [ ] Website/deep-link handoff is untrusted and non-secret; Native Messaging
  sender authentication is deferred to browser enforcement of allowed extension
  IDs, challenge/nonce is only session/replay binding, and no universal
  signature is required.
- [ ] Version compatibility and unknown-message behavior are tested.
- [ ] Core does not depend on protocol.
- [ ] Native and WASM target checks pass.
- [ ] Aggregate deterministic tests pass without network.
- [ ] No stop condition remains unresolved.
- [ ] Phase 05 is marked complete in the gate ledger.
