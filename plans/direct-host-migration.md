# Direct Host architecture migration

Status: proposed; this document does not execute the migration.

## Goal

Replace the command/effect orchestration with one asynchronous Rust algorithm,
one Host contract, and two behavioral Host implementations: TypeScript for the
website and extension, Rust for the CLI and desktop. Share the complete browser
application flow, including interactions and invocation lifetime.

The result is a substantially smaller implementation, not a second implementation
behind a selector, and not the existing engine moved behind new names. Aim for an
order-of-magnitude reduction in orchestration; verify the reduction against a
recorded baseline rather than promising the same reduction in parsers, codecs,
or other substantive functionality.

```text
website capabilities ─┐
                      ├─ shared browser application ─ BrowserHost (TypeScript)
extension capabilities┘                                  ↑ direct calls
                                                   shared async Rust
                                                         ↓ direct calls
CLI callbacks ────────┐
                     ├────────────────────────────── NativeHost (Rust)
desktop callbacks ───┘
```

Both products in each pair call the same Rust implementation. Rust defines the
Host signatures and crossing data types. Bindings generate JavaScript calls,
promise/future conversion, TypeScript declarations, and mechanical delegation.
They contain no policy, request scheduler, or second set of message shapes.

This plan covers the four modern products. Coordinate with
[the React/Vite plan](react-vite-migration.md) before changing overlapping files.
The independent [legacy retirement](legacy-retirement.md) plan owns the legacy
website deployment switch. Deleting that website does not count toward this
architecture's reduction.

## Principles and non-negotiable gates

1. **One implementation of each behavior.** Every landed revision has one
   production path per product and one shared implementation of discovery,
   selection, retries, and partial-output policy. No `v2` engine, runtime switch,
   shadow execution, or fallback to the retired engine.
2. **Move, connect, delete.** Extract existing useful code and replace all its
   callers in the same change. Do not copy a transport, parser, or application
   flow and promise to reconcile it later.
3. **Modules own work.** Discovery owns search and resource sharing; acquisition
   owns scheduling and retry policy; Hosts own platform operations; the shared
   browser application owns interaction and invocation lifetime. Modules do not
   introduce alternative representations of the same request or result.
4. **Ordinary async control flow.** Use calls, return values, futures, and scoped
   cancellation. Retain explicit domain state for ranking, budgets, missing
   tiles, and output decisions. Keep parsing and geometry pure. The orchestration
   awaits injected Host operations without ambient platform I/O.
5. **One authoritative lifetime.** A browser invocation owns its cancellation,
   pause gate, pending interactions, progress, and retirement. Hosts own concrete
   resources. Late completions cannot update a replacement invocation or publish
   abandoned output. Dropping a future alone does not cancel browser I/O.
6. **Inject actual differences.** Share the web/extension workflow. Inject input
   acquisition, transport policy, permission operations, save behavior, and
   optional toolbar integration. Do not inject separate interaction controllers
   or scatter product-name conditionals throughout shared code.
7. **Preserve behavior, retire internal contracts.** Keep URLs, headers, selected
   images, output, recovery, CLI behavior, and resource limits. Effect names,
   correlation tables, and internal command walks are implementation details.
8. **Deletion requires evidence.** Before removing a test with meaningful
   assertions, identify its surviving behavioral coverage. Assertions solely
   about a removed mechanism need no replacement.
9. **Update rules with code.** Architecture documentation, AGENTS.md, imports,
   lint boundaries, generated artifacts, and test-lane definitions change in
   the commit that changes the corresponding invariant. Do not weaken all
   boundary checks to make the new implementation pass.

The existing engine remains the sole orchestrator during preparation. Existing
effect handlers may call extracted Host methods during that period; this is one
existing path, not another implementation. All those handlers disappear at the
atomic cutover. There is no post-cutover compatibility phase.

## Sequence

Steps 1–4 are independently mergeable preparations. Step 5 is one atomic
orchestration replacement across all four products. Step 6 is its acceptance
gate, before the cutover lands. A multi-product migration one product at a time
would require parallel orchestration and is deliberately excluded.

### 1. Record the behavioral and size baseline

