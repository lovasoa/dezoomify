# Acceptance matrix

The simplification preserves behavior; this matrix maps each preserved
behavior to its deterministic corpus entry under `testdata/scenarios` and
its executable lane. Every entry runs without network access to public
sites; `cargo xtask test live --public` stays opt-in and advisory.

## Snapshot-driven UI

| Behavior | Corpus | Lane |
|---|---|---|
| Full job renders from snapshots, no synthetic events | `test/snapshot-view.test.mjs` | `cargo xtask test ui` |
| Snapshot fold happy path and display-only branch | `test/presentation.test.mjs` | `cargo xtask test ui` |
| Terminal renders without catalog or progress | `test/snapshot-view.test.mjs` (completed/failed/cancelled) | `cargo xtask test ui` |
| Kept partials name their gaps | `test/snapshot-view.test.mjs`, `testdata/scenarios/desktop/tile-failure-keep` | `cargo xtask test ui`, `cargo xtask test desktop` |
| Display-only vs readable-bytes distinction | `test/snapshot-view.test.mjs`, `testdata/scenarios/post-cutover/taint` | `cargo xtask test ui`, `cargo xtask test scenario` |
| Pause stops new work, keeps progress | `testdata/scenarios/job/pause-resume` | `cargo xtask test scenario` |
| Cancel before/after finalization settles after quiescence | `testdata/scenarios/job/cancel-midway`, `testdata/scenarios/desktop/cancel` | `cargo xtask test scenario`, `cargo xtask test desktop` |

## Service, queue, history

| Behavior | Corpus | Lane |
|---|---|---|
| Identity and revision guards at subscription boundary | `test/app-model.test.mjs` | `cargo xtask test app-model` |
| Sequential queue, isolated failures, cancel-one/all/retry | `test/app-model.test.mjs`, `testdata/scenarios/desktop/queue-basic`, `testdata/scenarios/desktop/queue-retry` | `cargo xtask test app-model`, `cargo xtask test desktop` |
| Shared last-20 history over injected storage | `test/app-model.test.mjs`, `test/history.test.mjs` | `cargo xtask test app-model`, `cargo xtask test ui` |
| Canonical labels and save names | `test/app-model.test.mjs`, `packages/browser-runtime/test/naming.test.mjs` | `cargo xtask test app-model`, `cargo xtask test browser` |

## Desktop frontend

| Behavior | Corpus | Lane |
|---|---|---|
| Typed start/control/open/reveal over public Tauri API | `apps/desktop/tests/job-service.test.mjs` | `cargo xtask test desktop` |
| Folder saving, settings, queue, deep-link confirm | `testdata/scenarios/desktop/basic`, `testdata/scenarios/desktop/destination-denied`, `testdata/scenarios/desktop/deep-link-reject`, `testdata/scenarios/desktop/handoff-deep-link` | `cargo xtask test desktop` |
| Real-window snapshots over the per-job channel | `cargo xtask test desktop --e2e-window` (explicit, needs a display) | separate |

## Engine and transports (owned by the engine and runtime owners)

| Behavior | Corpus | Lane |
|---|---|---|
| Metadata trace, deferred catalog, 403 handling | `testdata/scenarios/native/cli-deferred`, `testdata/scenarios/native/cli-deferred-limit`, `testdata/scenarios/web/iiif-discovery` | `cargo xtask test scenario`, `cargo xtask test web` |
| Transient retry, timers, partial in-flight accounting | `testdata/scenarios/native/edge-throttle-429`, `testdata/scenarios/native/cli-partial-keep` | `cargo xtask test scenario` |
| Permission-gated and display-only paths | `testdata/scenarios/extension/cookie-session`, `testdata/scenarios/web/assembly` | `cargo xtask test extension`, `cargo xtask test web` |
| Scoped handoff with revision match | `testdata/scenarios/extension/cookie-handoff`, `testdata/scenarios/desktop/handoff` | `cargo xtask test extension`, `cargo xtask test desktop` |
| Protocol error terminals and handshake | `crates/dezoomify-protocol` unit tests, `crates/dezoomify-wasm/tests/adapter.rs` terminal cases, `packages/wasm-harness/src/node.spec.mjs` | `cargo xtask test protocol`, `cargo xtask test wasm` |
| Scheduling scales with bounded in-flight slots (1/4/16/64/256-tile plans) | `crates/dezoomify-engine/tests/checklist.rs` (acquisition scaling), `crates/dezoomify-native/tests/perf.rs` (pipeline scaling) | `cargo xtask test job`, `cargo xtask test perf` |

## Deployment

| Behavior | Corpus | Lane |
|---|---|---|
| Legacy site serves `/`, the new app serves `/beta`, both proxies stay bound | `test/website-deploy.test.mjs` | `cargo xtask test web` |

## Reading the matrix

- A behavior is preserved when its corpus entry passes on the production
  path (engine plus host runner plus shared UI), not on a shim.
- Cross-runtime assertions compare output, attempts, cleanup, and
  decisions, never message spelling or event order.
- New behaviors add a corpus entry here in the same change that adds
  them. Local fixture data lives under the owning tree until it is
  promoted into the shared corpus.
