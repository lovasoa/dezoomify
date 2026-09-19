# Dezoomify architecture simplification: diagnosis and four-agent execution plan

## Objective and scope

Replace repeated representations of the same job with one authoritative Rust engine, two execution layers, and a shared UI that renders engine snapshots. Preserve the four products and their useful behavior while removing incidental machinery.

Protocol backwards compatibility is explicitly unnecessary. Update producers and consumers together. Remove old schemas, aliases, version ranges, and compatibility translations rather than maintaining them.

Preserve supported formats, native encoders, local inputs, authenticated extension fetching, scoped native handoff, partial output, pause/cancellation, queues/history, browser display-only behavior, and existing visual/localization requirements. Preserve intended behavior, not implementation bugs or synthetic transcript sequences.

This document is an implementation brief for **four agents running concurrently in one worktree**. It assigns exclusive ownership of files, defines the interfaces between their changes, and specifies integration checkpoints. It does not authorize four independent rewrites of the shared contracts.

Repository reviewed: `/Users/ophir.lojkine/dev/dezoomify`. Paths below are relative to that root. At review time, `node-app/` was untracked pre-existing work. It is outside every workstream: do not modify, move, delete, stage, or use it as an implementation target.

## 1. Diagnosis

### 1.1 Several layers independently model one lifecycle

The same job has state, correlation, cancellation, completion, and/or event sequencing in:

- `crates/dezoomify-job/src/job.rs`: actual job engine.
- `crates/dezoomify-wasm/src/session.rs`: another state enum, outstanding-request maps, recovery validation, and correlation translation.
- `crates/dezoomify-native/src/runtime.rs`: another job handle, scheduler, event sequence, cancellation flag, and completion flag around the actual pipeline.
- `apps/desktop/src-tauri/src/jobs.rs`: another lifecycle and event ledger.
- `packages/shared-ui/src/controller.ts`: another transition table.

Symptoms are concrete:

- `apps/desktop/src/jobController.ts::ensureChosenThroughPreflight` synthesizes `images-found`, `image-chosen`, `level-chosen`, and `preflight-ok` to make the UI controller catch up.
- `apps/desktop/src-tauri/src/jobs.rs::spawn_discovery_worker` creates an engine, starts it, drains and discards effects, and reports discovery completion without performing discovery. A different worker later runs the real pipeline.
- `drive_engine_cancel` creates a transient engine for cancellation parity rather than controlling the engine doing the work.

Resolution: one engine owns business lifecycle. Runtime handles own tasks/resources. UI state is a projection, not another workflow.

### 1.2 The WASM arena adds a round trip for bytes the engine does not use

The normal browser tile path currently fetches, decodes, and paints a tile, then sends its body to the engine worker. The worker allocates/writes/commits an arena buffer; the Rust session consumes it, discards the body, and reports a successful tile outcome.

Evidence: `packages/browser-runtime/src/engine-host.ts::acquire`, `worker-host.ts::provideBytes`, and `crates/dezoomify-wasm/src/session.rs::on_provide_resource`.

Resolution: submit metadata bytes directly; submit processing bytes only when processing is required; acknowledge tile acquisition with a typed result. Delete the arena and its public ownership protocol.

### 1.3 Retry policy is duplicated and loses the facts needed to be correct

The engine takes `TileOutcome { tile, ok: bool }`, which cannot distinguish transient network failure from HTTP 403, deterministic decode failure, or permission failure. Website fetching and native HTTP also retry independently.

A read-only experiment imported the production `createWebFetcher`, supplied a mocked HTTP 403 response, passed `maxRetries = 3`, and replaced sleeping with a no-op. No network was contacted. The result was:

```json
{"fixtureStatus":403,"retryBudget":3,"actualFetchAttempts":4,"errorCode":"TILE_FAILED","retryable":true}
```

Relevant code: `packages/browser-runtime/src/web-fetch.ts::fetchTileFor`, `crates/dezoomify-job/src/job.rs::apply_tile_outcome`, and `crates/dezoomify-native/src/http.rs::fetch_once`.

Partial handling has related structural problems visible in source:

- The first exhausted tile moves the engine immediately to a partial-decision phase.
- `job_driver.rs::acquire_tiles` then abandons later outcomes in the same completed batch.
- The engine's recovery `Retry` branch clears failed IDs without requeueing those failed tiles.

Resolution: typed failures, one engine retry budget/delay policy, one complete tile ledger, and explicit handling of in-flight work before a partial decision.

### 1.4 A lazy tile plan becomes many eager parallel collections

The core already provides lazy grid iteration. The job expands it into separate collections for URLs, headers, processing, destinations, extents, attempts, and planned/pending/active/acquired/failed IDs. Repeated `Vec::remove(0)`, `contains`, and `retain` operations introduce quadratic scheduling work.

Resolution: lazy plan cursor, compact tile status, a retry deque, and full request context only for active/retryable work. Do not promise constant memory: the status/missing ledger can legitimately be proportional to tile count, and arbitrary custom plans may require stored descriptors.

### 1.5 Native execution retains too much and has redundant scheduling

The actual native driver starts scoped threads for each drained batch, joins the batch before processing outcomes, retains every decoded tile, and later allocates a full canvas and often a full encoded buffer. `http.rs::fetch` constructs a new `ureq::Agent` per fetch instead of reusing one across the job.

Resolution: completion-driven execution, one reusable HTTP client, bounded codec work, incremental assembly, and one owner for temporary output/publication.