- [ ] Record the base commit, required check results, and production entry points
  for all four products. Recheck the baseline if unrelated work lands meanwhile.
- [ ] Audit actual consumers of Rust/WASM APIs before retiring them. Preserve
  documented CLI arguments/JSON, error codes, handoff input, persisted settings,
  and history. If an externally consumed API needs an intentional breaking
  release, record that explicitly rather than adding a compatibility engine.
- [ ] Extend [the acceptance matrix](../docs/acceptance-matrix.md) with each
  preserved behavior's existing test, target test, product entry point, and
  observable assertions. Record gaps rather than treating a lane's name as proof.
- [ ] Distinguish existing behavior from outstanding requests. In particular,
  check whether #1140's deferred permission recovery has landed. A missing
  feature is a named target requirement, not a falsely passing baseline test.
- [ ] Inventory source size, executable orchestration layers, state owners,
  crossing types, and correlation maps. Record separate totals for production,
  tests, documentation, bindings, and generator source/output. Include inline
  Rust tests in the test total. Renames and moves are not deletions.
- [ ] Record representative performance: in-flight requests/decodes, retained
  and spool bytes, output size/pixels, and large-plan scaling. Keep the existing
  native performance corpus and add only missing browser responsiveness evidence.

**Exit:** every important behavior has an owner and an identified executable
check; baseline failures are understood. The size baseline covers the entire
implementation, not just directories scheduled for deletion.

### 2. Establish tests that survive the architecture change

Do this against the current production implementation before replacing it.
Reuse the fixture server and `testdata/scenarios`; do not introduce another
fixture corpus or a second generic scenario framework.

- [ ] Promote orchestration-dependent user journeys to tests of actual products
  using the matrix below. Start with existing E2E tests and extend their gaps.
- [ ] Use browser controls, CLI arguments, saved artifacts, fixture-server
  observations, and real Tauri entry points. Tests do not instantiate an engine,
  inject HostEffect arrays, or call WASM Session completion methods.
- [ ] Separate scenario inputs and expected behavior from old command/effect
  transcripts. Remove obsolete transcript assertions when their behavioral
  replacements pass; replace their consumers together. Expected messages do not
  become a compatibility protocol for the new implementation.
- [ ] Use fixture barriers and explicit acknowledgements for races. Use a fake
  clock for exhaustive scheduling tests. Do not replace deterministic checks
  with sleeps, retries-until-green, or public websites.
- [ ] Share scenario setup and assertions between web and extension where the
  behavior is shared. Keep separate product entry points and platform-specific
  assertions so an extension test cannot accidentally exercise the website.
- [ ] Record the assertion-level disposition of mixed tests before deleting
  them: retained, moved to focused integration, promoted to E2E, or obsolete.
- [ ] For requirements absent at baseline, record fixtures and expected
  observations now and make their executable gates mandatory in the implementing
  cutover. Do not merge failing or permanently skipped tests into baseline lanes.

**Exit:** existing supported journeys pass unchanged at the product boundary.
Tests for explicit new requirements are identified separately and must pass at
cutover; they cannot be silently skipped. Public assertions survive replacement
of the engine, bindings, and application composition.

### 3. Consolidate the browser application using the existing execution path

- [ ] Extract the duplicated start/retry/cancel flow, invocation ownership,
  progress/output presentation, partial decisions, diagnostic controls, history,
  and queue handling into one browser application module. Web and extension
  both use it immediately.
- [ ] Build one interaction implementation. Permission actions invoke the
  injected browser permission operation synchronously from the actual click
  handler; no await or worker relay may consume user activation first.
- [ ] Reduce product entry points to capabilities and composition. Keep source
  document identity/invalidation in the extension capability. Share ordinary
  HTTP/body-reading helpers instead of duplicating transport mechanics.
- [ ] Keep host-neutral components and translations in `packages/shared-ui`.
  Put browser globals and invocation orchestration in the shared browser
  application. Preserve the shared UI guidelines and existing user-facing copy.
- [ ] Move useful queue/history/diagnostic helpers to their final owners without
  compatibility re-exports. Remove obsolete application wrappers when their
  last callers move. The existing browser execution entry point is called
  directly until step 5; do not add a new service interface around it.

