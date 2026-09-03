# Phase 06: Job Engine

## Objective

Implement `dezoomify-job`, a deterministic host-independent state machine that
drives the entire lifecycle from validated source or handoff input through core discovery, selection,
destination request, fixed/adaptive tile acquisition, decode and pure-processing
handoffs, writes, encoding/finalization, publication, partial-result decisions,
recovery, cleanup, cancellation, and terminal outcomes through protocol v1. The
job emits effects and consumes explicit host outcomes; hosts perform every I/O,
decode, processing, write, encode, publication, clock, and cancellation effect.

## Non-Goals

- Do not implement HTTP, proxy, cookies, CORS, filesystem, cache, image
  decode/encode, canvas, DOM, CLI, progress bars, or desktop/extension APIs.
- Do not add Tokio, futures executors, browser bindings, native networking, or
  image libraries to the job crate.
- Do not make retry timing depend on wall-clock access inside the job crate.
- Do not implement WASM exports; phase 07 adapts this crate.
- Do not change protocol v1 casually. A required contract change returns to the
  phase-05 compatibility process.
- Do not remove legacy schedulers or native download logic.

## Dependencies and Preconditions

- Phases 00-05 are complete and all aggregate deterministic gates pass.
- Protocol v1 schema and goldens are frozen for this phase.
- Core discovery/catalog/tile APIs are stable and pure.
- The parity matrix defines selection defaults, header precedence requirements,
  concurrency/retry/cancellation semantics, adaptive probing, progress, partial
  failures, and terminal results.
- Any behavior not shared across runtimes is assigned to a later host phase,
  not forced into the job crate.

## Exact Source and Destination Paths

| Input/concern | Exact source | Exact destination |
|---|---|---|
| Legacy web flow | `migration-sources/dezoomify-web/zoommanager.js` | Behavioral evidence only; shared semantics in job |
| Legacy native orchestration | `migration-sources/dezoomify-rs/src/lib.rs`, `download_state.rs`, `network.rs`, `native.rs`, `registry.rs` | Behavioral evidence only; no direct copy of host I/O |
| Core | `crates/dezoomify-core/**` | Dependency of job; unchanged except proven bug fix |
| Protocol | `crates/dezoomify-protocol/**`, generated artifacts in `packages/protocol-ts/**` | Dependency of job; no breaking v1 changes |
| Job crate | New | `crates/dezoomify-job/Cargo.toml`, `src/lib.rs` |
| State machine | New | `crates/dezoomify-job/src/{job,state,transition}.rs` |
| Core projection | New | `crates/dezoomify-job/src/{discovery,catalog}.rs` |
| Scheduling/lifecycle | New | `crates/dezoomify-job/src/{scheduler,adaptive,retry,progress,output,cleanup}.rs` |
| Limits/config | New | `crates/dezoomify-job/src/{config,limits}.rs` |
| Deterministic tests | Shared scenarios/transcripts | `crates/dezoomify-job/tests/**`; canonical expectations remain scenario-local `testdata/scenarios/<id>/expected/job.json` |
| Scripted host | New test-only code | `crates/dezoomify-job/tests/support/mod.rs` |
| Architecture docs | Existing phase-02/05 docs | Existing flat `docs/job-engine.md` and relevant `docs/architecture.md` section |
| Xtask | Phase-03 runner | `crates/xtask/src/job.rs`, registration in `crates/xtask/src/main.rs` |
| Workspace | Existing | Root `Cargo.toml`, `Cargo.lock` |

## Required State Model

Use final reviewed names, but represent these distinct states:

| State | Permitted work |
|---|---|
| `Created` | Validate version/config/start command; emit no fetch before valid start |
| `Discovering` | Drive core resource needs and accept correlated fetch responses |
| `AwaitingImageSelection` | Emit ordered catalog and accept one valid image selection |
| `AwaitingLevelSelection` | Emit ordered levels and accept one valid level selection |
| `AwaitingDestination` | Request and validate a host-owned destination before output work |
| `Planning` | Enumerate fixed tiles or adaptive probes and output/processing work under limits |
| `AcquiringTiles` | Maintain bounded in-flight tile fetches and consume correlated outcomes |
| `ProcessingTiles` | Track host decode, processing, and write effects/outcomes without executing them |
| `AwaitingPartialDecision` | Expose exact missing/failed work and wait for fail/keep/retry choice |
| `AwaitingRecovery` | Expose protocol-permitted recovery choices and consume one correlated decision |
| `Encoding` | Drive host encoder/write completion and consume exact outcomes |
| `Finalizing` | Request encoder finalization and verify output metadata/digest/size outcomes |
| `Publishing` | Ask the host to publish/commit the finalized output destination |
| `CleaningUp` | Release buffers, cancel residual effects, abort unpublished output, and settle ownership |
| `Cancelling` | Stop new work and transition through deterministic cleanup |
| `Completed` | Emit exactly one terminal success; reject later work safely |
| `PartiallyCompleted` | Emit exactly one marked-partial terminal result after approved policy and publication |
| `Failed` | Emit exactly one terminal failure; reject later work safely |
| `Cancelled` | Emit exactly one terminal cancellation; reject later work safely |

