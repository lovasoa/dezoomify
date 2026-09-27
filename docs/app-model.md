# Application model

`packages/app-model` is the host-neutral application model for Dezoomify
jobs. It is React-free and host-global-free: no `window`, `document`,
`fetch`, `chrome`, `tauri`, storage, or canvas access. Products implement
`JobService` and inject storage (a `HistoryStore`) and clocks; the shared UI
renders authoritative snapshots.

## Contract

- `JobService` is the only way products start jobs:
  `start(request, observer)` returns a window-owned `JobHandle` with
  `command(UserCommand)` and `dispose()`. `UserCommand` is the generated
  `JobCommand` type, never a redeclared copy.
- Concrete runtimes implement `JobService` directly when they own the full
  start boundary. The browser service validates requests, assigns job identity,
  forwards snapshots and separate runtime faults without a
  second service wrapper.
- `JobService<Request, Handle>` accepts a concrete runtime request. Browser
  starts carry `EngineStartRequest` inputs and engine options. Desktop starts
  carry an input URL and an immutable copy of the actual output settings;
  validation and IPC consume the same request, with no ambient settings callback.
- `JobSnapshot` is absolute and authoritative. The shared UI renders the
  latest snapshot and never reconstructs phases from event walks. `revision`
  increases on every engine transition; runtimes drop stale revisions at
  the transport edge before they reach any product.
- `isTerminalSnapshot`/`isActiveSnapshot` are pure predicates over absolute
  snapshots: terminals are set exactly once by the engine, observers settle
  on them, and nothing here folds events or assigns revisions.
- `JobObserver.failure(Error)` settles a runtime fault separately from engine
  snapshots. Runtime failures never manufacture an engine revision or terminal.
  Products own transport, permission, and output presentation directly.
- Each graphical product owns one current attempt. Its observer, asynchronous
  actions, activity timer, and cleanup check that ownership before changing the
  view, history, or queue. A retired attempt disposes late handles; a completed
  result keeps its output access until the result itself is retired.
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
Desktop snapshot events use one `{ job, snapshot }` envelope: `job` is the
sole routing identity and `snapshot` is the unmodified `Snapshot`.
While a start reply is pending, the service keeps the latest absolute host
snapshot per job and delivers it once the reply supplies that job's ID.
This covers jobs that fail or finish before the IPC reply arrives without
inventing a local phase or replaying intermediate transitions.

## Ownership

`packages/app-model` owns the service interface, snapshot predicates, shared
FIFO queue semantics, history, and canonical labels and save-name helpers.
Products own their concrete `JobService`, input validation, queue payloads,
progress metadata, and shared UI mount. The architecture gate forbids host
globals, React, and runtime
imports in this package.
See [Architecture](architecture.md) and the
[acceptance matrix](acceptance-matrix.md).
