# Phase 10: Native Runtime And CLI

## Objective

Extract one reusable native runtime that performs HTTP acquisition, discovery, tile download, decoding, bounded concurrency, cache/resume, and output encoding. Both the command-line application and the Tauri desktop application must call this runtime rather than maintaining separate download implementations.

Preserve reviewed `dezoomify-rs` CLI behavior while adopting the generated protocol event/error/capability model. Prepare an in-memory authorization context for phase-12 Native Messaging handoffs, but do not expose cookies through CLI flags, environment variables, files, URLs, logs, Tauri commands, or persistent caches.

## Non-Goals

- Do not build the desktop UI or installer.
- Do not implement the extension or Native Messaging host loop yet.
- Do not register URL protocols or browser native-host manifests.
- Do not accept raw cookie headers as ordinary CLI input.
- Do not silently change output defaults, overwrite behavior, retry policy, cache semantics, or exit codes without a parity decision record.
- Do not move I/O, image decoding, async runtimes, or filesystem access into `dezoomify-core`.
- Do not remove the migration snapshot or old release workflows.

## Dependencies

- Phases 01-09 are complete and green.
- `crates/dezoomify-core/` is the pure format/discovery library.
- `crates/dezoomify-protocol/` defines request, event, error, capability, redaction, and version negotiation types.
- Protocol current and N-1 scenarios are checked in under
  `testdata/scenarios/protocol-v1/` and are consumed through
  `packages/protocol-ts/` and the Rust protocol crate.
- `crates/fixture-server/` and `testdata/scenarios/native/` can emulate
  redirects, authentication, disconnects, retries, content encodings,
  malformed images, range behavior, and large images deterministically, with
  payloads and expected outcomes co-located per scenario.
- The imported native implementation remains available under `migration-sources/dezoomify-rs/` for parity comparison only.

Stop if the final workspace uses different crate ownership. Reconcile paths rather than creating a second downloader crate.

## Exact Paths

Create or modify only:

- `crates/dezoomify-native/Cargo.toml`
- `crates/dezoomify-native/src/lib.rs`
- `crates/dezoomify-native/src/runtime.rs`
- `crates/dezoomify-native/src/client.rs`
- `crates/dezoomify-native/src/auth.rs`
- `crates/dezoomify-native/src/download.rs`
- `crates/dezoomify-native/src/cache.rs`
- `crates/dezoomify-native/src/output.rs`
- `crates/dezoomify-native/src/progress.rs`
- `crates/dezoomify-native/src/error.rs`
- `crates/dezoomify-native/tests/*.rs`
- `apps/cli/Cargo.toml`
- `apps/cli/src/main.rs`
- `apps/cli/src/arguments.rs`
- `apps/cli/src/interactive.rs`
- `apps/cli/src/report.rs`
- `apps/cli/tests/*.rs`
- `testdata/scenarios/native/**`
- `testdata/scenarios/cli/**`
- `crates/xtask/src/native.rs`
- `crates/xtask/src/main.rs`
- `docs/native-apps.md`
- `docs/migration/gates.md` for the phase-10 execution record only
- `artifacts/phase-10/**` for ignored local evidence
- root `Cargo.toml`, `Cargo.lock`, and distribution metadata only as required to register crates

The phase may copy and adapt code from `migration-sources/dezoomify-rs/src/`, but must not modify that snapshot.

## Command Availability

- Available before this phase: `cargo xtask protocol check`, `cargo xtask fixtures verify`, the fast deterministic `cargo xtask test`, `cargo xtask test browser`, `cargo xtask test web`, and normal Cargo workspace commands.
- Added during step 15: the native comparison mode `cargo xtask parity validate --native`.
- Added during step 18: `cargo xtask test native` and `cargo xtask test scenario`.
- Added during step 10: `cargo xtask build cli`.
- The binary command `cargo run -p dezoomify-cli -- ...` becomes available after step 10 creates the CLI crate.

## Sequential Implementation Steps