If states are combined internally, tests must still prove all external
distinctions and permitted transitions.

## Command Status

### Available from Completed Phases

```sh
cargo xtask sources verify
cargo xtask fixtures verify
cargo xtask parity validate
cargo xtask test core --purity
cargo xtask protocol check
cargo xtask test
```

Legacy evidence can still be run with source-local commands documented in
phases 01-03. No job-specific command exists at phase start.

### Added by This Phase

```sh
cargo xtask test job
cargo xtask test job --transcripts
```

The `job` target and its focused flag become valid only after step 17; they must
remain absent before then.

## Numbered Atomic Steps

1. Derive a complete job behavior table from parity and protocol documents.

   For every incoming command and host response, list valid source states,
   validation, state transition, emitted effects/events, ID allocation, resource
   ownership, progress effect, and invalid-state error. Include duplicate,
   stale, out-of-order, and post-terminal inputs. Put the table in
   existing `docs/job-engine.md` before implementation. Include every normal,
   partial, recovery, cancellation, cleanup, and terminal transition through
   destination publication; a tile-complete state is not job completion.

   Validation:

   ```sh
   cargo xtask parity validate
   cargo xtask protocol check
   git diff --check -- docs/job-engine.md docs/architecture.md
   ```

2. Create `dezoomify-job` with inward-only dependencies.

   Depend on `dezoomify-core` and `dezoomify-protocol`, plus only reviewed pure
   data-structure/error libraries. Do not add runtime features. Register the
   crate in the workspace and compile native and WASM targets immediately.

   Validation:

   ```sh
   cargo check -p dezoomify-job --no-default-features
   cargo check -p dezoomify-job --target wasm32-unknown-unknown --no-default-features
   cargo tree -p dezoomify-job --edges normal --depth 1
   cargo xtask test core --purity
   ```

3. Implement validated configuration and resource limits.

   Include maximum concurrent fetches/decodes, discovery steps/resources/bytes,
   catalog entries, levels, tiles, adaptive probes, retries, queued events,
   retained byte buffers, and output dimensions/pixels where known. Defaults
   must be explicit, target-safe, and represented in tests. Reject zero/overflow
   or unreasonable combinations before starting. Do not infer limits from host
   memory at runtime.

   Validation:

   ```sh
   cargo test -p dezoomify-job config
   cargo test -p dezoomify-job limits
   ```

4. Implement deterministic ID allocation and event/effect queues.

   Allocate monotonically within a job using checked arithmetic and protocol-
   safe ranges. Preserve FIFO order for externally visible effects/events unless
   a documented priority rule applies. Define drain semantics: draining returns
   owned messages once; peeking does not acknowledge work; overflow becomes a
   typed terminal resource-limit error.

   Validation:

   ```sh
   cargo test -p dezoomify-job ids
   cargo test -p dezoomify-job queue
   ```

5. Implement `Created -> Discovering` and core operation ownership.

   Validate protocol/config/input URL, create exactly one core discovery
   operation, emit state change, then translate core priority needs into fetch
   effects. Map each protocol request ID to the corresponding core request ID
   without exposing private IDs. Preserve URI/header/purpose and deterministic
   need order.

   Validation:

   ```sh
   cargo test -p dezoomify-job start
   cargo test -p dezoomify-job discovery_requests
   cargo xtask test core --purity
   ```

6. Implement discovery response handling.

   Accept bytes/failure only for outstanding correlated requests. Enforce byte
   limits before passing data to core. Handle duplicate/stale/wrong-job/wrong-
   purpose responses deterministically. Continue requesting until catalog or
   typed failure. Release consumed buffers exactly once. Never fetch directly.

   Validation:

   ```sh
   cargo test -p dezoomify-job discovery_responses
   cargo test -p dezoomify-job invalid_correlation
   cargo test -p dezoomify-job buffer_lifecycle
   ```

