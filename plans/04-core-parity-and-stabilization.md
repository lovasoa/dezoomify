# Phase 04: Core Parity and Stabilization

## Objective

Create the destination `dezoomify-core` crate from the reviewed Rust
destination snapshot, reconcile every change since upstream baseline `cb13f0b`,
and make pure discovery behavior match the approved parity matrix and shared
deterministic corpus. Stabilize a runtime-neutral API for registry selection,
resource-driven discovery, catalogs, levels, fixed grids, and adaptive tile
programs before any protocol wrapper or host runtime is built.

## Non-Goals

- Do not port native HTTP, filesystem, cache, image decoding/encoding, CLI,
  progress bars, or async orchestration into the core.
- Do not build protocol DTOs, the job engine, WASM exports, or browser APIs.
- Do not preserve an upstream API solely for hypothetical callers; preserve
  observable behavior and any public compatibility explicitly required by the
  parity inventory.
- Do not modify source snapshots to make comparisons pass.
- Do not use live sites as the parity gate.
- Do not remove legacy JavaScript/Rust implementations or fixtures.

## Dependencies and Preconditions

- Phases 00-03 are complete.
- `cargo xtask sources verify`, `cargo xtask fixtures verify`,
  `cargo xtask parity validate`, and `cargo xtask test` exist and pass.
- Phase 02 classified every behavioral change in `cb13f0b..23c4639`.
- No unresolved phase-04 parity row or unapproved Rust snapshot delta remains.
- The target Rust toolchain is installed, and the `wasm32-unknown-unknown`
  target is available before the WASM portability gate is run.
- Existing worktree changes are recorded and preserved.

## Exact Source and Destination Paths

| Concern | Exact source | Exact destination |
|---|---|---|
| Core manifest | `migration-sources/dezoomify-rs/dezoomify-core/Cargo.toml` at `23c4639` | `crates/dezoomify-core/Cargo.toml` |
| Core entry/API | `migration-sources/dezoomify-rs/dezoomify-core/src/lib.rs` and `src/core/**` | `crates/dezoomify-core/src/lib.rs`, `src/core/**` |
| Format implementations | `migration-sources/dezoomify-rs/dezoomify-core/src/{arcgis,bulk_text,custom_yaml,dzi,fsi,generic,google_arts_and_culture,hungaricana,iiif,iipimage,krpano,lizardtech,nypl,pnav,topviewer,vls,wmts,xlimage,zoomify}/**` | Same relative directories under `crates/dezoomify-core/src/` |
| Upstream comparison | Git paths `cb13f0b:dezoomify-core/**` | Review evidence only; never overwrite the worktree |
| Candidate snapshot comparison | Git range `cb13f0b..23c4639 -- dezoomify-core` | `docs/migration/core-delta-review.md` |
| Core source fixtures | `migration-sources/dezoomify-rs/dezoomify-core/testdata/**` | Curated into owning `testdata/scenarios/<id>/payloads/**`; no destination crate-local canonical fixture copy |
| Core tests | `migration-sources/dezoomify-rs/dezoomify-core/tests/dezoomer_coverage.rs`, `dependency_architecture.rs` | `crates/dezoomify-core/tests/parity.rs`, `purity.rs`, and focused test modules |
| Shared scenarios | `testdata/scenarios/**` | Consumed in place; core expectations are scenario-local `expected/core.json` files |
| Core test target | Phase-00 boundary document, source test, and shared scenarios | `crates/xtask/src/test.rs`, registration in `crates/xtask/src/main.rs` |
| Workspace | Phase-03 root workspace | Root `Cargo.toml`, `Cargo.lock` |
| API documentation | Source API plus approved matrix | Existing flat `docs/architecture.md` |

## Core Purity Contract

The normal dependency graph and library source of `crates/dezoomify-core` must
not perform or depend directly on HTTP/networking, filesystem, process,
environment, clocks, randomness, async runtimes, thread scheduling, image
decoding/encoding, DOM/UI, browser APIs, or native TLS. `log` is allowed as a
facade. Parsing, URL manipulation, deterministic crypto, serialization, and
pure collections are allowed. The core receives URI strings and resource bytes
and returns deterministic descriptions/needs/errors.

## Command Status

### Available at Phase Start

```sh
# workdir: migration-sources/dezoomify-rs
cargo test -p dezoomify-core --test dezoomer_coverage
cargo test -p dezoomify-core --test dependency_architecture
cargo clippy -p dezoomify-core --all-targets -- -D warnings
cargo fmt --all -- --check

# workdir: repository root
git diff --name-status cb13f0b..23c4639 -- dezoomify-core
git diff cb13f0b..23c4639 -- dezoomify-core
cargo xtask sources verify
cargo xtask fixtures verify
cargo xtask parity validate
```

