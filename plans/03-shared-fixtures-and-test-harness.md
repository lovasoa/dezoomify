# Phase 03: Shared Fixtures and Test Harness

## Objective

Create a single, deterministic, public-network-free fixture corpus and test
harness that can replay legacy behavior and later drive Rust, WASM, browser,
native, desktop, and extension tests. Add the initial `cargo xtask` command
surface and make its own behavior reproducible and tested.

## Non-Goals

- Do not port production dezoomers or change expected parity outcomes.
- Do not replace all source tests immediately; run legacy tests as an oracle.
- Do not put fixture-server I/O or test helpers into `dezoomify-core`.
- Do not fetch/update live fixtures during ordinary test execution.
- Do not silently normalize fixture bytes, URLs, headers, status codes, query
  order, or redirects.
- Do not delete duplicate legacy fixtures; removal is not allowed before phase
  14.

## Dependencies and Preconditions

- Phases 00-02 are complete.
- The parity matrix, fixture inventory, live inventory, and parity decisions are
  reviewed.
- Every copied fixture has acceptable license/provenance and no secret or
  sensitive data.
- Rust/Node toolchain pins are available.
- The phase-start status is recorded; unrelated changes are left untouched.

## Exact Source and Destination Paths

| Material | Exact source | Exact destination |
|---|---|---|
| Remote HTTP fixtures | `migration-sources/dezoomify-web/tests/fixtures/remote/**` | Scenario-local `testdata/scenarios/<id>/payloads/**`, preserving exact bytes and served host/path in `routes.json` |
| Local web fixtures | `migration-sources/dezoomify-web/tests/fixtures/local/**` and other reviewed files under that source fixture tree | Scenario-local `testdata/scenarios/<id>/payloads/**` |
| Images/assembly fixtures | `migration-sources/dezoomify-web/tests/images/**` | `testdata/scenarios/<id>/payloads/**` and asserted samples under `testdata/scenarios/<id>/pixels/**` |
| Rust core/app fixtures | `migration-sources/dezoomify-rs/dezoomify-core/testdata/**`, root `tiles.yaml`, and `migration-sources/dezoomify-rs/testdata/**` | Scenario-local payloads under `testdata/scenarios/<id>/payloads/**` |
| Extension recognition cases | `migration-sources/dezoomify-extension/test/url-recognition.test.js` | `testdata/scenarios/<id>/scenario.json` with no duplicated canonical case tree |
| Web/Rust case definitions | `migration-sources/dezoomify-web/tests/dezoomers.spec.js` and `migration-sources/dezoomify-rs/dezoomify-core/tests/dezoomer_coverage.rs` | `testdata/scenarios/<id>/scenario.json`, `routes.json`, and `expected/<surface>.json` |
| Scenario schemas and manifest | Phase-02 inventory plus reviewed bytes/cases | `testdata/scenarios/schema/**`, `testdata/scenarios/manifest.json` |
| Fixture server | `migration-sources/dezoomify-web/tests/fixture-server.js` behavior | `crates/fixture-server/Cargo.toml`, `src/**`, and crate-owned tests/harnesses |
| Xtask runner | New | `.cargo/config.toml`, `crates/xtask/Cargo.toml`, `crates/xtask/src/main.rs`, `crates/xtask/src/{check,fixtures,parity,setup,sources,test}.rs` |
| Harness docs | Existing destination docs and source test docs | Existing `docs/testing.md` and `testdata/scenarios/README.md`; update in place |
| Workspace registration | New | Root `Cargo.toml`, `Cargo.lock` |

Do not copy generated `node_modules`, Playwright browser caches, Cargo targets,
or test output. Canonical route data, payloads, expected transcripts, and pixel
expectations live only below `testdata/scenarios`; crate/package tests may load
them but must not create a second canonical corpus. Record every data path in
`testdata/scenarios/manifest.json` before changing a case reference.

## Command Status

### Available Before This Phase's Edits

```sh
# workdir: migration-sources/dezoomify-web/tests
npm test

# workdir: migration-sources/dezoomify-rs
cargo test -p dezoomify-core --test dezoomer_coverage

# workdir: migration-sources/dezoomify-extension
npm test

# repository root
sha256sum <fixture-path>
git diff --check
```