**Delete in this step:** the corresponding duplicated bodies in `src/main.ts`
and `apps/extension/src/job/index.ts`, duplicate interaction/attempt state, and
tests which merely duplicate now-shared application logic. Keep the small
product bootstraps and platform operations.

**Exit:** both products run the same application flow; a shared interaction fix
has one implementation. Existing browser E2E gates pass, and this step is a net
production-code reduction after counting the new shared module.

### 4. Extract two Hosts and generate their common boundary

- [ ] Define the minimal Rust Host signatures and canonical argument/result
  types. Keep format parsing, retry classification, selection, and geometry as
  shared code rather than Host policy.
- [ ] Move concrete operations from existing native/browser effect execution
  into NativeHost and BrowserHost. Reuse the existing transports, decoders,
  canvas assembly, encoders, cache, and native sink. The old handler calls the
  extracted method; it does not keep a copy of its implementation.
- [ ] Make Host operations use the invocation scope for I/O abortion, pending
  interactions, and cleanup. Preserve native decode-tail accounting and the
  cancellation/publication ordering; preserve completed browser output until
  the user retires it.
- [ ] Use wasm-bindgen for imported methods and future/promise conversion and
  tsify for data types. wasm-bindgen does not directly implement an arbitrary
  Rust trait from a JS object: generate the declarations, TS interface, and
  delegating implementation from one narrowly scoped Host declaration.
- [ ] Prove the binding with a small real-WASM integration test, not another
  workflow: asynchronous success, structured rejection, invalid JS values,
  binary data, concurrent calls on distinct Host objects, and cancellation/late
  settlement. Compile the same contract for the native executor, including its
  threading requirements.
- [ ] Keep generated Rust glue in build output and regenerate the existing
  tracked binding tree through the real build. Do not add handwritten generated
  files, a general RPC framework, or parallel Host method lists.
- [ ] Establish deterministic Host fakes for subsequent algorithm tests. Fakes
  implement capabilities, not a simulated engine or effect interpreter.

**Delete in this step:** the extracted operation bodies and duplicate request,
response, and failure conversions from their previous locations. Existing
dispatch shells remain only until step 5. Delete any temporary binding probe
exports when the real invocation covers them.

**Exit:** exactly one implementation of each platform operation; both current
products per Host use it. Real generated bindings demonstrate the proposed async
boundary. Generator and bridge costs are included in the size report.

### 5. Replace orchestration and delete the old system atomically

Use a short-lived integration branch. Its intermediate work may not compile;
it is not a second releasable implementation. Do not merge partial native-only
or browser-only cutovers. Replace the old code in place, using git history for
reference instead of retaining an executable copy.

- [ ] Replace the engine entry point with the shared async invocation. Reuse
  existing format knowledge and pure algorithms; do not rewrite them simply
  to fit a new directory layout.
- [ ] Replace discovery's manual continuation machinery with the shared resource
  store and async resolvers. Preserve request identity/headers, redirected bases,
  branch-local context, deduplication, limits, and format-specific fallback.
  Remove the superseded discovery implementation in the same change.
- [ ] Separate discovery progress from winner selection. Bound concurrent work;
  retain precedence for earlier ordinary in-flight work; allow explicitly
  interaction-blocked branches to yield. Drain runnable work before deciding
  that only deferred access remains. Resolve waiting readers after interactive
  fetch without a permission-effect/completion/refetch protocol.
- [ ] Move selection, bounded tile acquisition, retry timing, pause, adaptive
  probing, and partial decisions into direct async functions. Preserve lazy tile
  generation and accounting across fetch, processing, decode, and placement.
- [ ] Await Host output completion and report its actual disposition. Preserve
  readable/display-only distinctions, partial naming, native publication, and
  useful failure context. Cancellation does not manufacture success or overwrite
  pre-existing files.
- [ ] Switch CLI and desktop directly to the async function with NativeHost.
  Replace the native effect pump with scoped task ownership. Keep only the
  desktop registry/IPC needed for actual process lifetime, controls, and output
  access; it has no alternate lifecycle or error vocabulary.
