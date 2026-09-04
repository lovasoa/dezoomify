# Phase 07: WASM Adapter

## Objective

Adapt `dezoomify-core` and `dezoomify-job` through a narrow deterministic
WebAssembly boundary and export bounded pure pixel-processing operations for a
future host to call. Define JavaScript ownership, byte transfer, error
conversion, reentrancy, lifecycle, and package artifacts while keeping browser
workers, fetch, DOM, canvas, image decoding, storage, downloads, and UI outside
WASM.

## Non-Goals

- Do not implement the browser runtime or website; phases 08-09 own them.
- Do not call `fetch`, access DOM/canvas, decode images, create or manage
  workers, inspect browser storage, write destinations, encode/publish output,
  or download files from Rust/WASM.
- Do not expose internal core/job Rust types directly to JavaScript.
- Do not add WASM dependencies or conditional browser code to
  `dezoomify-core`.
- Do not redesign protocol v1 or job behavior to match ad hoc JS objects.
- Do not commit generated package output unless release policy explicitly
  identifies which artifacts are source-controlled.
- Do not remove the legacy web app or extension.

## Dependencies and Preconditions

- Phases 00-06 are complete.
- Core, protocol, and job compile for `wasm32-unknown-unknown` and all
  deterministic transcripts pass.
- Protocol byte-buffer ownership and canonical message encoding are frozen.
- Browser support targets, module format, bundler expectations, and minimum
  WASM tooling versions are explicitly approved.
- `wasm32-unknown-unknown` is installed. `wasm-bindgen-cli`/`wasm-pack` versions
  are pinned before generated output is compared.
- Existing worktree changes are recorded and migration sources remain immutable.

## Exact Source and Destination Paths

| Input/concern | Exact source | Exact destination |
|---|---|---|
| Job API | `crates/dezoomify-job/src/**` | Wrapped, not copied |
| Core API/recipes | `crates/dezoomify-core/src/**` | Adapted for discovery and pure processing inputs; not copied |
| Protocol v1 | `crates/dezoomify-protocol/src/**`, generated `packages/protocol-ts/**` | Wrapped/encoded, not duplicated |
| Core/job purity | `crates/dezoomify-core/**`, `crates/dezoomify-job/**`, `docs/architecture.md` | Remains unchanged and browser-free |
| WASM crate | New | `crates/dezoomify-wasm/Cargo.toml`, `src/lib.rs` |
| Exported session | New | `crates/dezoomify-wasm/src/session.rs` |
| JS conversion/error | New | `crates/dezoomify-wasm/src/{codec,error}.rs` |
| Byte arena | New | `crates/dezoomify-wasm/src/buffer.rs` |
| Pure processing exports | Core processing recipes and protocol buffer/geometry DTOs | `crates/dezoomify-wasm/src/processing.rs`; pure supplied-pixel transforms only |
| Adapter docs | Existing protocol/job/browser docs | Relevant sections in flat `docs/architecture.md` and `docs/browser-runtime.md` |
| Rust/WASM tests | Job transcripts and protocol vectors | `crates/dezoomify-wasm/tests/**` |
| Browser/Node JS harness | New test-only package in phase-05 pnpm workspace | `packages/wasm-harness/**`; contains code/config only, no canonical scenario data |
| Expected transcripts/pixels | Scenario-local `expected/job.json` and pixels | Scenario-local `expected/wasm.json` and `pixels/**` under `testdata/scenarios/<id>/` |
| Generated package staging | New build output | `target/wasm-package/**` by default; package root named `@dezoomify/wasm` with the stable `index.js` module entrypoint; not source-controlled |
| JS types | Generated protocol declarations | Import from `packages/protocol-ts`; any WASM wrapper types describe exports only and may not duplicate DTOs |
| Xtask | Existing | `crates/xtask/src/wasm.rs`, registration in `crates/xtask/src/main.rs` |
| Workspace/lock | Existing | Root `Cargo.toml`, `Cargo.lock` |

## Required JavaScript Surface

Keep the exported API minimal. Final names may change only before goldens
are approved, but semantics must include:

| Export | Required behavior |
|---|---|
| `protocolVersion()` | Return protocol major/minor in a lossless stable form without creating a job |
| `Session` constructor | Validate version/config; own exactly one job/session |
| `dispatch(controlBytesOrString)` | Decode one protocol command/response, run transitions, return status/error only |
| `allocateBuffer(length)` and writable view/accessor | Allocate bounded WASM memory for host-supplied bytes without base64 |
| `commitBuffer(handle, actualLength)` | Seal one buffer for a subsequent correlated command; reject stale/oversized handles |
| `drainMessages()` | Return canonical protocol control messages/effect descriptors exactly once |
| `takeBuffer(handle)` or documented output equivalent | Transfer adapter-produced bytes if protocol needs them, with explicit release |
| `freeBuffer(handle)` | Idempotence/error behavior defined; no silent reuse |
| `process(operation, inputHandles, outputHandle, geometry)` | Execute one bounded deterministic pure pixel operation on supplied buffers; no decode, canvas, worker, storage, or I/O |
| `dispose()` | Cancel/release session resources; repeated disposal safe; later dispatch rejected |

If a smaller API can satisfy all semantics, prefer it and update this table,
golden protocol vectors, and tests before approval.

## Command Status

### Available from Completed Phases

```sh
cargo xtask sources verify
cargo xtask fixtures verify
cargo xtask parity validate
cargo xtask test core --purity
cargo xtask protocol check
cargo xtask test job
cargo xtask test job --transcripts
cargo xtask test
cargo check -p dezoomify-job --target wasm32-unknown-unknown --no-default-features
pnpm --filter @dezoomify/protocol-ts test
```

These verify prerequisites only; no WASM adapter command exists at phase start.

### Direct Tool Commands Available Only After the Crate and Pinned Tools Exist

```sh
cargo build -p dezoomify-wasm --target wasm32-unknown-unknown --release
wasm-pack test --node crates/dezoomify-wasm
wasm-pack test --headless --chrome crates/dezoomify-wasm
```

Do not claim `wasm-pack` is available until its pinned installation/version is
verified. Do not use these commands against `migration-sources`.

### Added by This Phase

```sh
cargo xtask build wasm
cargo xtask test wasm
cargo xtask test wasm --transcripts
cargo xtask test wasm --browser chrome
```

These become valid only after step 14. `cargo xtask build wasm` writes under
`target/wasm-package` unless an explicit release destination is passed.

## Numbered Atomic Steps

1. Freeze target/tool/package decisions.

   In the WASM sections of existing flat `docs/architecture.md` and
   `docs/browser-runtime.md`, record target triple, Rust profile,
   `wasm-bindgen`/`wasm-pack` versions, JS module target, supported Node/browser
   versions for tests, generated-output policy, exception/panic policy, and
   whether a handwritten package wrapper is needed. Record exact version
   commands. Do not install unpinned latest tools in CI.

   Validation:

   ```sh
   rustup target list --installed
   rustc --version
   cargo --version
   wasm-pack --version
   git diff --check -- docs/architecture.md docs/browser-runtime.md
   ```

   If `wasm-pack` is not installed, record that fact and perform the approved
   pinned installation before continuing; absence is not a passing validation.

2. Define JS/WASM ownership and reentrancy rules before implementation.

   Document ownership for session, input control bytes, input binary buffers,
   output message arrays, output buffers, typed-array views invalidated by
   memory growth, and disposal. Define that no host callback occurs while a
   mutable Rust borrow is active. Prefer polling/draining over callbacks to
   prevent reentrant dispatch. Define behavior for exceptions at every export.

   Validation:

   ```sh
   git diff --check -- docs/architecture.md docs/browser-runtime.md
   cargo xtask protocol check
   ```

3. Create `dezoomify-wasm` as an adapter-only crate.

   Add `crate-type = ["cdylib", "rlib"]`. Depend inward on core/job/protocol and
   on pinned WASM binding/serialization support. Feature-gate test-only browser
   facilities. Do not add `web-sys` features for Window, Document, fetch,
   Canvas, storage, timers, or workers. Pure processing accepts explicit buffers
   and geometry; it does not authorize a browser capability. Add the crate to
   the workspace.

   Validation:

   ```sh
   cargo check -p dezoomify-wasm --target wasm32-unknown-unknown
   cargo tree -p dezoomify-wasm --edges normal --depth 1
   cargo xtask test core --purity
   cargo xtask test job
   ```

4. Implement protocol-version and session construction exports.

   Constructor accepts canonical configuration/control data, validates protocol
   major version and limits before allocating large structures, and returns a
   typed JS-visible error on failure. Panic hooks may improve diagnostics but
   must not replace error handling or leak secrets. One session owns one job
   and cannot be cloned accidentally.

   Validation:

   ```sh
   cargo test -p dezoomify-wasm --lib
   cargo build -p dezoomify-wasm --target wasm32-unknown-unknown
   ```