### 1.6 Some tests protect an alternative implementation

Repository reference searches found production-looking APIs whose callers are tests or benchmarks:

- Hand-written PNG/DEFLATE encoding in `packages/browser-runtime/src/save.ts`.
- Alternative readable/display canvas abstractions.
- `createWebIntegration`, alongside the actual website fetcher.
- Native `pool::run_bounded`, while the real driver has separate scoped-thread execution.
- Spill/streaming-memory helper arithmetic tested without running a spilling production pipeline.

Resolution: verify reachability, delete unused implementations, and transfer useful assertions onto the production path. Tests of an arithmetic estimate do not demonstrate actual peak memory.

### 1.7 Contracts are both over-centralized and duplicated

The protocol crate mixes engine messages, arena ownership, browser constants, UI labels, duplicated format inventory, and native credential exchange. Meanwhile desktop IPC types are hand-declared in TypeScript and structured Rust events pass through string maps, `k=v` details, JSON embedded in strings, and parsers that reconstruct the original values.

Aliases include `job`/`jobId`, `missing`/`missingTiles`, and multiple resource-kind spellings.

Resolution: types live with their semantic owner, boundary declarations are generated, and structured values remain structured end to end. Separate user commands from host completions so desktop IPC cannot pretend to complete effects.

### 1.8 Deployment and architecture checks preserve historical machinery

`scripts/build-site.mjs` deploys the legacy website at `/`, the new website at `/beta`, and two proxy routes. Some architecture checks pin function-name substrings or require a compatibility re-export shim to remain exactly as written.

Resolution: one website after behavior parity; dependency/import-graph checks rather than exact implementation spelling. Keep useful real trust boundaries such as proxy upstream validation and extension source-tab binding.

### Evidence limits

This diagnosis combines source inspection, repository reference searches, and the mocked HTTP experiment above. It is not a claim that the full test matrix was run or that all inferred race conditions were reproduced. The first implementation checkpoint adds focused reproductions and measures the actual pipelines.

## 2. Final architecture

```text
Website ----+
            +--> Browser runtime --> thin WASM binding --+
Extension --+                                           |
                                                        +--> pure Rust engine
CLI --------+                                           |
            +--> Native runtime ------------------------+
Desktop ----+

Graphical products:
Shared UI --> Shared application model --> generated boundary types
                       ^
             browser or desktop job service
```

Target organization:

```text
crates/dezoomify-engine/
  formats/       # existing parsers, predominantly moved rather than rewritten
  discovery/
  plan/
  processing/
  job/
  api/
crates/dezoomify-native/
  runner.rs
  transport/
  output/
  cache/
  handoff/
crates/dezoomify-wasm/       # serialization and direct delegation only
packages/bindings/          # generated engine/native declarations
packages/app-model/         # job service, store, sequential queue, history
packages/browser-runtime/   # effects, transport, workers, canvas
packages/shared-ui/         # React, localization, presentation
apps/web/
apps/extension/
apps/desktop/
apps/cli/
```

The current core, job, and engine-related protocol definitions become one pure engine crate with private modules. Format parser internals do not become public simply because crates merge. Native Messaging types move to native handoff. Desktop-only IPC types stay at their boundary.

Ownership of behavior:

| Concern | Owner |
|---|---|
| Format discovery, geometry, processing recipes | Engine |
| Selection rules, deferred resolution, follow budgets | Engine |
| Retry budget/delay, acquisition scheduling, partial decisions, pause | Engine |
| Job phase, terminal result, effect correlation | Engine |
| Fetch routes, permission APIs, credential scopes, clocks | Runtime |
| Encoded bytes, decoded images, canvas, native paths | Runtime |
| Output commit and resource cleanup | Runtime, with actual results supplied to engine |
| Queue, history, settings drafts, current snapshot | Shared application model |
| Localized copy, controls, preview presentation | Shared UI |
| Source-document binding and optional grants | Extension |
| Window ownership, OS dialogs, open/reveal, deep links | Desktop |

Keep Rust, React, Vite/WXT, Tauri, serde, wasm-bindgen, and tsify. Use Tokio/Reqwest for the native execution layer, with bounded blocking codec tasks. Their workspace availability does not mean the current native pipeline already uses them: this is an explicit runtime migration.

Keep the visible browser canvas in the page for progressive rendering and ordinary `<img>` display-only fallback. Keep the engine off the main thread. Worker topology is an implementation detail of the shared browser runtime, not something each product assembles independently.

## 3. Four non-overlapping file ownership sets

**Only the designated owner edits a path, including its manifest, tests, generated files, and deletion. Reading any path is allowed.** More-specific assignments below take precedence over a parent-directory assignment. The untracked `node-app/` exclusion takes precedence over everything.