1. Capture a baseline from the imported CLI. Build `migration-sources/dezoomify-rs` with its locked dependencies, record `--help`, `--version`, representative success/failure exit codes, output naming, format selection, and cache behavior in `artifacts/phase-10/parity-baseline.md`. Use only deterministic fixture URLs.

   **Validate immediately:** hash baseline outputs and store hashes, dimensions, formats, and normalized stderr. Do not bless network-dependent or timestamp-dependent output; all HTTP input comes from `crates/fixture-server` scenarios.

2. Add `crates/dezoomify-native/Cargo.toml` and a minimal `lib.rs`. Depend on
   the exact host-independent `crates/dezoomify-job` crate produced by phase 06,
   core/protocol, plus native-only HTTP, async, image, and encoder crates. Do not
   rename or duplicate the job crate. Define feature flags only for real
   platform/encoder differences; do not use features to create separate CLI and
   desktop logic.

   **Validate immediately:** run `cargo check -p dezoomify-native` and the core dependency-architecture test. Confirm no native dependency entered `dezoomify-core`.

3. Define `NativeRuntime`, immutable `JobRequest`, `JobHandle`, `JobEvent`, `JobResult`, and cancellation semantics in `runtime.rs`. A runtime owns shared HTTP pools; a job owns discovery/download/output state. Every event carries job ID, monotonic sequence, protocol version, and redacted context. Dropping a handle must not detach an unbounded task.

   **Validate immediately:** unit-test unique IDs, event order, cancellation before start, cancellation during wait, completion exactly once, and runtime shutdown waiting for owned jobs.

4. Implement `auth.rs` with `AuthorizationScope` and `EphemeralAuthorization`.
   Restrict scope by exact scheme, host, effective port, path prefix, expiry, and
   optional job ID. Cookie handoff requires explicit consent and remains scoped,
   memory-only, and intentionally absent from persistence. Omit secret values
   from `Debug`/serialization and expose only a request-time matcher. On release,
   perform a best-effort overwrite only for buffers the process owns; do not
   claim guaranteed zeroization of browser, allocator, OS, copied, or transport
   memory. Reject public-suffix widening, HTTP downgrade, redirect scope escape,
   CR/LF, oversized values, and expired contexts.

   **Validate immediately:** run auth tests for exact match, subdomain mismatch,
   default ports, Unicode/punycode host equivalence, redirects, sibling paths,
   expiry, cancellation, debug formatting, protocol serialization rejection,
   intentional non-persistence, and best-effort owned-buffer overwrite
   instrumentation. Verify no API accepts a raw cookie string except a narrow
   feature-gated host-only constructor intended for the future Native
   Messaging host; the ordinary CLI API cannot access it. Tests and docs
   must not assert universal memory zeroization.

5. Implement `client.rs`. Build effective request headers from core tile requests, safe runtime defaults, and optional scoped ephemeral authorization. User-configured CLI headers retain documented precedence, but the code must forbid `Cookie`/`Authorization` through any public untrusted handoff field. Disable automatic redirect authorization forwarding; validate each redirect and rebuild headers for the new URL.

   **Validate immediately:** use two origins from one canonical scenario to prove authorization reaches only matching requests and is stripped on cross-origin/scope-escaping redirects. Verify compressed size limits, timeout, system proxy behavior, TLS policy hooks, and redacted logs.

6. Port discovery driving from the imported native source into `runtime.rs`, adapting it to shared core request/response protocol types. Preserve request deduplication, route limits, image catalog ordering, level selection, bulk behavior, and generated per-request headers.

   **Validate immediately:** run canonical scenario catalogs through old and new drivers and compare normalized catalog JSON. Test cycles, repeated resources, relative redirects, malformed metadata, cancellation, and N-1 protocol request decoding.