7. Implement catalog projection and selection states.

   Convert core catalogs to protocol DTOs with stable deterministic IDs and
   preserved order. Apply only approved automatic defaults; otherwise emit one
   selection-required event and wait. Reject unavailable/deferred/stale image or
   level IDs without corrupting state. Resolve deferred entries by returning to
   discovery through an explicit transition.

   Validation:

   ```sh
   cargo test -p dezoomify-job catalog
   cargo test -p dezoomify-job selection
   cargo xtask protocol check
   ```

8. Implement destination request and output-plan validation.

   After selection and checked output dimensions are known, emit a correlated
   destination request containing format/options, estimated size where known,
   overwrite intent, partial policy, and required host capabilities. Consume a
   host grant, rejection, or recovery result without opening files or inspecting
   storage. Do not start output writes before a valid grant. Track the opaque
   destination/output IDs needed for abort, finalize, and publication.

   Validation:

   ```sh
   cargo test -p dezoomify-job destination
   cargo test -p dezoomify-job destination_recovery
   cargo test -p dezoomify-job output_plan
   ```

9. Implement fixed-grid scheduling.

   Enumerate selected level tiles in approved order. Skip absent grid entries
   according to source semantics. Maintain pending, in-flight-fetch,
   in-flight-decode, accepted, skipped, and failed sets without duplicate tile
   completion. Enforce separate fetch/decode concurrency. Emit fetch effects
   with format-generated headers; user/header precedence is applied by hosts
   later but must retain enough provenance in the request representation.

   Validation:

   ```sh
   cargo test -p dezoomify-job fixed_grid
   cargo test -p dezoomify-job concurrency
   cargo test -p dezoomify-job tile_dedup
   ```

10. Implement acquisition, decode, processing, and write handoffs.

   After tile bytes arrive, emit a decode effect carrying tile geometry,
   request/buffer IDs, and expected constraints. Consume host decode success or
   typed rejection, then emit any required pure-processing and output-write
   effects. Validate decoded/processed dimensions, pixel format, placement,
   crop/overlap, and write result against bounds. Release encoded and decoded
   buffers under explicit ownership rules. The job tracks logical
   acquisition/decode/process/write completion but performs none of those
   operations and allocates no image canvas or output file.

   Validation:

   ```sh
   cargo test -p dezoomify-job decode_handoff
   cargo test -p dezoomify-job decode_validation
   cargo test -p dezoomify-job processing_handoff
   cargo test -p dezoomify-job write_outcomes
   cargo tree -p dezoomify-job --edges normal --depth 1
   ```

11. Implement adaptive probe scheduling.

    Translate core adaptive needs to fetch/decode observations and feed explicit
    host results back to the adaptive program. Preserve deterministic priority,
    placeholder/missing classification fields, bounds updates, maximum probes,
    duplicate handling, and termination. Do not inspect pixels in the job;
    the host reports the protocol-defined observation.

    Validation:

    ```sh
    cargo test -p dezoomify-job adaptive
    cargo test -p dezoomify-job adaptive_limits
    cargo test -p dezoomify-job adaptive_out_of_order
    ```

12. Implement retry decisions without a clock.

    Store attempt counts and deterministic retry eligibility. On retryable
    failure, emit an event/effect stating attempt and requested delay/policy;
    the host decides when to submit an explicit retry-ready command. No sleeps,
    timers, jitter, or random source belong in the job. Exhaustion produces
    the approved fail/skip/partial outcome with stable error code.

    Validation:

    ```sh
    cargo test -p dezoomify-job retry
    cargo test -p dezoomify-job retry_exhaustion
    cargo test -p dezoomify-job no_implicit_time
    ```

13. Implement absolute progress and partial-result decisions.

    Emit progress snapshots at deterministic state transitions, not based on
    elapsed time. Define totals when initially unknown, changes during adaptive
    discovery, and counts for acquired/decoded/processed/written/skipped/failed/
    in-flight work plus encoding, finalization, and publication phases. When
    tile/decode/process/write failures permit a partial result, emit an exact
    missing-work summary and wait for the configured fail/keep/retry policy or a
    correlated host/user decision. A partial choice cannot excuse destination,
    encoder, finalize, publication, metadata, or security failures.

    Validation:

    ```sh
    cargo test -p dezoomify-job progress
    cargo test -p dezoomify-job partial_decision
    cargo test -p dezoomify-job partial_restrictions
    ```