| Agent / workstream | Exclusive write ownership |
|---|---|
| **A: Engine, WASM, and authoritative bindings** | `crates/dezoomify-core/**`, `crates/dezoomify-job/**`, `crates/dezoomify-protocol/**`, new `crates/dezoomify-engine/**`, `crates/dezoomify-wasm/**`, `packages/wasm-bindings/**`, new `packages/bindings/**`, `packages/wasm-harness/**`, `crates/xtask/src/protocol.rs`, and any new `crates/xtask/src/protocol/**` |
| **B: Native execution and Rust product boundaries** | `crates/dezoomify-native/**`, `apps/cli/**`, `apps/desktop/src-tauri/**` including Rust tests, native-host binaries, Tauri permissions/configuration, and build scripts |
| **C: Browser execution, website, and extension** | `packages/browser-runtime/**`, `apps/extension/**`, existing `src/**`, new `apps/web/**`, `functions/**`, `legacy/**`, root `index.html`, `privacy.html`, `terms.html`, `favicon.png`, `favicon.svg`; own package manifests and browser/extension tests within these trees |
| **D: Shared application model/UI, desktop frontend, and integration** | `packages/shared-ui/**`, new `packages/app-model/**`, `apps/desktop/**` **except** `apps/desktop/src-tauri/**`; all root `test/**`; `crates/fixture-server/**`; `testdata/**`; root Cargo/pnpm/package/TypeScript/Vite configuration and both root lockfiles; `crates/xtask/**` **except A's protocol files**; `scripts/**`, `.github/**`, `.cargo/**`, `generated/**`, `release/**`, `installer/**`, `docs/**`, `plans/**`, root `AGENTS.md`, `README.md`, and other tracked integration/configuration paths not assigned above |

Clarifications:

- D owns the old root website/UI tests even when they test C's implementation. C describes required assertion changes to D and adds focused tests inside C-owned packages.
- B owns Tauri Rust/configuration; D owns Tauri TypeScript and real-window test scripts under `apps/desktop/tests/`.
- A owns all generated contract declarations. B authors native declaration sources and the native declaration emitter in B-owned files; A integrates their output into `packages/bindings`.
- D owns shared scenario manifests, hashes, and goldens. Other agents may read them and add local fixture data under their own test trees, then request shared-corpus changes from D.
- C owns removing legacy source. D owns removing legacy copying/routing assertions from deployment scripts. Agree on a cutover checkpoint before either deletes the live path.
- Moves count as edits at both source and destination. Cross-owner moves require the source owner to delete and the destination owner to create; never silently move another agent's file.
- D's residual ownership applies to tracked integration files, not arbitrary pre-existing untracked files.

### Shared-worktree operating rules

1. Launch exactly four implementation agents, one per workstream. All four start concurrently. Give each this whole plan and its assignment.
2. Each agent reads root and applicable nested `AGENTS.md` files and the relevant contracts before editing.
3. Record required cross-owner changes as requests naming the file, desired change, dependency, and acceptance criterion. The receiving owner performs the edit.
4. Do not reset, restore, clean, stash, switch branches, stage all files, or format the whole repository while peers are working. Never revert another agent's changes to make a local test pass.
5. Use `apply_patch` for manual edits. Format only owned source files during implementation. D runs whole-workspace formatting only at a coordinated quiet checkpoint.
6. D alone writes `Cargo.lock`, `pnpm-lock.yaml`, workspace membership, and shared configuration. B/C/A submit dependency/member requests early. After D refreshes the lockfiles, use `--locked`/frozen-lockfile modes where supported.
7. D alone runs pnpm installation and repository-wide build/test orchestration. A alone runs contract generation that writes tracked declarations. Coordinate these operations; do not run a second generator concurrently.
8. Use distinct ignored build/output directories for overlapping toolchains when possible: for example `CARGO_TARGET_DIR=target/arch-A` and `target/arch-B`, and unique E2E artifact paths. A shared Cargo lockfile still has one owner even with separate target directories.
9. Avoid concurrent website/extension builds that regenerate the shared ignored `wasm/` output. A publishes one compatible WASM artifact at a checkpoint; C builds against it until the next agreed regeneration. Use existing no-regeneration build paths where available, or request D to add one.
10. Full verification happens on a stable shared revision: agents announce a quiet checkpoint, D runs the matrix, and failures return to the owning agent. Passing tests during concurrent edits are not final evidence.
11. Do not commit, push, or open PRs unless separately requested. Return owned-file lists, test evidence, remaining blockers, and interface changes to the coordinating agent.

## 4. Interfaces agreed before consumers diverge

The following semantics and names form the starting contract. A publishes the compilable Rust API and generated engine declarations early. B publishes native command/output declarations early. C and D implement against those declarations, not hand-written copies. Proposed changes require a message to all affected owners before code changes.

### 4.1 Engine API

Conceptual Rust entry points, with errors made explicit in the actual signatures:

```rust
Job::start(options: JobOptions) -> Result<(Job, Update), ValidationError>
Job::command(&mut self, command: UserCommand) -> Result<Update, CommandError>
Job::complete(&mut self, effect: EffectId, result: EffectResult)
    -> Result<Update, CompletionError>
Job::provide_metadata(&mut self, effect: EffectId,
    response: ResponseMetadata, bytes: &[u8]) -> Result<Update, CompletionError>
```

`Update` contains newly issued effects and the current `JobSnapshot`. Serialization may avoid retransmitting unchanged large catalog data, but do not build a generic patch/diff protocol. Snapshot revisions are job-scoped. Runtime routing uses one opaque job ID; the engine does not need to own routing IDs.

Canonical concepts:

