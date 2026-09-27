# @dezoomify/app-model

Host-neutral application model for Dezoomify jobs. React-free and
host-global-free: no `window`, `document`, `fetch`, `chrome`, `tauri`,
`localStorage`, or canvas access. Products implement `JobService` and inject
storage (a `HistoryStore`) and clocks; the shared UI renders authoritative
snapshots.

## Contents

- `types.ts`: the frozen service contract: `JobService`, `JobHandle`,
  `JobObserver`, `EngineStartRequest`, and `JobSnapshot`. Services are generic
  over the concrete start request and handle; runtime faults remain separate
  from authoritative engine snapshots.
  Cross-language types come from `@dezoomify/wasm-bindings` and are never
  redeclared here.
- `snapshot.ts`: pure predicates over the authoritative `Snapshot`
  (`isTerminalSnapshot`/`isActiveSnapshot`). The engine owns all job state;
  nothing here folds events or assigns revisions.
- `history.ts`: shared last-20 job history ledger over an injected store.
- `labels.ts`: canonical transport labels and save-name helpers (lowest
  layer; every product renders through these, never a local duplicate).
- `service.ts`: shared request validation for concrete `JobService`
  implementations. Transport-edge services own identity and revision guards.

## Rules

- No React imports; no host globals. The architecture gate enforces this.
- UI-local drafts (expanded diagnostics, preview toggles, settings forms)
  stay in the product; they are never job phases.
- Snapshots are absolute. The shared UI renders the latest snapshot and
  never reconstructs phases from event walks.
