// Engine snapshot predicates: pure projections over the authoritative
// EngineSnapshotDto. The engine owns all job state; nothing here folds
// events, assigns revisions, or retains history. Terminals are set exactly
// once by the engine; observers settle on them.

import type { EngineSnapshotDto } from "@dezoomify/wasm-bindings";

/** True for snapshots the UI must render as finished (one terminal render). */
export function isTerminalSnapshot(snapshot: EngineSnapshotDto): boolean {
  return snapshot.terminal != null;
}

/** True while the job is actively awaiting input or running (not terminal). */
export function isActiveSnapshot(snapshot: EngineSnapshotDto): boolean {
  return snapshot.terminal == null;
}