- `JobOptions`: ordered discovery inputs, optional format selection, selection policy, partial policy, retry policy, output format, and validated host budgets.
- `UserCommand`: select image/level, answer partial decision, pause, resume, cancel. It cannot supply bytes or claim output publication.
- `EffectId`: engine-minted, checked, job-scoped identifier. Each attempt has a new ID. The same ID reaches native/browser execution without remapping.
- Effects: acquire metadata, probe a tile, acquire/process/decode/place a tile, wait for a retry timer, finalize output, and cancel/release outstanding work. A supplies closed variants and typed payloads.
- Tile completion: acquired, displayed without readable bytes, or failed with structured `Failure`. Metadata bodies use the separate byte method.
- `Failure`: closed category/code plus relevant HTTP status, optional retry-after observation, resource/transport context, and bounded diagnostics. Host-observed facts are preserved. Engine policy decides retry and partial eligibility.
- `JobSnapshot`: current lifecycle, pause flag where applicable, progress counters, selection/decision payload when relevant, and terminal result/failure. It has no secret headers, pixels, native path, or another host's resource handles.
- `OutputSummary`: geometry, format, completeness/missing-work summary, and honest disposition: native publication, browser save initiated/ready as appropriate to actual behavior, or display-only. Browser anchor activation cannot prove a file reached disk.

Engine state is phase-specific data, not one flat collection of optional fields. Presentation snapshots are projections of this state, not independently mutable lifecycle state.

### 4.2 Behavioral invariants

- One retry budget controls tile acquisition, processing, and decode outcomes. Permanent failures are not retried. Transport-route fallback has a bounded policy distinct from retrying the same route.
- Timers report elapsed time as an explicit effect completion. Pure engine code reads no clocks.
- Pause stops issuing new acquisitions; in-flight work settles. Ready retries remain queued until resume.
- Deferred catalog entries continue inside the same job, with one original input and bounded follow/cycle tracking. Hosts do not recursively start replacement jobs for deferred metadata.
- Selection defaults are explicit policies. Preserve product defaults through configuration rather than accidentally changing all products to one default.
- When tiles fail permanently, account for already-started work and remaining scheduled work before offering the final missing-work decision. Retry requeues exactly the eligible failed work; it does not lose successful results or retry unrelated tiles.
- Normal success follows successful finalization. Cancellation follows runtime quiescence/cleanup acknowledgment, not merely sending an abort signal.
- Define the output commit race explicitly: if publication won, report the committed result; if cancellation won, publish nothing. Native cleanup removes only job-owned temporary output, never an arbitrary destination inferred to be uncommitted.
- Late/duplicate completions cannot mutate the next job or settle the same effect twice. Keep the protection once at the authoritative correlation boundary; runtime disposal still prevents resource leaks.
- Full missing-work detail remains available for partial results. Normal progress snapshots carry bounded summaries instead of repeatedly serializing the entire tile ledger.

### 4.3 Browser service and shared application model

D owns a host-neutral service interface in `packages/app-model`. Its initial shape is:

```ts
interface JobService {
  start(request: JobStartRequest, observer: JobObserver): Promise<JobHandle>;
}
interface JobHandle {
  readonly id: string;
  command(command: UserCommand): Promise<void>;
  dispose(): Promise<void>;
}
interface JobObserver {
  snapshot(snapshot: JobSnapshot): void;
  hostStatus(status: HostStatus): void;
}
```

`UserCommand` and `JobSnapshot` are generated imports. `JobStartRequest` composes engine options with a product-local execution specification; it is not a new engine options schema. D, B, and C settle its exact discriminated shape at the early contract checkpoint. Browser assembly handles and native destination settings remain on their respective side of the implementation.

`HostStatus` is a small TypeScript presentation contract for actual transport/permission/output actions, not an alternate job phase machine. Engine snapshots remain authoritative for business state. The application model supplies stable snapshots to React, for example through `useSyncExternalStore`.

C implements the browser service. D implements the Tauri frontend service using B's generated IPC declarations. Runtime packages may import the app-model service types but do not import React views. Shared UI imports app-model and presentation helpers, not browser transport/canvas modules.

### 4.4 Native runner and desktop IPC

B exposes a native job handle with a command sender, a typed snapshot stream, and completion/cleanup ownership. CLI and desktop use the same runner. No extra desktop scheduling policy or `PipelineEvent` string map sits between them.

Desktop commands are typed operations equivalent to:

- Start with validated options/destination and a per-job `Channel<JobSnapshot>`.
- Send a `UserCommand` to a job owned by the requesting window.
- Open/reveal a retained published output reference.
- Read actual capabilities/settings as needed by the shipped frontend.

The desktop retains a job-handle registry, not another lifecycle. Use the existing configured-folder flow as the normal start-to-save behavior. Remove obsolete alternate destination commands only after B and D confirm they have no shipped caller. Folder selection, settings, and output naming remain supported.

B keeps OS paths and credential material native. Generated outbound IPC structs contain only intentionally exposed fields. TypeScript shape assertions alone are not a validation boundary for untrusted input.

### 4.5 Binding generation

- Keep serde/wasm-bindgen/tsify. Engine API definitions are authoritative for engine messages.
- A owns `packages/bindings` and its package exports, including engine and native declaration subpaths.
- B exposes native/desktop/handoff declarations from B-owned Rust sources, using tsify declarations or an equivalent direct emission from those same types. A integrates the emitter into the existing `cargo xtask protocol generate` entry point.
- Do not compile native codecs or Tauri into WASM merely to emit TypeScript.
- A and B avoid duplicate declaration names/import cycles. D updates workspace/package consumers and architecture rules when the new exports are available.
- Keep the existing package/crate entry points until their coordinated cutover if needed for compilation, but do not implement old/new message translation. Temporary build scaffolding has an owner and is removed before final verification.

### 4.6 Extension and handoff boundaries

Keep explicit-action scans, browser-verified source bindings, document generations, narrow grants, bounded source operations, and the distinction between tab-origin and extension-origin fetch. A source page is untrusted; a private installed-build message union is not a substitute for validating it.