- [ ] Switch the shared browser application to the generated async function with
  BrowserHost. Delete Session dispatch, browser effect interpretation, and their
  worker relays. Retain useful decode/processing workers. Any remaining worker
  boundary carries actual cross-thread work, not another engine language.
- [ ] Preserve UI responsiveness and explicit user activation. Verify placement
  of CPU-heavy work rather than assuming that an async function makes parsing,
  processing, or encoding non-blocking.
- [ ] Replace old engine-driven unit harnesses with direct algorithm/Host tests.
  Run the unchanged product-level gates from step 2. Never route a new test
  through a compatibility Session or reconstruct effect messages for it.
- [ ] Complete the deletion table below, remove orphan exports/dependencies,
  regenerate bindings/artifacts, and update current architecture contracts in
  this same cutover. Remove the old packages once useful helpers have moved.

**Exit:** all four products execute the same new algorithm, both Hosts are live,
and no retired orchestrator or protocol remains reachable or compiled. Step 6
must pass before this change lands. There is no later engine-removal milestone.

### 6. Prove the simplification and accept the cutover

- [ ] Run the required validation gates below from the cutover revision, using
  freshly built artifacts. Confirm the desktop real-window result separately.
- [ ] Compare product observations against step 1: outputs, selection, request
  facts, failures, partials, cancellation, limits, and performance. Differences
  need a specific explanation; do not bulk-regenerate goldens to turn failures
  green. New deferred-access behavior is assessed against its named requirement.
- [ ] Audit all production entry points and the dependency graph. Confirm they
  call the shared async algorithm and the two Host implementations. Inspect
  source, generated declarations, and built artifacts for retired dispatch
  exports; a filename rename is not proof of removal.
- [ ] Verify the deletion table has no unfinished rows and no compatibility
  aliases, obsolete lane definitions, or dead test helpers remain.
- [ ] Publish before/after counts for production orchestration, all production
  code, tests, generated code, and generator source. Also report eliminated
  state owners, message families, and forwarding boundaries. Reject a nominal
  reduction achieved by moving code into another package or generated output.
- [ ] Require a substantial measured orchestration reduction and a net overall
  production reduction. Compare with the order-of-magnitude goal. If complexity
  has merely moved, simplify before merging; never drop behavior to meet a LOC
  quota. Explain genuine residual costs such as native image assembly.
- [ ] Update the root README with the resulting architecture. Remove this plan
  when its work is complete, following [the plans policy](README.md).

Rollback is a revert of the complete cutover to the last green prepared revision.
Do not add a runtime flag or ship the old engine as a rollback mechanism.

## Test migration: what survives, moves, and disappears

Classify assertions, not filenames. Several existing files mix valuable behavior
with checks of the soon-to-be-deleted protocol.

| Existing coverage | Disposition |
|---|---|
| Format fixtures, `core_parity.rs`, geometry, URL/header resolution, processing recipes | Keep as fast tests of the same algorithms; change invocation helpers only when needed. |
| `discovery_navigation.rs` and inline discovery history/order/budget tests | Preserve focused coverage against async discovery and fake Host resources; keep representative production journeys in E2E. |
| `engine_browser_selection.rs`, `engine_native_selection.rs`, retry classification | Keep behavioral assertions on the extracted functions; do not force every selection combination through a browser. |
| Useful assertions in `engine_workflows.rs`, `engine_checklist.rs`, `engine_adversarial.rs`, `engine_phase_data.rs`, `engine_engine_regressions.rs` | Move scheduling/race matrices to direct async tests; promote product outcomes using the matrix below. Delete the old engine-driving harness. |
| Effect ordering/IDs, wrong-kind completions, Session dispatch walks, duplicate-completion rejection, `engine_host_effects.rs` mechanism-only assertions | Delete with the machinery. Preserve any underlying user behavior, such as late work not affecting a replacement invocation, at its real owner. |
| WASM `tests/adapter.rs` and `packages/wasm-harness/src/node.spec.mjs` | Replace Session/effect tests with a compact real-built-WASM Host binding suite. Product tests cover full flows. |
| `browser-job-service.test.mjs`, `worker-disposal.test.mjs`, service/observer portions of `test/app-model.test.mjs` | Move lifetime guarantees to shared invocation/Host tests and cancel/retry E2E; delete forwarding assertions and old mocks. |
| Browser assembly, body limits, transport, decoding, drawing, diagnostics, proxy and extension source-access tests | Keep where they test real platform behavior. Reuse their implementation helpers and fixtures. |
| Snapshot/presentation tests, UI components, locales, history, queue, settings | Keep rendering/interaction assertions against the simplified view. Delete tests of redundant folds or obsolete presenters; move workflow ownership to the shared application. |
| Native `http_loopback.rs`, `pipeline_loopback.rs`, cache/local-input/output/performance coverage | Keep concrete I/O, artifact, bounded-memory, and publication assertions. Replace only engine-specific setup. |
| Native/desktop `job_service` tests | Keep actual task lifetime, Tauri transport, settings, output handles, and cancellation assertions; delete redundant service dispatch checks. |
| `core_purity.rs`, scoped lint boundaries, protocol artifact validation | Retarget to pure parsers/planning, platform isolation, and the single generated Host contract. Do not disable these checks wholesale. |