7. Port tile scheduling into `download.rs`. Use explicit bounds for network concurrency, decode concurrency, queued decoded bytes, retries, and total response bytes. Emit deterministic logical progress independent of task completion order. Make retry policy observable and cancellation-aware.

   **Validate immediately:** run delayed/out-of-order fixtures and compare event transcripts. Verify peak counters never exceed configured bounds and cancellation prevents new requests while allowing already-owned resources to clean up.

8. Port cache/resume behavior into `cache.rs`. Use atomic temporary writes and rename, content identity keys that exclude secrets, metadata versioning, integrity checks, and per-job namespaces. Never persist request headers, cookies, authorization, handoff payloads, or unredacted source URLs when policy requires redaction.

   **Validate immediately:** test clean resume, truncated tile, wrong hash, stale metadata version, concurrent lock conflict, cancellation mid-write, read-only directory, and cache inspection with the secret scanner.

9. Port encoder/output behavior into `output.rs`. Preserve PNG streaming, JPEG limits/quality, image-rs formats, ZIF-TIFF, and IIIF directory output where supported. Validate paths before network work; use atomic file replacement policy; never overwrite without the same explicit legacy behavior.

   **Validate immediately:** compare dimensions, pixel hashes, metadata, filenames, file-vs-directory shape, and error codes with baseline fixtures. Test disk-full injection, existing output, invalid extension, path traversal in suggested names, and cancellation during encode.

10. Complete `apps/cli` as the CLI composition crate and register
    `cargo xtask build cli`. Port argument parsing and interactive selection while
    delegating all work to `dezoomify-native`. Keep stable options and aliases
    unless the parity record explicitly approves a change. Add `--json` for
    protocol events only if specified by the earlier protocol plan; ensure stdout
    machine output and stderr human progress never mix.

    **Validate immediately:** run `cargo run -p dezoomify-cli -- --help`, `--version`, representative legacy invocations, non-interactive JSON mode, invalid arguments, stdin source, and output collisions. Snapshot normalized output and exit codes.

11. Add structured signal handling. First interrupt requests graceful cancellation and atomic cleanup; a second interrupt exits promptly with the documented code. Interactive prompts must terminate on EOF and never appear when stdin/stdout are not terminals unless explicitly requested.

    **Validate immediately:** integration-test SIGINT/SIGTERM on Unix and the available console-control equivalent on Windows CI. Confirm no final output is reported, temporary files are handled by policy, and no child process remains.

12. Add deterministic native scenarios under `testdata/scenarios/native/` for
    same-origin, redirects, gzip/zstd, status retries, disconnect/resume,
    malformed tile, custom headers, scoped ephemeral authorization, auth
    redirect escape, cache resume, bulk output, huge dimensions, low disk, and
    slow cancellation. Co-locate payloads and expected transcripts/results and
    give each scenario exact expected request-order constraints and output
    digest.

    **Validate immediately:** run `cargo xtask fixtures verify`, `cargo xtask parity validate`, and direct integration tests with `cargo test -p dezoomify-native --test scenarios -- --nocapture`.

13. Add protocol current/N-1 tests. The runtime must accept current and supported N-1 `JobRequest`, emit events representable to the negotiated version, ignore documented unknown optional fields, and reject unsupported major or capability requests before network/file effects.

    **Validate immediately:** replay checked-in current, N-1, N-2, and future protocol scenarios. Current and N-1 must produce equivalent output hashes; incompatible scenarios must make zero HTTP requests and zero output files.

14. Add log and diagnostic redaction. Centralize URL/header/error redaction through protocol policy. Redact userinfo, cookie/auth headers, signed query parameters, native handoff tokens, local profile paths, and response snippets. Bound all snippets and make verbose logging obey the same redaction.

    **Validate immediately:** run every error path with canary secrets and scan stdout, stderr, logs, cache, temp paths, JSON events, panic reports, and test artifacts. The scan must return zero canary matches.