C owns the extension-internal TypeScript message union. Native handoff definitions are B-owned Rust types generated by A. B and C use one exact handoff revision and reject mismatches before consent/credentials. Preserve origin-scoped consent and replay prevention; remove compatibility ranges and aliases.

## 5. Workstream A: authoritative engine, lean WASM, generated types

### A1. Establish engine regressions and publish the initial contract

- Read architecture, job-engine, protocol, errors, security, and testing contracts.
- Add focused engine regressions for typed retry decisions, late in-flight results at partial boundaries, partial retry requeueing, paused timers, stale attempts, and finalization/cancellation ordering.
- Publish the canonical API definitions and initial generated declarations promptly. Send B/C/D exact import paths and an example complete discovery-to-output trace.
- Request D's workspace membership/lockfile updates before builds need the new engine crate.

### A2. Consolidate pure implementation ownership

- Move format/discovery/plan/processing code and job policy into `crates/dezoomify-engine` modules. Prefer mechanical moves for parsers.
- Keep dynamic/private tile-plan details private and emit public catalog summaries through one projection.
- Remove duplicate processing/geometry/state/command definitions. Derive format inventory from the actual registry, including all registered formats.
- Extract native/handoff type ownership with B before deleting `dezoomify-protocol`; B creates the new native definitions, A removes old definitions at the agreed cutover.

### A3. Replace the engine state and scheduler internals

- Introduce phase-specific internal state.
- Preserve lazy grid planning; replace eager parallel maps with a cursor, compact status ledger, active-effect context, and retry deque.
- Move selection policies and deferred resolution into the engine.
- Classify host failure facts without dropping them to a boolean.
- Implement one retry budget/backoff with explicit timers.
- Settle acquisition accounting before a partial decision. Requeue failed tiles correctly on retry.
- Model finalization and cleanup acknowledgments so terminal state reflects actual resource/output results.

### A4. Delete the WASM arena and lifecycle wrapper

- Replace the session with serialization, bounds validation, direct engine calls, and explicit disposal.
- Remove `ByteArena`, `ArenaHandle`, `BufferHandle`, allocate/write/commit/take/free methods, `SessionState`, and adapter-generated request mappings.
- Accept metadata as a direct byte argument. Accept processing input only for actual byte transformation. Keep tile success acknowledgment body-free.
- Generate the real WASM declarations and update the Node/WASM harness.

### A5. Finish generation and deletion

- Integrate B's native declaration emitter into the protocol-generation command.
- Publish bindings subpaths and package exports agreed with C/D.
- Remove superseded core/job/protocol crates after D switches workspace membership and B/C stop importing them.
- Remove compatibility aliases, transport-string leniency used only for old schemas, and redundant browser/UI constants from engine types.

### A acceptance

- One job phase machine and one effect-correlation authority.
- Permanent tile failures issue one acquisition attempt; transient failures honor exactly the configured budget.
- Partial retry actually issues failed work again, with successful tiles preserved.
- Deferred selection uses one job and bounded resolution.
- Ordinary tile acknowledgment moves zero body bytes into WASM.
- Synthetic large-grid tests show approximately linear scheduling work and bounded active request descriptors.
- Fresh WASM tests execute real typed round trips; declarations are generated, never hand-edited.

## 6. Workstream B: one native execution path and thin Rust products

### B1. Capture native behavior and publish runner/IPC declarations

- Read native-apps, job-engine, protocol, security, errors, and testing contracts.
- Add native regressions around the actual driver for partial batch results, cancellation/publication races, local input, cache behavior, and output metadata.
- Publish the native runner API, desktop command payloads, and handoff payloads to A/D/C early.
- Request D's workspace dependency/lockfile changes for Tokio/Reqwest and any strictly necessary helpers.

### B2. Replace batch execution with a completion-driven runner

- Use one reusable Reqwest client per suitable runtime/job scope, preserving redirect validation and credential scoping on every hop.
- Execute engine-issued effects; do not maintain a competing retry or acquisition scheduler.
- Use bounded async acquisition and bounded `spawn_blocking` codec work. An engine slot covers the full acquire/process/decode/place operation, so decoded work cannot build an unbounded queue.
- Use cancellation-aware waits. Cancelling a future does not forcibly stop a blocking codec task: track it, prevent publication, and await/release its resources before reporting cleanup.
- Preserve native local-file acquisition, scoped user headers, timeouts, and per-origin pacing.
- Remove transport-level retry loops that multiply engine retry budgets.

### B3. Make one output sink own assembly and publication

- For declared geometry, validate memory/encoder limits before allocation and paint/release tiles promptly.
- For non-overlapping tiles, consume completions immediately. For custom overlapping layouts, preserve plan-order placement with a bounded outstanding/reorder window.
- For unknown dimensions, spool bounded job-owned data and later assemble without retaining every decoded tile. Reuse safe existing encoding/cache primitives where appropriate, but do not mix ephemeral job output with unrelated persistent cache ownership.
- Preserve first-tile metadata selection deterministically and retain ICC/EXIF behavior of supported encoders.
- Stream encoded output into temporary files when codec APIs support writing to a writer. Account honestly for codecs that still require buffers.
- Use one commit point with explicit cancellation ordering; cleanup can delete only resources this job owns.
- Preserve `.partial` output naming, collision behavior, native formats, and IIIF directory output.

### B4. Thin CLI, desktop Rust, and Native Messaging