Delete a redundant test once the identified replacement passes on the live path.
Do not rewrite tests whose only subject is a deleted abstraction. Keep narrowly
targeted tests for invariants that product E2E cannot observe economically.

### Journeys that must survive the migration at the product boundary

| Behavior | Stable observation and execution boundary |
|---|---|
| Successful discovery and output | Submit through the website and packaged extension; run the actual CLI binary. Verify selected dimensions, decoded fixture pixels, and the real save result. Include a multi-document format and a format requiring processing. |
| Discovery precedence and context | Fixture documents with sibling frames, observations, redirects, signed queries, and required headers. Assert the selected image and required/forbidden requests. Do not assert incidental concurrent completion order. |
| Deferred permissions | Extension fixture with a blocked branch and an accessible winner makes no permission request. All-accessible-paths-exhausted fixture exercises the grant action, exact resumed read, denial, repeated block, and cancellation. Test source-document invalidation separately. |
| Website transport and ordinary image display | Direct success avoids proxy; eligible metadata fallback uses it; HTTP refusals do not. A tainted result stays visible without pixel readback/encoding or a false programmatic-save claim. |
| Retry and partial output | Fixture responses include 429/Retry-After, transient errors, and permanent 403. Assert bounded attempts, visible partial decision, retry of missing tiles only, and correct kept/discarded output through browser UI and CLI policy. |
| Pause/cancel/retry lifetime | Pause prevents new acquisitions while in-flight work settles; cancel aborts owned operations. Start a replacement while old I/O settles: no stale progress, permission action, drawing, or save reaches it. Use fixture barriers. |
| Selection limits and failures | Preserve automatic image/level selection, resolution-downgrade notice, maximum retry, canvas/output failures, and desktop handoff. Keep exhaustive selection tests below E2E. |
| Native publication and options | Actual CLI tests cover local resources, output formats, ICC/EXIF where supported, resume cache, naming, overwrite behavior, and partial policy. Focused native tests exercise cancel/commit races and decode-tail quiescence. |
| Desktop interactions | Real-window tests start work with selected settings, cancel, process a queue after a failure, handle partial output, and open/reveal the actual result over production Tauri IPC. |
| Packaging and presentation | Preserve assembled website routes/assets, actual WASM loading, extension permissions/CSP, desktop startup, shared translated controls, and the existing visual language. |

Use the existing website suite at
`crates/fixture-server/tests/webapp-e2e/`, packaged Chromium/Firefox suite at
`apps/extension/tests/browser/`, native loopback/CLI scenarios, and
`apps/desktop/tests/window-e2e/`. Add scenarios there, not in an architecture-
specific E2E suite that will need replacing again.

Product E2E may control external fixture responses and unavoidable browser API
test doubles. It may not replace the Rust invocation, Host algorithm, decoder,
or save implementation. Where native permission dialogs cannot be automated,
identify the permission API double explicitly and retain a real-browser check
of user-activation behavior; a mock alone does not prove the permission flow.

Expected image checks compare decoded pixels/geometry and required metadata,
using format-appropriate tolerances rather than incidental encoder byte layout.
Request checks preserve exact relevant URLs, queries, headers, counts, and
precedence constraints. Diagnostics retain existing bounded capture behavior.