The source-local Cargo commands operate on the immutable snapshot. The root
`cargo xtask` commands exist only because phase 03 must have completed.

### Added by This Phase

```sh
cargo xtask test core
cargo xtask test core --purity
cargo xtask test core --parity
```

Do not invoke the `core` target or its flags before its implementation step
below. It must remain absent from phase-03 help and parsing.

## Numbered Atomic Steps

1. Re-run all prerequisite evidence gates.

   Confirm source trees, fixture hashes, and parity links before copying code.
   Save starting status and note all unrelated changed paths. Stop on any source
   mismatch rather than copying from an untrusted tree.

   Validation:

   ```sh
   git status --short
   cargo xtask sources verify
   cargo xtask fixtures verify
   cargo xtask parity validate
   git diff --quiet 23c4639 HEAD:migration-sources/dezoomify-rs
   ```

2. Create `docs/migration/core-delta-review.md` from the phase-02 classification.

   List every commit in `cb13f0b..23c4639`, every changed core path, linked
   parity IDs, decision, tests, and adoption status. Mark documentation-only
   changes explicitly. No row may say merely "take latest." Verify that every
   destination snapshot module and core-model/discovery change is represented.

   Validation:

   ```sh
   git log --reverse --oneline cb13f0b..23c4639 -- dezoomify-core
   git diff --name-status cb13f0b..23c4639 -- dezoomify-core
   git diff --check -- docs/migration/core-delta-review.md
   cargo xtask parity validate
   ```

3. Materialize the destination crate from the locked `23c4639` prefix.

   Copy only `dezoomify-core/Cargo.toml`, `src/**`, and test harness code from
   `migration-sources/dezoomify-rs`. Curate any required fixture bytes into the
   phase-03 scenario corpus; do not create `crates/dezoomify-core/testdata`.
   Do not copy `target`, root app dependencies, native tests, CI files, or
   generated artifacts. Preserve source bytes initially so the first
   destination diff identifies only path changes. Add `crates/dezoomify-core`
   to root workspace members.

   Validation immediately after the copy:

   ```sh
   git diff --no-index migration-sources/dezoomify-rs/dezoomify-core/Cargo.toml crates/dezoomify-core/Cargo.toml
   git diff --no-index migration-sources/dezoomify-rs/dezoomify-core/src crates/dezoomify-core/src
   cargo metadata --no-deps --format-version 1
   cargo check -p dezoomify-core
   git diff --exit-code -- migration-sources
   ```

4. Establish destination naming and package metadata without behavioral edits.

   Keep package name `dezoomify-core`. Update repository/readme paths only as
   needed for the new workspace. Preserve license compatibility. Do not add
   adapter/runtime feature flags. Default features must not activate I/O.

   Validation:

   ```sh
   cargo metadata --no-deps --format-version 1
   cargo check -p dezoomify-core --no-default-features
   cargo fmt --all -- --check
   git diff --check -- crates/dezoomify-core/Cargo.toml
   ```

5. Port and strengthen the purity test.

   Put the test at `crates/dezoomify-core/tests/purity.rs`. Check direct normal
   dependencies with Cargo metadata/tree and scan crate source for forbidden
   imports/capabilities. The test itself may invoke Cargo, but no test-only
   helper may leak into normal dependencies. Include at least `reqwest`,
   `tokio`, `async-std`, `smol`, `image`, `png`, `zif-tiff`, `clap`, `indicatif`,
   `env_logger`, `wasm-bindgen`, `web-sys`, `js-sys`, `std::fs`,
   `std::net`, `std::process`, and environment reads in the reviewed policy.

   Validation:

   ```sh
   cargo test -p dezoomify-core --test purity
   cargo tree -p dezoomify-core --edges normal --depth 1
   ```

6. Implement the `cargo xtask test core` target and its focused flags.

   Bare `cargo xtask test core` runs all fast core suites. With `--purity`, it
   invokes the focused purity test, verifies the manifest's direct normal
   dependencies, and verifies dependency direction from workspace metadata.
   With `--parity`, it runs only shared-scenario parity and canonical core
   output comparisons; later steps fill out that suite before the phase gate.
   Stable output lists violations sorted by path/package. Return nonzero for a
   missing crate or skipped check. Do not parse `Cargo.lock` with ad hoc text
   matching where Cargo metadata can provide structured data. Register no other
   future test target.

   Validation:

   ```sh
   cargo xtask test core --purity
   cargo xtask test core --parity
   cargo test -p xtask core_purity
   cargo test -p xtask core_parity
   ```