- CLI maps arguments to options, runs the native service, and formats typed results; bulk remains sequencing of single jobs.
- Desktop maps typed commands to native handles and streams snapshots through a per-job Tauri channel.
- Delete dummy discovery, transient cancellation engines, synthetic desktop lifecycle transitions, `k=v` parsing, JSON-in-string event details, and generic `(command, job, arg)` routing.
- Retain window ownership checks and opaque published-output references for open/reveal.
- Move Native Messaging away from desktop `JobTable` machinery. Validated handoff launches the same native runner.
- Preserve credential scope/consent/replay rules; use a single exact handoff revision.

### B5. Delete redundant native APIs and measure the actual path

- Remove the old `NativeRuntime`/`JobHandle` wrapper, redundant scheduler/pool, duplicate retry counters, and string-map pipeline event vocabulary once their callers migrate.
- Replace theoretical streaming-memory assertions and benchmark-only execution with actual runner instrumentation/measurements.
- Keep useful encoder tests; compare decoded pixels and metadata rather than unnecessarily pinning compressed byte sizes.

### B acceptance

- CLI, desktop, and Native Messaging all create one real engine job per request.
- Native connection reuse is exercised by a controlled server, not inferred from configuration.
- One slow tile does not stop unrelated non-overlapping work from completing.
- Peak memory includes canvas, outstanding decoded images, and codec buffers; measurements run the shipped pipeline.
- Cancellation cannot delete a pre-existing or independently-created destination.
- Typed IPC payloads round-trip without aliases or internal string parsing.
- All native encoders, local inputs, partial siblings, cache resume, and credential-scope fixtures retain behavior.

## 7. Workstream C: shared browser job execution and product integration

### C1. Reproduce browser problems on production code

- Read browser-runtime, extension, security, protocol, compatibility, and testing contracts.
- Add package-local tests for permanent/transient failure attempt counts, partial in-flight outcomes, actual abort, worker disposal, and display-only restrictions.
- Inventory production callers before removing alternate canvas/encoder/cache APIs. Send D the list of affected root tests and the behavioral assertions to preserve.
- Give D browser service requirements and required app-model interface feedback immediately.

### C2. Build one browser job service

- Implement the agreed `JobService` contract over A's engine binding.
- Own engine worker, decode/processing calls, pending promises, abort scope, assembly, and disposal in one factory.
- Update website and extension to inject their transport/product actions instead of constructing parallel orchestration.
- Remove host-side deferred job recreation and selection algorithms once A's engine policies are ready.
- Report typed outcomes, including display-only and permanent decode failures, without copying tile bodies into WASM for acknowledgment.
- Use transferable ownership deliberately. A transferred buffer detaches from its sender; do not retain code that expects to reuse it. Copy only where a real second owner requires it.
- Replace string-built worker code with packaged modules and keep the visible canvas in the page.

### C3. Consolidate transports and cancellation

- One-attempt acquisition routes feed the engine's retry policy.
- Preserve website direct-first public metadata fetch, bounded automatic proxy fallback, visible transport changes, and no tile proxying.
- Consolidate duplicate page-side proxy admission gates into one owner. The server's independent abuse/security limits remain authoritative at that trust boundary.
- Replace the website's no-op fetch cancellation with a real job-scoped AbortController propagated through reads, waits, and proxy operations.
- Preserve extension source-document identity, activeTab/optional grants, source-origin versus extension-origin routing, and explicit user-gesture permission requests.
- Keep permission suspension as a pending runtime operation with presentation status; do not fabricate a second engine phase machine.
- Retain ordinary image display only for recipes that do not require readable bytes; once tainted, no pixel reads or encode attempts occur.

### C4. Remove obsolete browser implementations

- Delete the hand-written PNG/DEFLATE/save path if production reachability remains absent.
- Delete unused alternate readable/display surfaces, old `createWebIntegration`, old catalog helper shapes, and optional cache machinery without production consumers.
- Consolidate small helpers required by both browser products into runtime modules; move view-only helpers out via requests to D.
- Remove broad barrel exports of deleted/internal machinery and update actual consumers.

### C5. Integrate website/extension and converge website source

- Website and extension consume the common job service and D's shared model/UI.
- Reduce product entry points to mounting, URL/source input, transport/product actions, and configuration.
- Coordinate extension native handoff with B's exact revision and A's declarations.
- Move website sources into `apps/web` in coordination with D's Vite/build/test path updates. C owns source moves; D owns root tooling changes.
- Work with D on legacy parity fixtures. At the agreed deployment checkpoint, remove legacy application/proxy source and implement the single new website entry.
- Keep `/beta` navigation compatibility as a simple URL redirect preserving useful query/fragment state. This is navigation behavior, not an old job protocol implementation.

### C acceptance

- Website and extension share one browser job implementation.
- All ordinary tile successes acknowledge with small typed outcomes, not body copies into WASM.
- Abort/disposal tests prove pending operations settle and retired jobs cannot mutate a successor.
- Attempt counts match engine policy and direct/proxy route policy remains explicit.
- Both packaged extension browsers pass source-binding, permissions, credential, and real-save/display-only scenarios.
- No production custom PNG compressor or unused alternative execution path remains.
- One website source is ready for D's deployment cutover.

## 8. Workstream D: shared model/UI, desktop frontend, and coordinated integration

### D1. Establish the acceptance matrix and build foundations