### Commands Added by This Phase

These commands do not exist until the corresponding implementation step passes.

```sh
cargo xtask --help
cargo xtask setup
cargo xtask check
cargo xtask sources verify
cargo xtask fixtures verify
cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr
cargo xtask parity validate
cargo xtask parity report
cargo xtask test
```

At phase completion, help lists exactly the phase-03 top-level commands
`setup`, `check`, `sources`, `fixtures`, `parity`, and `test`. Future commands
and targets, including `build`, `dev`, `ci`, `release`, and every named test
target, remain parser errors until their owner phases implement them. Future
phases extend, but must not break, this command surface.

## Required Scenario Layout and Manifest Schema

Each `testdata/scenarios/<id>/` contains `scenario.json` and, as needed,
`routes.json`, `payloads/**`, `expected/<surface>.json`, and `pixels/**`.
`testdata/scenarios/manifest.json` version 1 contains sorted scenario and file
records with `id`, `path`, `sha256`, `size`, `content_type`, `source_snapshot`,
`source_path`, `served_urls`, `license_provenance`, and `sensitive`. Route
records contain stable `route_id`, method, exact host/path/query matching,
status, ordered headers, payload reference or deterministic generator, and
case-scoped state transitions. No current timestamp, generated port, or
machine-specific path is allowed.

## Numbered Atomic Steps

1. Create the root Cargo workspace, fixture-server crate, and `xtask` bootstrap.

   Root `Cargo.toml` initially registers exactly `crates/xtask` and
   `crates/fixture-server`; later phases add production crates. Create both
   manifests and minimal binaries before invoking Cargo. Add `.cargo/config.toml`
   alias `xtask = "run --package xtask --"`. Use package names `xtask` and
   `dezoomify-fixture-server`. Keep runner dependencies small and lock them.
   Establish the command parser and help contract without stubbing future
   commands. Register phase-03 commands only as their handlers are implemented;
   `cargo xtask --help` must list only implemented subcommands, and unsupported
   future commands and targets must fail as unknown rather than succeed as
   no-ops.

   Validation after this step:

   ```sh
   cargo xtask --help
   cargo metadata --no-deps --format-version 1
   cargo check -p xtask -p dezoomify-fixture-server
   cargo test -p xtask -p dezoomify-fixture-server
   cargo test -p xtask command_help
   cargo test -p xtask rejects_unavailable_commands
   git diff --check -- Cargo.toml Cargo.lock .cargo/config.toml crates/xtask crates/fixture-server
   ```

2. Implement `cargo xtask sources verify` from the phase-00 lock.

   Parse `docs/migration/source-lock.json`; resolve locked Git objects using
   `git`; compare each imported prefix tree; and emit stable source-name-sorted
   output. A missing Git binary, malformed lock, absent object, or mismatch must
   return nonzero. Do not fetch automatically.

   Validation after this step:

   ```sh
   cargo xtask sources verify
   cargo test -p xtask sources
   git diff --exit-code -- migration-sources
   ```

3. Define canonical scenario schemas before copying assertions.

   Add `testdata/scenarios/schema/manifest.schema.json`,
   `scenario.schema.json`, `routes.schema.json`, and `transcript.schema.json`.
   Require stable IDs from the parity matrix, exact input URL, operation mode,
   ordered expected requests, response payload IDs, expected catalog/image/
   level/tile fields, processing/output assertions, expected error, and source
   evidence. Make optionality explicit; absence must not mean "ignore" unless a
   field is named `ignore_*`. The transcript schema owns only the scenario
   envelope/order at this phase; it must not predeclare future protocol DTO
   variants. Phase 05 will bind protocol-message slots to its generated schema.

   Validation after this step:

   ```sh
   cargo test -p xtask scenario_schema
   git diff --check -- testdata/scenarios/schema
   ```

