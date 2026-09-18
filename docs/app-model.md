# Application model

`packages/app-model` is the host-neutral application model for Dezoomify
jobs. It is React-free and host-global-free: no `window`, `document`,
`fetch`, `chrome`, `tauri`, storage, or canvas access. Hosts inject effects
(a `HostRunner`), storage (a `HistoryStore`), and clocks; the shared UI
renders authoritative snapshots.

## Contract

- `JobService` is the only way products start jobs:
  `start(request, observer)` returns a window-owned `JobHandle` with
  `command(UserCommand)` and `dispose()`. `UserCommand` is the generated
  `JobCommand` type, never a redeclared copy.
- `JobStartRequest` composes engine options (`SessionConfig`) with the
  discriminated product-local `ExecSpec`: `browser` for host assembly from
  readable bytes, `native` with a validated destination for host-written
  output. The discriminated shape is fixed: `browser` carries
  the `sourceUrl` data field, `native` carries the validated destination.
- `JobSnapshot` is absolute and authoritative. The shared UI renders the
  latest snapshot and never reconstructs phases from event walks. `revision`
  increases on every applied event; observers drop stale revisions and
  unknown job ids at the async subscription boundary.
- `applyJobEvent` is pure and total: terminal outcomes are set exactly
  once, late events after a terminal outcome are dropped, pause keeps the
  last progress values, and warnings stay bounded.
- `HostStatus` is presentation only (transport, permission, output). It is
  never a phase machine; phases come from snapshots. The initial status is
  neutral (no transport, no permission implied, output pending) until the
  first host emission replaces it.
- `OutputSummary` anchors to tile accounting, never to display state:
  `doneTiles` counts finalized tiles, `totalTiles` the planned total (null
  until the plan publishes one), `failedTiles` the tiles the engine gave
  up on, and `missingTiles` names the gaps behind a kept partial. `format`,
  `width`, and `height` are filled by host publication; the summary is
  null until a terminal success or kept partial. `partial` is true only
  for kept partials, so a partial save never reads as complete.
- The sequential queue runs one job at a time over the single-job engine.
  Failures are isolated and retained; cancel-one, cancel-all, and retry
  never disturb other entries.
- Shared history keeps the last 20 jobs with full addresses over an
  injected store. History never leaves the device; only http(s) addresses
  are kept and bad payloads parse to an empty list.
- Transport labels and save-name helpers live here as the lowest layer.
  Every product renders through them, never a local duplicate.
- UI-local state (draft inputs, expanded diagnostics, preview toggles,
  settings forms) stays in the product. It is never a job phase.

## Ownership

`packages/app-model` owns the service interface, the snapshot fold, the
latest-snapshot store, the sequential queue, shared history, and the
canonical labels. Products own their `HostRunner` (browser assembly,
native runner, desktop IPC) and mount the shared UI. The architecture
gate forbids host globals, React, and runtime imports in this package.
See [Architecture](architecture.md) and the
[acceptance matrix](acceptance-matrix.md).