- Read architecture, testing, shared UI guidelines, native/browser/extension contracts, releases, and operations.
- Preserve the existing scenario corpus and establish behavioral acceptance scenarios listed in section 9. Coordinate local regression fixtures from A/B/C into the shared corpus where useful.
- Publish the app-model service interface early and freeze its initial shape with B/C.
- Update root workspace membership/dependency declarations and lockfiles in response to agent requests. Own package setup and generated-file registration.
- Establish unique artifact paths and a predictable compatible WASM publication/build procedure.

### D2. Extract the shared application model

- Create `packages/app-model` with a job service interface, latest-snapshot store, sequential queue, and shared history behavior.
- Keep it host-neutral and React-free. Host storage, OS actions, and browser globals are injected by product integrations.
- Use one job identity/revision guard at the asynchronous subscription boundary.
- UI-local state includes drafts, expanded diagnostics, preview controls, and settings; it does not reconstruct engine phases.
- Keep queue failures isolated and retain cancel-one/cancel-all/retry semantics across graphical products.

### D3. Render shared UI directly from snapshots

- Replace `controller.ts` lifecycle transitions with snapshot presentation.
- Delete synthetic preflight/save/selection event walks.
- Keep shared visual identity, accessibility, responsive layout, localization, and user-facing documentation conventions.
- Move genuinely shared presentation helpers away from browser-runtime dependencies.
- Ensure any valid terminal snapshot renders correctly even when earlier snapshots were not observed.
- Keep incomplete/display-only/native-published output distinctions visible and truthful.

### D4. Implement the desktop frontend service

- Use B's typed start/control/open/reveal commands and per-job channel.
- Remove hand-written duplicate IPC payload schemas, legacy aliases, private `__TAURI_INTERNALS__` access, and validation-only success fallback from production integration.
- Use the public Tauri API and explicit test doubles in tests.
- Preserve configured-folder saving, settings persistence, queue/history, deep-link confirmation, diagnostics, and published-output actions.
- Remove obsolete destination flow UI with B when no shipped caller remains.

### D5. Update tests to cover production boundaries

- Rewrite root tests affected by C's deletion of alternative browser implementations.
- Keep useful pixel/taint/credential assertions but execute them through real assembly/transports/services.
- Update desktop Node and real-window tests to B's IPC and the new model.
- Keep deterministic engine scheduling tests with A; normalize concurrency in cross-runtime tests and assert output, attempts, cleanup, and decisions rather than incidental event spelling/order.
- Replace tests preserving compatibility shims and function-name substrings with dependency/import checks and real generated-type round trips.

### D6. Simplify tooling, deployment, and documentation

- Update Cargo/TypeScript dependency checks for the final graph; forbid effects in engine and host imports in app-model/shared UI.
- Update xtask lanes and build prerequisites so shared work runs once per aggregate invocation. Coordinate protocol generation changes with A, who owns that module.
- Update Vite/WXT/website test paths for C's website source move.
- After parity, deploy one website at `/`, remove legacy copying and proxy routing, and implement the `/beta` redirect with C.
- Update generated capabilities from actual implementations, release checks, installation/native-host integration, and affected documentation/AGENTS rules.
- Documentation describes present implementation. Remove stale claims about spill support, encoders, simulated lifecycle, or compatibility guarantees.

### D7. Run final integration and collect evidence

- Coordinate a quiet checkpoint and execute section 10's full verification.
- Route failures to owners instead of patching foreign files.
- Collect per-agent deletion lists and before/after measurements.
- Verify the final graph has no old crate/package imports, old message aliases, duplicate job engines, dead alternative runtimes, or legacy deployed application.

### D acceptance

- Shared UI renders one authoritative snapshot without synthetic lifecycle events.
- Website/extension/desktop share application model behavior while product-only actions remain injected.
- Desktop receives typed snapshots and real publication results over the public Tauri API.
- Architecture gates enforce ownership rather than filename/function spelling.
- Aggregate tests/builds use the new workspace and declarations without manual steps.
- Deployment produces one website and one metadata proxy.
- Documentation, generated capabilities, tests, and actual runtime behavior agree.

## 9. Concurrent schedule and dependency checkpoints

All agents work concurrently. Checkpoints coordinate shared interfaces and generated artifacts; they are not four sequential implementation phases.

### Checkpoint 0: start all four agents

- A: engine regression tests and API draft.
- B: native behavior tests, runner/IPC draft, transport/output preparation.
- C: browser regressions, dead-path inventory, transport/cancellation cleanup.
- D: acceptance matrix, app-model draft, workspace/build setup.

Each publishes cross-owner requests early. No agent waits idle for a complete implementation from another agent: it works on owned internals/tests using narrow test doubles of the agreed interface.

### Checkpoint 1: contract publication

A publishes compilable engine types and generated declarations. B publishes native/IPC/handoff declarations. D publishes app-model service types. All four confirm imports and semantics before deeper consumer migration.

Contract examples must include:

1. Metadata request, supplied bytes, catalog, selection, tile, finalization, terminal result.
2. Deferred image resolution without a new job ID.
3. HTTP 403 with no automatic retry.
4. Transient failure, timer, retry, and pause/resume.
5. Partial decision with full in-flight accounting and retry.
6. Cancellation before and after the output commit point.
7. Extension permission suspension and display-only result.

If a proposed representation makes one of these awkward, adjust it once at this checkpoint rather than add per-product exceptions later.

### Checkpoint 2: two runtime slices and one UI slice

- A/B: one native fixture saves through the new engine and runner.
- A/C: the same readable browser fixture saves through the new binding/service.
- B/D: desktop start and terminal snapshots flow through the typed channel and shared UI.
- C/D: website/extension mount the shared model and render progress/terminal snapshots.