5. Implement a bounded generation-safe byte arena.

   Handles include enough generation information to reject stale reuse. Check
   requested/actual length and total retained bytes with overflow-safe
   arithmetic. Define uncommitted, committed, consumed, and freed states.
   Committing makes bytes immutable to Rust semantics; document that JS must not
   mutate the underlying view afterward. Job consumption or disposal frees
   ownership exactly once.

   Validation:

   ```sh
   cargo test -p dezoomify-wasm buffer
   cargo test -p dezoomify-wasm stale_handle
   cargo test -p dezoomify-wasm buffer_limits
   ```

6. Export bounded pure processing operations.

   Implement only protocol/core-approved deterministic operations over supplied
   decoded pixel buffers, such as crop/overlap placement, channel/pixel-format
   conversion, compositing, and other processing recipes proven by scenarios.
   Validate dimensions, strides, regions, formats, aliasing, and output capacity
   with checked arithmetic before mutation. Define in-place versus distinct
   buffer rules and failure atomicity. Compare output pixels/digests to
   scenario-local expectations. Do not decode compressed images, allocate a
   canvas, start a worker, fetch data, use storage, write a destination, or
   encode/publish a file.

   Validation:

   ```sh
   cargo test -p dezoomify-wasm processing
   cargo test -p dezoomify-wasm processing_bounds
   cargo test -p dezoomify-wasm processing_pixels
   ```

7. Implement canonical `dispatch` conversion.

   Accept one v1 control message, decode with `dezoomify-protocol`, resolve any
   referenced committed buffer, call the job synchronously, and convert
   errors to stable protocol/adapter codes. Reject malformed, unsupported,
   wrong-session, stale-buffer, and post-dispose input before partial effects.
   Do not accept loosely shaped JS objects that bypass canonical validation.

   Validation:

   ```sh
   cargo test -p dezoomify-wasm dispatch
   cargo test -p dezoomify-wasm malformed
   cargo xtask protocol check
   ```

8. Implement message draining and output ownership.

   Drain canonical encoded protocol messages in job FIFO order. A successful
   drain removes returned messages; a failed conversion leaves queue state
   defined and tested. Avoid exposing borrowed WASM slices after returning.
   If binary output exists, transfer by handles with explicit take/free
   behavior; never silently base64 encode it.

   Validation:

   ```sh
   cargo test -p dezoomify-wasm drain
   cargo test -p dezoomify-wasm output_ownership
   ```

9. Implement disposal and panic containment.

   `dispose` cancels job work, releases adapter buffers/messages, and marks
   the session unusable. Repeated disposal is safe. Finalizers, if a handwritten
   JS wrapper uses them, are a leak fallback only and not required for semantic
   cancellation. Convert recoverable errors; never rely on unwinding across the
   JS/WASM boundary.

   Validation:

   ```sh
   cargo test -p dezoomify-wasm dispose
   cargo test -p dezoomify-wasm post_dispose
   cargo test -p dezoomify-wasm terminal_cleanup
   ```

10. Add Rust-side adapter unit and conformance tests.

   Test every export's preconditions, all buffer state transitions, malformed
   canonical vectors, message ordering, job errors, processing outputs,
   cancellation, disposal, queue/buffer limits, and redaction. Use protocol and
   job test support with canonical scenario data where host JavaScript is
   unnecessary.

   Validation:

   ```sh
   cargo test -p dezoomify-wasm --lib
   cargo clippy -p dezoomify-wasm --all-targets -- -D warnings
   cargo fmt --all -- --check
   ```

11. Create the Node WASM harness.

    Build the adapter with pinned tooling into an isolated target directory.
    The Node test loads the generated module, checks exports/version, performs
    buffer write/commit/dispatch/drain, replays protocol negative vectors, runs
    complete job workflows with scripted host responses, invokes pure processing
    against scenario pixels, and disposes. It must not use public network or
    browser globals.

    Exact destination paths:

    - `packages/wasm-harness/package.json`
    - `packages/wasm-harness/src/node.spec.ts`
    - `packages/wasm-harness/src/support/**`

    Validation:

    ```sh
    wasm-pack test --node crates/dezoomify-wasm

    # repository root; pnpm workspace was created in phase 05
    pnpm install --frozen-lockfile
    pnpm --filter @dezoomify/wasm-harness test:node
    ```