7. Stabilize the resource-driven discovery API.

   Preserve the model in which the core starts from an input URI, emits
   declarative resource needs, accepts supplied bytes keyed by request ID, and
   returns an image catalog or typed error. Ensure host concerns are absent.
   Specify deterministic behavior for duplicate responses, unknown request IDs,
   exhausted routes, malformed bytes, redirects represented as supplied URI
   responses, request deduplication, cycle detection, maximum history/step
   limits, and finish-before-ready. Document public types and invariants in
   the core section of existing `docs/architecture.md`.

   Validation after focused edits:

   ```sh
   cargo test -p dezoomify-core core::discovery
   cargo test -p dezoomify-core --test parity discovery
   cargo xtask test core --purity
   ```

8. Stabilize catalog, image, level, and tile model invariants.

   Validate nonzero image/tile dimensions, checked arithmetic, stable entry and
   level ordering, ready versus deferred entries, format/name IDs, optional
   metadata, fixed grid bounds, row-major iteration, edge tile geometry,
   request headers, and errors instead of panic on untrusted metadata. Preserve
   all matrix-approved distinctions.

   Validation:

   ```sh
   cargo test -p dezoomify-core core::model
   cargo test -p dezoomify-core core::tile_plan
   cargo test -p dezoomify-core --test parity tile
   ```

9. Stabilize registry names, hints, and automatic precedence.

   Co-locate each format's `DezoomerSpec` with its implementation. Register only
   reviewed built-ins in one ordered registry. Match approved legacy URL/content
   detection and precedence. Keep generic/manual semantics explicit so generic
   matching does not steal automatic cases. Add a test that emits the full
   ordered `(id, display_name, hints)` list as a reviewed snapshot.

   Validation:

   ```sh
   cargo test -p dezoomify-core core::registry
   cargo test -p dezoomify-core --test parity automatic
   cargo xtask parity validate
   ```

10. Reconcile fixed-grid format implementations one format at a time.

    Process formats in registry order. For each format: identify matrix rows;
    run only its cases; make the smallest correction; run all core parity tests;
    update the delta review with accepted code/test evidence. Cover metadata
    mapping, relative/base URLs, query preservation, level order, dimensions,
    tile groups/indexing, tile extension/quality, overlap, headers, and malformed
    input. Never batch unrelated formats into one unreviewable change.

    Validation after each format:

    ```sh
    cargo test -p dezoomify-core --test parity <format-filter>
    cargo test -p dezoomify-core
    cargo xtask test core --purity
    cargo xtask parity validate
    ```

11. Reconcile multi-resource and site-adapter discovery one adapter at a time.

    Cover viewer pages, manifests, embedded URLs, iframes/follows, content
    extraction, request deduplication, cycles, and precedence. Site adapters
    remain pure parsers/routes and must not acquire resources themselves.
    Require a deterministic case for every page adapter; a live test alone is
    insufficient.

    Validation after each adapter:

    ```sh
    cargo test -p dezoomify-core --test parity <adapter-filter>
    cargo xtask fixtures verify
    cargo xtask test core --purity
    ```

12. Reconcile adaptive programs.

    Preserve deterministic probe descriptions and observations for generic and
    other adaptive sources. Test probe ordering, success/missing/placeholder
    observations, bounds growth, termination, maximum probes, sparse/partial
    grids, duplicate observations, and checked coordinate arithmetic. The core
    describes probes; it never performs them or decodes image bytes.

    Validation:

    ```sh
    cargo test -p dezoomify-core core::adaptive
    cargo test -p dezoomify-core --test parity adaptive
    cargo xtask test core --purity
    ```

13. Compare canonical source-oracle and destination outputs.

    Run every shared discovery case. Canonicalize only representation details
    approved in phase 03; do not sort semantically ordered requests, catalog
    entries, levels, or tiles. Store destination results under
    each scenario's `testdata/scenarios/<id>/expected/core.json`. Every mismatch
    must link to an approved parity decision or remain a blocker.

    Validation:

    ```sh
    cargo test -p dezoomify-core --test parity
    cargo xtask test core --parity
    cargo xtask parity validate
    ```

14. Add portability and robustness checks.

    Compile the core for native and `wasm32-unknown-unknown` with no default
    features. Add malformed/truncated/oversized metadata tests and checked limit
    tests. Fuzzing can be planned separately, but deterministic regression bytes
    for every discovered panic/overflow are required here.

    Validation:

    ```sh
    cargo check -p dezoomify-core --all-targets
    cargo check -p dezoomify-core --target wasm32-unknown-unknown --no-default-features
    cargo clippy -p dezoomify-core --all-targets -- -D warnings
    cargo test -p dezoomify-core
    cargo fmt --all -- --check
    ```

