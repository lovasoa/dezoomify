// Deterministic snapshot fold: JobEvents in, authoritative JobSnapshot out.
// Pure and total: no I/O, no clocks (callers pass `now`), no host globals.
// Terminal outcomes are set exactly once; events arriving after a terminal
// outcome are dropped (late safe). Pause stops progress accounting but never
// rewrites history: acquired/total keep their last values while paused.

import type { EngineSnapshotDto, JobEvent, JobState } from "@dezoomify/wasm-bindings";
import type {
  JobSelection,
  JobSnapshot,
  OutputSummary,
  TerminalOutcome,
} from "./types.ts";

function emptySelection(): JobSelection {
  return { image: null, level: null };
}

function terminalFor(event: JobEvent): TerminalOutcome | null {
  if (event.type === "completed") return { kind: "completed" };
  if (event.type === "partial-completed") return { kind: "partial-completed" };
  if (event.type === "failed") return { kind: "failed", error: event.error };
  if (event.type === "cancelled") return { kind: "cancelled" };
  return null;
}

function stateFor(event: JobEvent, current: JobState): JobState {
  switch (event.type) {
    case "job-state":
      return event.state;
    case "catalog":
      return current;
    case "progress":
      return current;
    case "warning":
      return current;
    case "recovery-request":
      return "AwaitingPartialDecision";
    case "completed":
      return "Completed";
    case "partial-completed":
      return "PartiallyCompleted";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "paused":
      return current;
    case "resumed":
      return current;
  }
}

/** First snapshot for a job. State is Created; nothing is selected. */
export function initialSnapshot(jobId: string, now: number): JobSnapshot {
  return {
    jobId,
    revision: 0,
    state: "Created",
    catalog: null,
    acquired: 0,
    total: null,
    paused: false,
    selection: emptySelection(),
    warnings: [],
    recovery: null,
    terminal: null,
    output: null,
    displayOnly: false,
    updatedAt: now,
  };
}

function withOutput(snapshot: JobSnapshot): OutputSummary | null {
  if (snapshot.terminal === null) return null;
  if (snapshot.terminal.kind === "cancelled" || snapshot.terminal.kind === "failed") {
    return null;
  }
  return {
    doneTiles: snapshot.acquired,
    totalTiles: snapshot.total,
    failedTiles: 0,
    partial: snapshot.terminal.kind === "partial-completed",
    format: null,
    width: null,
    height: null,
    missingTiles: [],
  };
}

/**
 * Apply one ordered engine event. Returns the next snapshot with revision+1,
 * or the identical snapshot reference when the event is late (after a
 * terminal outcome) and must not move the UI.
 */
export function applyJobEvent(snapshot: JobSnapshot, event: JobEvent, now: number): JobSnapshot {
  if (snapshot.terminal !== null) return snapshot;
  const terminal = terminalFor(event);
  const next: JobSnapshot = {
    ...snapshot,
    revision: snapshot.revision + 1,
    state: stateFor(event, snapshot.state),
    updatedAt: now,
    selection: { ...snapshot.selection },
    warnings: snapshot.warnings,
    recovery: snapshot.recovery,
    terminal,
  };
  switch (event.type) {
    case "catalog":
      next.catalog = event.catalog;
      break;
    case "progress":
      next.acquired = event.acquired;
      next.total = event.total;
      break;
    case "warning":
      next.warnings = [...snapshot.warnings, event.error].slice(-20);
      break;
    case "recovery-request":
      next.recovery = { generation: event.generation, actions: event.actions };
      break;
    case "paused":
      next.paused = true;
      break;
    case "resumed":
      next.paused = false;
      break;
    default:
      break;
  }
  next.output = withOutput(next);
  return next;
}

/**
 * Apply one absolute engine snapshot. The DTO carries lifecycle, progress,
 * decisions, and terminals; the catalog, warnings, and display-only flag
 * ride the event stream and are preserved. Terminals apply exactly once;
 * snapshots at or below the current revision are dropped.
 */
export function applySnapshotDto(
  snapshot: JobSnapshot,
  dto: EngineSnapshotDto,
  now: number,
): JobSnapshot {
  if (snapshot.terminal !== null) return snapshot;
  if (dto.revision <= snapshot.revision && snapshot.revision > 0) return snapshot;
  const next: JobSnapshot = {
    ...snapshot,
    revision: dto.revision,
    state: dto.lifecycle as JobState,
    acquired: dto.progress.completed,
    total: dto.progress.total ?? null,
    paused: dto.paused,
    selection: {
      image: dto.selection.image ?? null,
      level: dto.selection.level ?? null,
    },
    warnings: snapshot.warnings,
    recovery: dto.decision
      ? { generation: dto.decision.generation, actions: [] }
      : null,
    terminal: terminalForDto(dto),
    updatedAt: now,
  };
  next.output = withOutput(next);
  return next;
}

function terminalForDto(dto: EngineSnapshotDto): TerminalOutcome | null {
  const terminal = dto.terminal;
  if (!terminal) return null;
  if (terminal.type === "completed") return { kind: "completed" };
  if (terminal.type === "partial-completed") {
    return { kind: "partial-completed" };
  }
  if (terminal.type === "failed") return { kind: "failed", error: terminal.error };
  if (terminal.type === "cancelled") return { kind: "cancelled" };
  return null;
}

/** True for snapshots the UI must render as finished (one terminal render). */
export function isTerminalSnapshot(snapshot: JobSnapshot): boolean {
  return snapshot.terminal !== null;
}

/** True while the job is actively awaiting input or running (not terminal). */
export function isActiveSnapshot(snapshot: JobSnapshot): boolean {
  return snapshot.terminal === null;
}