12. Add a real headless-browser adapter harness.

    Load the generated WASM module in the same module mode planned for phase 08.
    Test initialization, memory growth/view invalidation, large bounded input,
    rapid dispatch/drain, cancellation, disposal, two isolated sessions, and
    pure-processing pixel parity, and absence of hidden worker/fetch/DOM/canvas/
    storage use. The test page provides scripted bytes loaded by harness setup
    from `testdata/scenarios`; the WASM module performs no acquisition.

    Exact destination additions:

    - `packages/wasm-harness/playwright.config.ts`
    - `packages/wasm-harness/src/browser.spec.ts`
    - `packages/wasm-harness/index.html`

    Validation:

    ```sh
    wasm-pack test --headless --chrome crates/dezoomify-wasm

    # repository root
    pnpm --filter @dezoomify/wasm-harness test:browser
    ```

13. Compare WASM and phase-06 native transcripts and processing pixels.

    Replay the same canonical command/host-response scripts used in phase 06.
    Capture only protocol-visible messages, not generated JS glue diagnostics.
    Store results only in each scenario's `expected/wasm.json`; they must equal
    approved `expected/job.json` unless a representation-only difference is
    explicitly allowed by protocol v1 and normalized by the existing canonical
    codec. Compare pure-processing output to scenario-local pixels/digests.

    Validation now, followed by focused xtask validation after step 14:

    ```sh
    cargo xtask test job --transcripts
    cargo xtask protocol check
    # After step 14 implements it:
    cargo xtask test wasm --transcripts
    ```

14. Implement the WASM build and test targets.

    Bare `cargo xtask test wasm` verifies target/tool versions, forbidden
    browser capabilities, adapter tests, release build, Node tests, headless-
    browser tests, prerequisite protocol and job-target checks, and native/WASM
    transcript and processing-pixel equality. `cargo xtask build wasm` produces
    deterministic release artifacts under `target/wasm-package`, records tool
    versions, and never writes checked-in source by default. The `--transcripts`
    flag on `cargo xtask test wasm` focuses the transcript and pixel comparison;
    its `--browser <name>` flag focuses one supported browser harness. Propagate
    missing-tool/test failures and reject unknown flags or future targets.

    Validation:

    ```sh
    cargo xtask build wasm
    cargo xtask test wasm
    cargo xtask test wasm --transcripts
    cargo xtask test wasm --browser chrome
    cargo test -p xtask wasm
    ```

15. Verify deterministic package output.

    Build/package twice from the same clean target subdirectories with identical
    pinned tools and environment. Compare the normalized artifact list and
    hashes. Exclude only documented unavoidable container metadata; do not
    normalize executable code or schema/type declarations. Ensure no absolute
    paths, timestamps, source credentials, or migration-source paths enter
    shipped artifacts.

    Validation:

    ```sh
    cargo xtask build wasm
    cargo xtask build wasm
    cargo xtask test wasm
    ```

16. Verify size and capability budgets.

    Record uncompressed and compressed WASM/package sizes and an approved budget
    in existing `docs/architecture.md`. Inspect imports to prove there are no
    hidden worker, fetch, filesystem, clock, random, DOM, canvas, storage,
    decoder, encoder, publication, or host-runtime capabilities. A size increase over budget requires cause and approval, not
    deletion of tests or optimizations that alter parity.

    Validation:

    ```sh
    cargo xtask test wasm
    cargo tree -p dezoomify-wasm --target wasm32-unknown-unknown
    git diff --check -- docs/architecture.md docs/browser-runtime.md
    ```

17. Extend aggregate deterministic validation and close the gate.

    Add `cargo xtask test wasm` to the aggregate command. Record tool versions,
    target, package hashes/sizes, Node/browser results, transcript equality,
    dependency/capability evidence, and all exceptions.

    Validation:

    ```sh
    cargo xtask sources verify
    cargo xtask fixtures verify
    cargo xtask parity validate
    cargo xtask test core --purity
    cargo xtask protocol check
    cargo xtask test job
    cargo xtask test wasm
    cargo xtask test
    git diff --exit-code -- migration-sources
    git diff --check
    git status --short
    ```

## Deterministic Workflow Tests Required in This Phase

| Test ID | Workflow | Required assertion |
|---|---|---|
| `P07-EXPORTS` | Load module in Node and browser | Only reviewed exports exist; protocol version matches v1 |
| `P07-BUFFER-LIFECYCLE` | Allocate/write/commit/consume/free and stale reuse | Bounds and generation safety; exactly-once ownership |
| `P07-DISPATCH` | Submit every command/response and malformed vector | Same canonical acceptance/rejection as native protocol |
| `P07-DRAIN` | Produce and drain multiple message batches | FIFO, once-only delivery, defined conversion-failure behavior |
| `P07-PROCESSING` | Run every approved operation over scenario pixels and boundary geometry | Exact pixels/digests, checked bounds, and failure atomicity; no host effects |
| `P07-WORKFLOWS` | Replay phase-06 success/failure/retry/cancel scripts | WASM messages equal phase-06 native transcripts byte-for-byte |
| `P07-REENTRANCY` | Attempt nested/rapid dispatch and drain | No mutable-borrow trap or state corruption |
| `P07-DISPOSE` | Dispose in each job state and repeat | Resources released; post-dispose rejected; no extra terminal work |
| `P07-MULTI-SESSION` | Interleave two sessions | IDs, buffers, queues, and cancellation remain isolated |
| `P07-CAPABILITIES` | Inspect crate dependencies and WASM imports | No worker/fetch/DOM/canvas/storage/fs/time/random/decode/encode/publication capability |
| `P07-PACKAGE` | Package twice with pinned tools | Normalized artifact paths and hashes are identical |