4. Curate scenario payloads byte-for-byte.

   Follow `fixture-inventory.csv`. Put each retained byte payload below its
   owning `testdata/scenarios/<id>/payloads/` directory. Preserve remote host and
   URL path casing in `routes.json`, including colons and encoded/private
   identifiers. Resolve collisions by distinct scenario/payload IDs, never by
   overwriting. Preserve the published source `tiles.yaml` bytes as a scenario
   payload and do not delete the source copy. Compute SHA-256 after each batch.

   Validation after each batch:

   ```sh
   sha256sum testdata/scenarios/<id>/payloads/<path>
   git diff --exit-code -- migration-sources
   git diff --check -- testdata/scenarios
   ```

5. Build `testdata/scenarios/manifest.json` from reviewed inventory.

   The checked-in manifest is authoritative. `cargo xtask fixtures verify`
   verifies scenario schemas, route/payload/expected/pixel references, byte
   hashes, sizes, duplicate IDs, incompatible duplicate served URLs, unlisted
   files, missing files, unsafe traversal, provenance, and sensitive flags. It
   must not rewrite by default. An explicit maintenance mode may generate a
   candidate file but cannot update hashes during tests.

   Validation after this step:

   ```sh
   cargo xtask fixtures verify
   cargo test -p xtask fixture_manifest
   ```

6. Implement the deterministic fixture server as a tool crate.

   `crates/fixture-server` loads only scenario `routes.json` and referenced
   payloads. Match the legacy server's observable semantics: static app/test
   files when required, host/path mapped responses, suffix/index lookup only
   where inventoried, deterministic origin/host substitution, GET and HEAD,
   content types, CORS/exposed headers, status/error bodies, synthetic JPEG/SVG
   tiles, proxy target handling, and Arts & Culture signing/encryption cases.
   Route vocabulary and dynamic response state are canonical data under
   `testdata/scenarios`, not Rust test constants. Bind loopback only. `--port 0`
   must use an OS-assigned port and write one parseable address only after
   listening. Public network fallback is forbidden. Unknown resources return a
   stable fixture-missing response.

   Validation after this step:

   ```sh
   cargo test -p dezoomify-fixture-server
   cargo xtask fixtures serve --help
   cargo xtask fixtures verify
   ```

7. Add fixture-server contract tests.

   Test traversal rejection, exact query forwarding, query order where
   significant, percent encoding, default ports, HEAD without body, MIME types,
   redirects if present, custom status/headers, template substitution, unknown
   host/path, signed Arts paths, encrypted bytes, generic probe success/404, and
   deterministic startup/shutdown. Use ephemeral ports and no sleep-based
   readiness.

   Validation after this step:

   ```sh
   cargo test -p dezoomify-fixture-server --test http_contract
   cargo test -p dezoomify-fixture-server --test security
   ```

8. Transcribe legacy cases into scenario directories without changing behavior.

   Create one directory per stable scenario ID. Preserve request order, selected
   dezoomer name, dimensions, tile positions/URLs/headers, final/selected level,
   error category, transcript, and assembly pixels. Store canonical route data,
   payloads, expected records, and pixels only in that directory. Record source
   file and line range. If web and Rust assertions differ, create separate
   `expected/<surface>.json` variants linked to an unresolved parity decision;
   do not blend them.

   Validation after each format batch:

   ```sh
   cargo xtask parity validate
   cargo xtask fixtures verify
   git diff --check -- testdata/scenarios docs/migration/parity-matrix.csv
   ```

9. Implement `cargo xtask parity validate` and `cargo xtask parity report`.

   Validation checks CSV schema, unique stable IDs, enums, evidence paths,
   fixture/case references, target phase, decision approvals, and deterministic
   coverage. Report output is sorted by area then ID and fails on blocked rows
   whose target phase is at or before the current gate. The report command does
   not mutate matrix status.

   Validation after this step:

   ```sh
   cargo xtask parity validate
   cargo xtask parity report
   cargo test -p xtask parity
   ```