15. Implement the `cargo xtask parity validate --native` mode. It must launch old and new CLIs against the same deterministic server, normalize intentional presentation differences, compare exit classes/output dimensions/pixel hashes/cache resume behavior, and write `artifacts/phase-10/parity-results.json`.

    **Validate immediately:** run `cargo xtask parity validate --native` twice. Any difference requires an entry in `artifacts/phase-10/approved-differences.md` with rationale and reviewer; absent approval, stop. This mode becomes available only after this step.

16. Add benchmarks and limits for a representative many-tile image and a large streaming PNG. Record peak resident memory and elapsed time without making wall-clock values hard pass/fail across machines. Enforce deterministic concurrency and queue limits as assertions.

    **Validate immediately:** run `cargo bench -p dezoomify-native --no-run` and the bounded-resource integration profile. Ensure the large-image scenario does not buffer the full decoded image when using a streaming-capable encoder.

17. Add platform path tests for Linux, macOS, and Windows semantics. Cover reserved names, separators, Unicode, long names, read-only destinations, same-file source/output prevention, and IIIF directory cleanup. Keep platform-specific tests on their native CI runners when emulation would be misleading.

    **Validate immediately:** run local applicable tests and ensure CI matrix entries are prepared for all three targets without marking them allowed-to-fail.

18. Add `cargo xtask test native` to start deterministic scenarios, run native unit/integration tests, CLI snapshots, protocol compatibility, redaction scan, and `cargo xtask parity validate --native`. It must clean servers, temp directories, and child CLIs on all exits.

    **Validate immediately:** run `cargo xtask test native` and `cargo xtask test scenario` twice and once with `RUST_LOG=trace`. Confirm results match and trace artifacts contain no canaries. These commands become available only after this step.

