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
  increases on every engine transition; runtimes drop stale revisions at
  the transport edge before they reach any product.
- `isTerminalSnapshot`/`isActiveSnapshot` are pure predicates over absolute
  snapshots: terminals are set exactly once by the engine, observers settle
  on them, and nothing here folds events or assigns revisions.
- `HostStatus` is presentation only (transport, permission, output). It is
  never a phase machine; phases come from snapshots. The initial status is
  neutral (no transport, no permission implied, output pending) until the
  first host emission replaces it.
- The shared FIFO queue owns activation, advancement, cancellation, retry, and
  status totals for products with one active engine job. Products validate
  inputs and keep their queue payloads, progress, and presentation metadata.
- Shared history keeps the last 20 jobs with full addresses over an
  injected store. History never leaves the device; only http(s) addresses
  are kept and bad payloads parse to an empty list.
- Transport labels and save-name helpers live here as the lowest layer.
  Every product renders through them, never a local duplicate.
- UI-local state (draft inputs, expanded diagnostics, preview toggles,
  settings forms) stays in the product. It is never a job phase.

Desktop startup waits for all event subscriptions before invoking the host.
While a start reply is pending, the service keeps the latest absolute host
snapshot per job and delivers it once the reply supplies that job's ID.
This covers jobs that fail or finish before the IPC reply arrives without
inventing a local phase or replaying intermediate transitions.

## Ownership

`packages/app-model` owns the service interface, snapshot predicates, shared
FIFO queue semantics, history, and canonical labels and save-name helpers.
Products own input validation, queue payloads, progress metadata, their
`HostRunner` (browser assembly, native runner, desktop IPC), and mount the
shared UI. The architecture gate forbids host globals, React, and runtime
imports in this package.
See [Architecture](architecture.md) and the
[acceptance matrix](acceptance-matrix.md).