10. Add a legacy-web harness mode using the shared server.

    Keep legacy source JavaScript read-only. Configure a destination-side test
    wrapper to serve the legacy app from its source prefix while resolving
    fixture/proxy requests through the new server. Do not edit legacy tests to
    hide differences. Compare selected dezoomer, metadata, ordered requests,
    tile coordinates/URLs, errors, and assembly pixels to canonical cases.

    Harness implementation belongs to the fixture-server crate; canonical input
    and expected data remains under `testdata/scenarios`. Exact harness paths:

    - `crates/fixture-server/tests/legacy-web/package.json`
    - `crates/fixture-server/tests/legacy-web/package-lock.json`
    - `crates/fixture-server/tests/legacy-web/playwright.config.js`
    - `crates/fixture-server/tests/legacy-web/parity.spec.js`

    Validation after this step:

    ```sh
    # workdir: crates/fixture-server/tests/legacy-web
    npm ci
    npm test

    # repository root
    cargo xtask fixtures verify
    git diff --exit-code -- migration-sources
    ```

11. Add canonical transcript support.

    A transcript contains ordered input commands, host responses, emitted
    requests/events, and terminal result. Canonical serialization uses UTF-8,
    LF, sorted object keys, stable enum tags, decimal integers, and no wall-clock
    fields. Keep source-oracle action records runtime-neutral; do not create a
    hand-maintained protocol schema. Store each initial source-oracle transcript in its scenario at
    `testdata/scenarios/<id>/expected/legacy-web.json`. Future Rust/WASM/host
    transcripts are sibling expected files in the same scenario and are
    compared to the oracle or approved decision-specific successors.

    Validation after this step:

    ```sh
    cargo test -p xtask transcripts
    cargo xtask parity validate
    git diff --check -- testdata/scenarios
    ```

12. Implement `cargo xtask setup`, `cargo xtask check`, and `cargo xtask test`.

    `cargo xtask setup` verifies the pinned Rust/Node tools and idempotently
    prepares only the dependencies required by the phase-03 workspace and
    legacy-web harness. It must not install or report readiness for later
    product toolchains. `cargo xtask check` runs formatting/lint checks plus
    read-only source-lock, fixture, and parity validation for artifacts available
    in this phase. Bare `cargo xtask test` runs all fast deterministic suites
    available in this phase: `cargo xtask check`, fixture-server tests, xtask
    tests, and the destination legacy harness. It sets
    deterministic environment values, rejects opt-in live flags, propagates the
    first nonzero result, and prints a stable summary. It must not run source
    live tests or workspace tests known to access the network. Named test
    targets remain unavailable until their owner phases.

    Validation after this step:

    ```sh
    cargo xtask setup
    cargo xtask check
    cargo xtask test
    cargo test -p xtask test_command
    cargo test -p xtask rejects_unavailable_commands
    git diff --exit-code -- migration-sources
    git status --short
    ```

13. Prove public-network isolation.

    Run the deterministic suite in an environment where only loopback is
    available, or instrument the fixture server/test harness to reject every
    destination except its assigned loopback address. DNS names represented by
    fixtures must be data keys routed through the local proxy, not resolved
    publicly. Capture attempted egress as a hard failure with case ID.

    Validation:

    ```sh
    cargo xtask test
    cargo test -p dezoomify-fixture-server rejects_unmapped_network
    ```

14. Document harness maintenance and close the gate.

    Update existing `testdata/scenarios/README.md` and `docs/testing.md` to
    explain provenance, adding a scenario, route/payload/hash review, local
    serving, test isolation, expected transcript/pixel updates, and the
    difference between deterministic and live checks. Record exact command
    versions and results. Do not create a parallel harness-document hierarchy.

    Validation:

    ```sh
    cargo xtask sources verify
    cargo xtask fixtures verify
    cargo xtask parity validate
    cargo xtask check
    cargo xtask test
    git diff --check
    ```

## Deterministic Workflow Tests Required in This Phase

| Test ID | Workflow | Required assertion |
|---|---|---|
| `P03-SOURCES` | Xtask verifies source lock/prefixes | No fetch; exact trees match |
| `P03-MANIFEST` | Verify all fixture bytes and metadata | No missing, extra, duplicate, changed, or sensitive fixture |
| `P03-SERVER` | Replay HTTP contract cases | Exact method/status/headers/body and zero public egress |
| `P03-LEGACY-WEB` | Run canonical cases through untouched web source | Outputs match transcribed expected records |
| `P03-TRANSCRIPT` | Serialize same workflow twice | Byte-identical canonical transcript |
| `P03-MATRIX` | Validate parity/evidence/case links | Every due preserve row has deterministic coverage |
| `P03-AGGREGATE` | Run `cargo xtask test` | All fast blocking deterministic suites run and propagate failure |
| `P03-COMMAND-SURFACE` | Inspect help and invoke future commands/targets | Only the phase-03 subset is advertised; unavailable commands fail |