## Explicit Stop Conditions

- Protocol or job prerequisite transcript is not green.
- Required WASM target/tool version is absent or unpinned.
- Adapter needs browser I/O, DOM, image decode/encode, canvas, storage, timers,
  randomness, workers, publication, or async runtime internally.
- JavaScript can retain a typed-array view across memory growth without a clear
  invalidation rule.
- Buffer handles can be forged/reused, limits can overflow, or ownership can be
  consumed/freed twice.
- Reentrant calls can observe a mutable Rust borrow or corrupt job state.
- A processing operation depends on browser state, performs I/O/decode/encode,
  or cannot prove bounds, aliasing rules, and deterministic pixel output.
- Native and WASM protocol-visible transcripts differ without an approved v1
  representation rule.
- Packaging is nondeterministic, exceeds the approved size budget, or embeds
  paths/timestamps/secrets.
- Generated files overwrite source-controlled paths unexpectedly.
- Any migration source or unrelated work changes.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| WASM adapter becomes browser runtime | Narrow polling/processing API; ban worker, fetch, storage, canvas, and host capability imports. |
| Base64/copies make tiles unusable at scale | Bounded out-of-band byte arena and typed-array transfer rules. |
| Memory growth invalidates JS views | Short-lived views and explicit commit before further calls. |
| Reentrancy triggers borrow traps | No callbacks during transitions; host drains after dispatch returns. |
| Generated glue drifts by tool version | Pin tools and compare deterministic package artifacts. |
| WASM behavior diverges from native | Replay identical scripts and compare canonical transcripts. |
| Disposal relies on GC | Explicit `dispose`; finalizer only as non-semantic fallback. |

## Rollback Guidance

Own only `crates/dezoomify-wasm`, `packages/wasm-harness`, scenario-local WASM
expectation/pixel additions, `crates/xtask/src/wasm.rs` and registration,
workspace/lockfile hunks, relevant flat architecture/browser-runtime docs,
aggregate-runner hunks, and phase-07 gate row. Remove exact generated
`target/wasm-package` paths only after confirming they are phase-created build
artifacts. Reverse only current-phase source hunks after checking concurrent
edits. Do not alter protocol/core/job goldens to hide adapter differences,
modify migration sources, run broad clean/reset, or remove legacy code.

## Deliverables

- Narrow `crates/dezoomify-wasm` adapter crate
- Explicit JS/WASM ownership, reentrancy, disposal, and error documentation
- Generation-safe bounded byte arena and canonical dispatch/drain API
- Bounded deterministic pure-processing exports with scenario pixel parity
- Node and real-browser deterministic adapter harnesses
- Native/WASM transcript and processing-pixel equality evidence
- Deterministic package, capability, and size checks
- `cargo xtask build wasm` and `cargo xtask test wasm` with focused
  `--transcripts` and `--browser` validation
- Aggregate deterministic WASM gate and phase-07 record

## Completion Checklist

- [ ] Target, tools, module format, support matrix, and package policy are pinned.
- [ ] WASM exports only protocol/session/buffer lifecycle and approved pure-processing operations.
- [ ] No worker/browser/network/decode/encode/storage/canvas/publication/runtime capability exists inside adapter/core/job.
- [ ] Buffer bounds, generations, ownership, view invalidation, and disposal are tested.
- [ ] Malformed input and post-dispose behavior return stable errors without traps.
- [ ] Node and headless-browser deterministic workflows pass without public network.
- [ ] WASM transcripts equal phase-06 native transcripts and pure-processing pixels match scenario expectations.
- [ ] Two sessions remain isolated under interleaving.
- [ ] Repeated package output is deterministic and within approved size budget.
- [ ] Source snapshots remain unchanged.
- [ ] No stop condition remains unresolved.
- [ ] Phase 07 is marked complete in the gate ledger.
