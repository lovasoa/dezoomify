# @dezoomify/app-model

Host-neutral application model for Dezoomify jobs. React-free and
host-global-free: no `window`, `document`, `fetch`, `chrome`, `tauri`,
`localStorage`, or canvas access. Hosts inject effects (a `HostRunner`),
storage (a `HistoryStore`), and clocks; the shared UI renders authoritative
snapshots.

## Contents

- `types.ts`: the frozen service contract: `JobService`, `JobHandle`,
  `JobObserver`, `JobStartRequest` (engine options plus the discriminated
  product-local `ExecSpec`), `JobSnapshot`, `HostStatus`, and `HostRunner`.
  Cross-language types come from `@dezoomify/wasm-bindings` and are never
  redeclared here.
- `snapshot.ts`: deterministic fold from ordered `JobEvent`s to the
  authoritative `JobSnapshot`. Terminal outcomes are set exactly once; late
  events after a terminal outcome are dropped.
- `store.ts`: latest-snapshot store with identity and revision guards.
  `subscribe`/`getSnapshot` match the `useSyncExternalStore` shape.
- `queue.ts`: sequential FIFO queue over the single-job engine. Failures
  are isolated and retained; cancel-one/all and retry never disturb other
  entries.
- `history.ts`: shared last-20 job history ledger over an injected store.
- `labels.ts`: canonical transport labels and save-name helpers (lowest
  layer; every product renders through these, never a local duplicate).
- `service.ts`: `createJobService(runner)`: the `JobService` with identity
  and revision guards at the async subscription boundary.

## Rules

- No React imports; no host globals. The architecture gate enforces this.
- UI-local drafts (expanded diagnostics, preview toggles, settings forms)
  stay in the product; they are never job phases.
- Snapshots are absolute. The shared UI renders the latest snapshot and
  never reconstructs phases from event walks.