## Explicit Stop Conditions

- Fixture provenance/license is unresolved or a fixture contains credentials,
  cookies, tokens, personal data, or other sensitive material.
- Copied bytes do not match recorded SHA-256.
- Two fixtures need the same served URL with incompatible responses and no
  case-scoped routing decision exists.
- The new fixture server attempts public network access in deterministic mode.
- Canonical cases cannot represent an observed legacy distinction.
- Web and Rust expected behavior conflict without an approved matrix decision.
- `cargo xtask` reports success while skipping a required subcommand/test.
- Any source snapshot changes.
- A case is made less strict solely to make a replacement pass.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Fixture copying changes bytes | Manifest SHA-256 and source path on every record. |
| Harness encodes implementation details | Assert protocol-visible requests/results, not private functions. |
| Dynamic server becomes nondeterministic | No wall clock/randomness/public network; ephemeral port is communicated explicitly. |
| One expected file is silently regenerated | Verification is read-only; updates require explicit review mode. |
| Browser-only corpus cannot drive Rust | Store behavior in runtime-neutral JSON cases and transcripts. |
| Xtask becomes a shell-command black box | Unit-test argument construction, failure propagation, ordering, and summaries. |

## Rollback Guidance

Before reversal, inspect path-scoped diffs for `Cargo.toml`, `Cargo.lock`,
`.cargo/config.toml`, `crates/xtask/`, `crates/fixture-server/`,
`testdata/scenarios/`, and phase-03 documentation. Remove or reverse only
files/hunks created by this phase and only after confirming no later/concurrent
edits exist. Never remove source fixtures, run `git clean`, or restore the whole
worktree. Generated `target/`, `node_modules/`, and Playwright caches may be
removed only by exact path after proving they are untracked build artifacts.
Preserve fixture inventory and hash evidence if copied data must be re-reviewed.

## Deliverables

- Root Cargo workspace with `crates/xtask`, `crates/fixture-server`, and tested `cargo xtask` alias
- Phase-gated parser and help with `cargo xtask setup`, `cargo xtask check`, and `cargo xtask test`
- `cargo xtask sources verify`
- Versioned scenario, route, transcript, and manifest schemas
- Reviewed canonical `testdata/scenarios` corpus and manifest
- Deterministic Rust fixture server with security/contract tests
- Legacy web parity harness
- Canonical transcript format and source-oracle snapshots
- `cargo xtask fixtures verify|serve` and `cargo xtask parity validate|report`
- Updated `docs/testing.md` and `testdata/scenarios/README.md`, plus phase-03 gate evidence

## Completion Checklist

- [ ] Root Cargo workspace contains exactly the phase-03 crates before later phases extend it.
- [ ] Every copied payload has source SHA/path, hash, provenance, and served URL.
- [ ] No source fixture or source code changed.
- [ ] Fixture verification detects missing, extra, altered, duplicate, and unsafe paths.
- [ ] Fixture server matches required legacy HTTP behavior on loopback only.
- [ ] Scenario schemas represent success, failure, ordered requests, processing, output, transcripts, and pixels.
- [ ] No canonical route, payload, expected transcript, or pixel data exists outside `testdata/scenarios`.
- [ ] Legacy web behavior matches canonical cases.
- [ ] Repeated transcript generation is byte-identical.
- [ ] `cargo xtask --help` advertises exactly the implemented phase-03 subset and future commands/targets fail as unknown.
- [ ] `cargo xtask setup` and `cargo xtask check` are phase-scoped and failure-safe.
- [ ] `cargo xtask test` runs all fast deterministic phase-03 suites, is public-network-free, and is failure-safe.
- [ ] No stop condition remains unresolved.
- [ ] Phase 03 is marked complete in the gate ledger.