14. Implement encoding, finalization, publication, and success.

    Once all required or approved-partial writes settle, emit host effects to
    complete encoding, finalize the output, and publish/commit the destination.
    Consume each correlated success/failure outcome, validate output metadata,
    digest/size where supplied, and partial markers, and invoke typed recovery
    only where protocol policy permits. Success or partial success is terminal
    only after publication succeeds and all buffer/effect/destination ownership
    settles. A finalize/publication failure must trigger abort/cleanup, never a
    false completed event. Emit exactly one terminal result.

    Validation:

    ```sh
    cargo test -p dezoomify-job encoding
    cargo test -p dezoomify-job finalize
    cargo test -p dezoomify-job publication
    cargo test -p dezoomify-job terminal_once
    ```

15. Implement cancellation, failure cleanup, and post-terminal safety.

    Cancellation stops all new effects, requests cancellation of outstanding
    host work, accepts/rejects late outcomes under documented rules, releases
    retained buffers, and aborts/unpublishes incomplete destinations where the
    host supports it. Discovery, destination, acquisition, decode, processing,
    write, encode, finalize, publication, partial-decision, and recovery failures
    all enter deterministic cleanup before terminal failure/cancellation. Track
    cleanup acknowledgements and preserve the primary error plus cleanup
    diagnostics. Repeated cancellation is idempotent; post-terminal commands
    produce stable rejection and no work.

    Validation:

    ```sh
    cargo test -p dezoomify-job cancellation
    cargo test -p dezoomify-job cleanup
    cargo test -p dezoomify-job late_responses
    cargo test -p dezoomify-job post_terminal
    ```

16. Build the scripted deterministic host and workflow corpus.

    The test host consumes effects and supplies outcomes from shared scenarios
    without HTTP, filesystem during job execution, image libraries, or real
    time. Test code may load scenario files before starting. Parameterize
    delivery order, failure, retry-ready, selection, destination grant, decode,
    processing, write, encode, finalize, publication, partial/recovery choice,
    cleanup, and cancellation. Store complete canonical transcripts only at
    `testdata/scenarios/<id>/expected/job.json`.

    Validation:

    ```sh
    cargo test -p dezoomify-job --test workflows
    cargo test -p dezoomify-job --test adversarial
    cargo xtask fixtures verify
    cargo xtask protocol check
    ```

17. Implement the `cargo xtask test job` target.

    Bare `cargo xtask test job` runs architecture/dependency checks, all crate
    tests, native/WASM compilation, protocol/core prerequisite checks, and
    transcript verification. `cargo xtask test job --transcripts` runs the
    focused scenario-local transcript verification without updating bytes by
    default. Missing workflows or skipped target compilation are failures.
    Register no later test target.

    Validation:

    ```sh
    cargo xtask test job
    cargo xtask test job --transcripts
    cargo test -p xtask job
    ```

18. Run schedule permutation and determinism tests.

    For representative multi-request workflows, deliver independent host
    responses in every feasible order up to a documented bounded case size.
    Final catalog/result and progress invariants must match; effect order may
    differ only where the contract explicitly allows it. Repeat identical input
    scripts twice and compare transcript bytes.

    Validation:

    ```sh
    cargo test -p dezoomify-job --test permutations
    cargo xtask test job --transcripts
    ```

19. Extend aggregate validation and close the gate.

    Add job-target validation to `cargo xtask test`. Record dependency
    tree, native/WASM results, transcript hashes, workflow IDs, limits/defaults,
    and any approved parity exceptions.

    Validation:

    ```sh
    cargo xtask sources verify
    cargo xtask fixtures verify
    cargo xtask parity validate
    cargo xtask test core --purity
    cargo xtask protocol check
    cargo xtask test job
    cargo xtask test
    cargo fmt --all -- --check
    cargo clippy -p dezoomify-job --all-targets -- -D warnings
    git diff --exit-code -- migration-sources
    git diff --check
    ```

## Deterministic Workflow Tests Required in This Phase