## Required deletions at their owning step

| Current concept/location | Final disposition |
|---|---|
| Duplicated application flows in `src/main.ts` and `apps/extension/src/job/index.ts` | Removed in step 3; one shared browser application plus small capabilities. |
| `EngineJob`, inner `Job`, `engine_api.rs`, `engine/job.rs`, `engine/transition.rs`, engine-only state/config machinery | Removed in step 5. Move useful selection/retry/options code into direct algorithm modules; no facade aliases. |
| Manual discovery continuation/frontier implementation superseded by async resolution | Removed in step 5; retain useful ranking, parsing, budget, and deduplication logic once. |
| `JobEffect`, `HostEffect`, `HostCompletion`, `EffectResult`, `Outstanding`, effect/request ID translation tables | Removed in step 5. Retain genuine tile/resource identity; remove IDs used only to route ordinary call results. |
| `crates/dezoomify-wasm/src/session.rs` and Session/dispatch exports | Removed in step 5; generated function bindings to the actual algorithm and Host remain. |
| `browser-job-service.ts`, `engine-host.ts`, `worker-host.ts`, redundant `web-integration.ts` and engine-only dispatch helpers | Removed in step 5. Useful platform operations have already moved in step 4. |
| Native effect pump in `exec.rs` and lifecycle/policy forwarding in `job_service.rs` | Removed in step 5; retain concrete I/O and required native task/process ownership without a second orchestrator. |
| `packages/app-model` service/handle/observer abstractions and engine-specific snapshot wiring | Remove callers and move useful utilities in steps 3/5; remove the package, exports, dependency entries, and its obsolete lane at cutover. Preserve useful pure view predicates. |
| Old engine/Session scripted hosts, message goldens, forwarding mocks | Deleted with their subjects after the test-disposition gate; do not retain them under a new test helper name. |
| Obsolete generated protocol declarations/artifacts, build inputs, imports, dependencies, and docs | Regenerated or removed in step 5, including the corresponding validation rules and workflow inputs. |

Search for retired symbols and follow their callers, including re-exports and
generated bindings. Narrow architecture checks may prevent their reintroduction,
but actual entry-point execution and ownership review establish that they are
gone. Documentation and this plan can name retired concepts while explaining
their removal; a global text ban is not an architectural proof.

## Validation and documentation gates

For each mergeable implementation step, run the narrow owning lane while
iterating, then `cargo xtask check` and `cargo xtask test`. Finish with
`cargo xtask test all` and `cargo xtask ci local`, following repository policy.
Retarget or remove obsolete lane definitions with their code; preserve the
behavioral coverage in the aggregate commands.

For the cutover, also record:

- `cargo xtask test desktop --e2e-window` on a configured desktop test host.
  Neither `test all` nor `ci local` includes this gate. Missing desktop
  prerequisites leave the gate open; unit tests are not a substitute.
- `cargo xtask test perf --smoke` and relevant existing scaling checks.
- Production builds through `cargo xtask build web`, `cargo xtask build cli`,
  `cargo xtask build extension`, and
  `cargo xtask build desktop --unsigned-test`; confirm artifacts load the new
  path. Use configured CI hosts for platform-specific dependencies.
- A real WASM build and generated-declaration check through the existing
  protocol commands. No stale generated module may satisfy a test.

All regression gates use controlled fixtures. Public live tests remain opt-in
and advisory. Investigate baseline failures; do not hide them by skipping tests,
loosening expected outcomes, or reducing budgets.

Update `docs/architecture.md`, `docs/app-model.md`, `docs/job-engine.md`,
`docs/browser-runtime.md`, `docs/native-apps.md`, `docs/extension.md`,
`docs/protocol.md`, `docs/errors.md`, `docs/security.md`, `docs/testing.md`,
`docs/acceptance-matrix.md`, development/task documentation, and applicable
AGENTS.md rules at the step that changes them. Consolidate or remove obsolete
pages and repair links instead of leaving the old architecture as an alternate
contract. Keep current contracts in present tense; future design belongs here
until implemented. User-facing text remains sourced from `docs/user/`.