Compare actual requests, decoded pixels, failure categories, and cleanup. Differences in transport or codec output bytes are not automatically engine parity failures.

### Checkpoint 3: remove superseded paths

Owners delete old implementations once all their consumers switch. D switches workspace/build references and root tests; A publishes bindings; B/C remove old runtime callers. No old-schema translator is retained to make this checkpoint easier.

Legacy website removal is a separate coordinated product cutover at this checkpoint only after its required behaviors have replacement fixture coverage. C removes source; D removes deployment support.

### Checkpoint 4: stable verification

Pause edits, refresh approved generated artifacts and lockfiles through their owners, then run the full matrix. Fix by ownership, repeat affected checks, and run final aggregates on the final stable tree.

## 10. Acceptance scenarios and verification

### Required behavior matrix

| Scenario | Primary implementation owner | Verification cooperation |
|---|---|---|
| Known-size IIIF/DZI pixels | A/B/C | D shared fixture and product E2E |
| Deferred manifest and selection defaults | A | B/C execution, D UI |
| Probe geometry and retained probe output | A | B/C runtime pixel assertions |
| Processing-required tile | A/C/B | D browser/native scenario |
| 403 one attempt; transient exact budget | A | B/C request-count assertions |
| Failed tile with successful in-flight peers | A | B/C real runner regression |
| Partial retry/keep/discard | A | B output naming, C browser result, D presentation |
| Pause during retry timer | A | B/C timer execution |
| Cancellation during fetch/decode/finalize | A/B/C | D actual product paths |
| Display-only without pixel reads/encode | C | D real browser test |
| Local file/cache/ICC/EXIF/encoder behavior | B | D native fixtures and desktop journey |
| Atomic output and cancellation commit race | B/A | D filesystem/product assertions |
| Source binding, permission gesture, redirects | C | D shared fixture server |
| Consent, cookie scope, handoff mismatch/replay | B/C | A declarations, D native-messaging lane |
| Queue/history/settings and terminal-only render | D | B/C job services |

### Focused checks during implementation

Use narrow owning lanes, with build-producing xtask commands coordinated because they can regenerate shared artifacts:

- A: engine/core/job/protocol/WASM tests and fresh generated-binding harness.
- B: native and CLI tests, desktop Rust tests, Native Messaging framing/consent/scope tests.
- C: browser-runtime and extension package units, then packaged Chromium/Firefox integration.
- D: app-model/shared UI/desktop frontend units, website and desktop real-window integration.

D updates target names when crates move. Direct Cargo/Node package tests are appropriate for isolation. Agent-owned focused builds use separate output directories and locked dependencies after the dependency checkpoint.

### Final checks on a stable tree

```sh
cargo xtask check
cargo xtask test
cargo xtask test all
cargo xtask ci local
cargo xtask test desktop --e2e-window
```

Run supported desktop installer/window gates on their respective operating systems. Report unavailable platforms or prerequisites explicitly rather than marking those gates passed. Live source-site checks remain the existing opt-in `cargo xtask test live --public` lane and are not a substitute for deterministic coverage.

### Measurements

Measure before and after using controlled fixtures and the actual production path:

- Attempt count for permanent and transient failures.
- Engine scheduling cost versus tile count, including a large generated grid.
- Cross-worker message count and total body bytes entering WASM for ordinary and processed tiles.
- Peak native RSS/retained decoded tile count during assembly and encoding.
- Connection reuse and throughput with one deliberately slow tile.
- Time to cancellation/quiescence in fetch, decode, and finalization phases.
- Actual graph/build prerequisites and redundant generation/test invocations.

Keep hard gates deterministic where possible; report timing/RSS distributions with environment details rather than inventing universal performance guarantees. Do not assert a line-count reduction until measured. Deletion and ownership are more important than a chosen percentage.

## 11. Definition of done

- One business lifecycle implementation and one authoritative effect-correlation boundary.
- One retry budget/delay policy and one deferred-resolution implementation.
- One shared browser job implementation and one native runner used by all native entry points.
- Zero tile-body transfers solely to acknowledge successful acquisition.
- Zero internal progress/error string parsing to recover structured data.
- Zero synthetic UI transition walks to catch up to actual state.
- Zero old-schema aliases/translators or unused alternative runtime implementations.
- One deployed website implementation and one metadata proxy.
- Typed, truthful results distinguish partial, display-only, browser save initiation, and native publication.
- Real cleanup/publication/cancellation behavior is covered at runtime boundaries.
- All four agents stay within their owned file sets; shared worktree verification is performed on the final quiet tree.

Each agent's final report includes: owned files changed/deleted, the completed acceptance criteria, commands and actual results, any measurements, outstanding cross-owner requests, and remaining limitations. The coordinating agent combines those reports and verifies that no temporary scaffolding or duplicate ownership survives.

## 12. Expected maintenance outcome

- Adding a format changes one engine format module, registry registration, and fixtures.
- Adding a native encoder changes native output code and generated capabilities.
- Changing retry policy changes engine policy and engine tests.
- Adding a recovery action changes one typed contract and presentation handlers.
- Fixing browser job execution fixes website and extension through the shared runtime.
- Moving internal files no longer requires updating source-spelling architecture assertions.

The highest-value work is eliminating duplicated lifecycle, correlation, retry, and output ownership. Directory moves make that ownership visible after it is real; they are not the simplification by themselves.