| Test ID | Workflow | Required assertion |
|---|---|---|
| `P06-DISCOVER-SUCCESS` | Start, satisfy ordered core needs, obtain catalog | Exact effects/events/catalog IDs and no host I/O |
| `P06-SELECTION` | Multi-image/multi-level catalog | Wait/default/reject semantics match approved parity |
| `P06-DESTINATION` | Request, reject, recover, and grant output destination | No writes before grant; opaque destination ownership remains host-side |
| `P06-FIXED-DOWNLOAD` | Acquire/decode/process/write a complete grid | Bounded concurrency, no duplicates, exact per-phase progress |
| `P06-ADAPTIVE` | Script success/missing/placeholder probes | Deterministic bounds, probe limit, and completion |
| `P06-PARTIAL` | Fail tiles and choose fail/keep/retry | Exact missing work and policy; partial cannot mask output/security failure |
| `P06-OUTPUT` | Complete writes, encoding, finalize, and publication | Terminal success occurs only after publication and settled ownership |
| `P06-CLEANUP` | Fail/cancel in every lifecycle phase | Residual effects, buffers, encoder, and destination abort settle deterministically |
| `P06-OUT-OF-ORDER` | Permute independent responses | State remains valid; result invariant is preserved |
| `P06-RETRY` | Retryable failures and explicit retry-ready inputs | Attempt limits and terminal policy match; no clock access |
| `P06-CANCEL` | Cancel in each nonterminal state with late responses | No new work, buffers settle, one cancellation event |
| `P06-INVALID` | Wrong job/request/state, duplicate/stale inputs | Stable rejection and no state corruption |
| `P06-LIMITS` | Hit every configured limit and ID boundary | Typed bounded failure; no panic/overflow |
| `P06-TRANSCRIPT` | Replay each workflow twice | Byte-identical canonical transcript |
| `P06-PORTABLE` | Compile job for native and WASM | No runtime/platform dependency |

## Explicit Stop Conditions

- A state transition is not covered by the behavior table and deterministic
  test.
- Protocol v1 cannot represent a required effect/response without a breaking
  change; return to phase 05 and version deliberately.
- Job implementation needs network, filesystem, image codec, async runtime,
  clock, randomness, environment, DOM, or UI access.
- IDs, counters, dimensions, queue sizes, or retries can overflow or grow
  without a configured bound.
- Duplicate/out-of-order/late input can panic, double-complete a tile, leak a
  buffer, or emit multiple terminal events.
- Schedule permutations produce unexplained semantic differences.
- A canonical source behavior differs without approved parity decision.
- Any source snapshot or unrelated work is modified.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Async assumptions leak into shared logic | Synchronous transition API with explicit effects/responses. |
| Out-of-order hosts corrupt state | Correlation maps, state validation, permutation/adversarial tests. |
| Retry tests become timing-dependent | Explicit retry-ready input; no clock/sleep/random jitter in job. |
| Progress differs across runtimes | Absolute snapshots emitted on deterministic transitions. |
| Cancellation leaks work/buffers | Ownership ledger, late-response rules, cancellation at every state. |
| Job becomes an image runtime | Decode, processing, write, encode, and publication are host effects. |
| Tile completion is mistaken for job completion | Require encode, finalize, publish, and cleanup outcomes before a terminal result. |

## Rollback Guidance

Own only `crates/dezoomify-job`, scenario-local job expected transcripts,
`crates/xtask/src/job.rs` and registration, relevant `docs/job-engine.md` and
`docs/architecture.md` sections, workspace/lockfile hunks,
aggregate-runner hunks, and phase-06 gate row. Reverse only current-phase hunks
after checking for concurrent edits. If one transition feature fails, remove
only that transition and its unapproved transcript; retain the crate skeleton
and passing workflows. Do not alter protocol v1 goldens to conceal a job
bug, change core semantics without returning to phase 04, modify sources, or
use reset/clean.

## Deliverables

- Pure, portable `crates/dezoomify-job`
- Complete state/transition/ownership documentation
- Validated limits and deterministic ID/event/effect queues
- Discovery, selection, destination, fixed/adaptive acquisition, decode/
  processing/write handoff, retry, progress, partial decisions, encoding,
  finalize, publication, cleanup, cancellation, and terminal handling
- Scripted host, adversarial/permutation workflows, canonical transcripts
- `cargo xtask test job` with focused `--transcripts` validation
- Aggregate deterministic job gate and phase-06 record

## Completion Checklist

- [ ] Every valid and invalid transition has deterministic coverage.
- [ ] Job depends inward only on core/protocol and pure support libraries.
- [ ] No I/O, async runtime, image codec, clock, randomness, or UI capability exists in job.
- [ ] Fixed and adaptive work obey configured bounds and concurrency.
- [ ] Buffer ownership settles exactly once on success, failure, and cancellation.
- [ ] Duplicate, stale, wrong-state, late, and out-of-order inputs are safe.
- [ ] Progress and terminal events are deterministic and terminal emits once.
- [ ] Destination, decode, processing, write, encode, finalize, publication, partial, and cleanup outcomes are fully covered.
- [ ] Native/WASM compilation and canonical transcript checks pass.
- [ ] Aggregate deterministic tests pass with no public network.
- [ ] Source snapshots remain unchanged.
- [ ] No stop condition remains unresolved.
- [ ] Phase 06 is marked complete in the gate ledger.