19. Run final gates: `cargo fmt --all -- --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, `cargo xtask protocol check`, `cargo xtask test`, `cargo xtask parity validate --native`, `cargo xtask test native`, `cargo xtask test browser`, and `cargo xtask test web`.

    **Validate immediately:** inspect `git diff --check`, crate graph, lockfile, output hashes, and `git status --short`. No migration snapshot or release file may change.

20. Append only the phase-10 row in `docs/migration/gates.md`, including parity differences/approvals, protocol N-1, redaction, large-image, and platform evidence.

    **Validate immediately:** run `git diff --check -- docs/migration/gates.md plans/10-native-runtime-and-cli.md`; every approved parity difference must name its reviewer and source evidence.

## Deterministic User Workflows

### Basic CLI Download

1. Run `cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr` and obtain the source URL from `testdata/scenarios/native/native-basic/`.
2. Run `cargo run -p dezoomify-cli -- <printed-source-url> artifacts/phase-10/manual/basic.png`.
3. Verify progress reaches the exact scenario tile count and exits 0.
4. Run `sha256sum artifacts/phase-10/manual/basic.png` and compare with the scenario manifest.
5. Run the command again without overwrite approval and verify the documented nonzero exit with the existing file unchanged.

### Cache Resume

1. Keep `cargo xtask fixtures serve --port 0 --write-address target/fixture-server.addr` running and obtain the disconnect/resume URL and control sequence from `testdata/scenarios/native/native-disconnect-resume/`.
2. Run the CLI with `--tile-cache artifacts/phase-10/manual/cache` and the scenario output path.
3. Allow the deterministic server to disconnect at its configured request and verify the CLI fails without a completed output.
4. Restart the same scenario state and rerun the exact CLI command.
5. Verify already valid tiles are not requested again and final output hash matches.
6. Scan the cache and verify no authorization or cookie canary is present.

### Scoped In-Memory Authorization Test

1. Run the native integration harness for `native-scoped-auth`; do not use a shell argument for the secret.
2. Inject authorization through the crate-private test constructor.
3. Verify matching metadata/tile requests receive the cookie.
4. Verify sibling origin, redirect target, logs, cache, and output metadata do not receive it.
5. Cancel the job and verify authorization storage is dropped and cannot be reused.

### Large Streaming Output

1. Run `native-large-streaming` with the scenario's low deterministic memory budget.
2. Choose PNG or IIIF output as specified by the fixture.
3. Verify the job completes under the asserted queue/decoded-byte bounds.
4. Verify dimensions and digest without opening the full image in a GUI.

### Protocol N-1 CLI Invocation

1. Replay the N-1 job scenario through the native test driver.
2. Verify the runtime negotiates N-1, emits only N-1 fields, and creates the same output hash as current protocol.
3. Replay N-2 and verify zero requests/files plus `PROTOCOL_VERSION_UNSUPPORTED`.

## Stop Conditions

- Stop if native and CLI code duplicate discovery/tile logic instead of calling the shared runtime/core.
- Stop if an authorization secret can enter command-line arguments, environment, persistent config, cache, logs, panic reports, deep links, or Tauri IPC.
- Stop if core gains native I/O/runtime/image dependencies.
- Stop if old/new parity differs without a written approved decision.
- Stop if cancellation can leave detached jobs, corrupt outputs, intentionally
  persisted credentials, or owned secret buffers retained past their documented
  lifetime.
- Stop if protocol incompatibility causes network or filesystem side effects before rejection.
- Stop if deterministic tests require public network access.

## Risks And Mitigations

- **Behavior regression during extraction:** fixture-based old/new parity with hashes and approved-difference ledger.
- **Secret leakage:** scoped authorization type, explicit consent at handoff,
  memory-only/no-intentional-persistence policy, no serialization/Debug,
  best-effort owned-buffer overwrite, redirect revalidation, and canary scans
  without a false universal-zeroization guarantee.
- **Desktop/CLI divergence:** one `dezoomify-native` runtime and integration-only app layers.
- **Large-image memory growth:** bounded queues, streaming encoders, counters asserted in tests.
- **Cache corruption:** atomic writes, versioning, integrity validation, and interruption tests.
- **Platform filename differences:** native CI matrix and explicit sanitization contracts.
- **Protocol drift:** generated models and current/N-1 replay gates.

## Safe Rollback

1. Preserve targeted diffs and parity artifacts before rollback.
2. Remove only newly added `crates/dezoomify-native` and `apps/cli` implementation files after checking ownership and concurrent edits; preserve their scaffold README files unless the scaffold owner approves removal.
3. Revert only their workspace and lockfile entries with a targeted patch.
4. Do not modify `migration-sources/dezoomify-rs`; it remains the comparison baseline.
5. Re-run phase-09 gates and core architecture tests.
6. Never use hard reset, broad checkout, broad clean, or whole-lockfile replacement.

## Artifacts

- `artifacts/phase-10/parity-baseline.md`
- `artifacts/phase-10/parity-results.json`
- `artifacts/phase-10/approved-differences.md`
- `artifacts/phase-10/results.json`
- `artifacts/phase-10/redaction-scan.json`
- `artifacts/phase-10/resource-bounds.json`
- `artifacts/phase-10/manual/*`
- Platform-specific test reports

## Completion Checklist

- [ ] CLI and future Tauri shell can use one native runtime API.
- [ ] Core remains free of I/O, async runtime, filesystem, and image decoding.
- [ ] Legacy CLI behavior is matched or explicitly approved.
- [ ] Cache/resume, output encoders, retries, cancellation, and signals are deterministic.
- [ ] Authorization is consented at handoff and exists only as scoped,
  memory-only, non-serializable, intentionally non-persisted state; owned buffers
  receive best-effort overwrite without a zeroization guarantee.
- [ ] Redirects cannot leak authorization outside scope.
- [ ] Current and protocol N-1 produce equivalent outputs.
- [ ] Incompatible protocol requests make no external side effects.
- [ ] Large streaming output respects queue/memory bounds.
- [ ] Logs, cache, diagnostics, and artifacts contain no canary secrets.
- [ ] `cargo xtask parity validate --native` and `cargo xtask test native` pass repeatedly.
- [ ] Browser and website regression gates remain green.
- [ ] The phase-10 migration gate row links parity, redaction, protocol, and platform evidence.