15. Extend the aggregate deterministic command and close the gate.

    Add source lock, fixture/parity validation, core purity, complete core tests,
    and core transcript comparison to `cargo xtask test`. Ensure a
    failing core test makes the aggregate command fail. Record matrix IDs and
    accepted delta rows in the phase gate.

    Validation:

    ```sh
    cargo xtask sources verify
    cargo xtask fixtures verify
    cargo xtask parity validate
    cargo xtask test core --purity
    cargo xtask test core --parity
    cargo xtask test core
    cargo xtask test
    git diff --exit-code -- migration-sources
    git diff --check
    ```

## Deterministic Workflow Tests Required in This Phase

| Test ID | Workflow | Required assertion |
|---|---|---|
| `P04-PURITY` | Inspect core source and direct normal dependencies | No forbidden host capability enters core |
| `P04-REGISTRY` | Enumerate registry | IDs, names, hints, and precedence match approved matrix |
| `P04-DISCOVERY` | Replay all resource-response cases | Ordered needs, dedup/cycles/limits, catalog, and errors match |
| `P04-FIXED-GRID` | Enumerate each fixed grid | Dimensions, levels, row-major tiles, edge geometry, URLs/headers match |
| `P04-ADAPTIVE` | Replay scripted probe observations | Probe order, bounds, limits, and termination match |
| `P04-MALFORMED` | Supply malformed/truncated/oversized bytes | Typed bounded errors; no panic/overflow/I/O |
| `P04-PORTABLE` | Build native and WASM target | Core compiles without host/runtime features |
| `P04-ORACLE` | Compare canonical core and approved source outputs | Every mismatch has an approved decision; otherwise fail |

## Explicit Stop Conditions

- A `cb13f0b..23c4639` behavior remains unclassified or unapproved.
- Destination output differs from canonical evidence without an approved parity
  decision and replacement test.
- Any proposed normal core dependency provides I/O, async runtime, image codec,
  browser, process, clock, environment, or UI capability.
- A format requires host acquisition inside the parser rather than a
  declarative resource need.
- Automatic registry precedence cannot be proven.
- Untrusted input can panic, overflow, loop without a bound, or allocate beyond
  an explicit checked limit.
- Native tests pass but the core cannot compile for `wasm32-unknown-unknown`.
- A source snapshot or unrelated destination path changes.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Candidate snapshot imports unfinished code | Require delta review and matrix evidence for every adopted change. |
| Core API embeds native assumptions | Compile for WASM and ban host capabilities/dependencies. |
| Automatic order regresses silently | Snapshot ordered registry and run precedence cases. |
| Parser fixes alter URL/tile semantics | Compare ordered canonical outputs per format. |
| Malformed metadata causes denial of service | Checked limits, arithmetic, deterministic malformed cases. |
| Purity test only catches known crate names | Combine dependency capability review, source scan, and architecture direction. |

## Rollback Guidance

Record a phase-start diff and treat `crates/dezoomify-core`, its workspace member
entry, the core-target hunks in `crates/xtask/src/test.rs`, scenario-local core
expected outputs, the relevant `docs/architecture.md` sections, and phase gate
row as owned paths. Reverse only current-phase hunks after checking
for concurrent edits. Do not restore from `cb13f0b` over the worktree, delete
`23c4639`, or alter `migration-sources`. If one format batch fails, back out only
that destination format's changes and associated expected-output updates while
retaining passing batches and audit evidence. Never use reset/clean.

## Deliverables

- `crates/dezoomify-core` with reviewed format implementations
- Complete `docs/migration/core-delta-review.md`
- Updated core sections in `docs/architecture.md`
- Strong destination purity test and `cargo xtask test core --purity`
- Shared-scenario parity test and scenario-local `expected/core.json` records
- Native/WASM portability evidence
- Aggregate deterministic gate including core parity
- Phase-04 gate record

## Completion Checklist

- [ ] Every adopted `cb13f0b..23c4639` change has matrix/test evidence.
- [ ] Registry order/names/hints match approved behavior.
- [ ] All fixed-grid, multi-resource, site-adapter, and adaptive cases pass.
- [ ] Core receives bytes and emits descriptions; it performs no I/O.
- [ ] Purity command and focused purity test pass.
- [ ] Malformed and bounded-resource tests pass without panic.
- [ ] Native and WASM target checks pass.
- [ ] Canonical output mismatches are zero or explicitly approved.
- [ ] Source snapshots remain unchanged and present.
- [ ] No stop condition remains unresolved.
- [ ] Phase 04 is marked complete in the gate ledger.
