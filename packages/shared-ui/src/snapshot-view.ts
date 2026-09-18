// Snapshot presentation: shared UI renders authoritative JobSnapshots.
// Pure and host-neutral (no React, no host globals). This module replaces
// the controller transition table: instead of walking synthetic preflight,
// save, and selection events, the UI derives one presentation from the
// latest snapshot. Every terminal snapshot yields a complete terminal
// presentation even when the catalog or progress never arrived.
//
// User copy travels as i18n keys plus vars; the view renders them through
// `t()`. Counts, labels, and gap ledgers stay literal data.

import type {
  CatalogDto,
  ErrorDto,
  JobSnapshot,
  JobState,
  RecoveryAction,
} from "@dezoomify/app-model";
import { renderTransportLabel, splitGapLedger } from "./components.ts";

export type SnapshotPhase = "idle" | "job" | "display-only" | "completed" | "failed" | "cancelled";

export interface SnapshotImageOption {
  index: number;
  title?: string;
  width?: number;
  height?: number;
}

export interface SnapshotLevelOption {
  index: number;
  width: number;
  height: number;
}

export type SnapshotSelection =
  | { kind: "image"; options: SnapshotImageOption[] }
  | { kind: "level"; options: SnapshotLevelOption[] }
  | { kind: "recovery"; generation: number; actions: RecoveryAction[] };

export interface SnapshotTerminal {
  kind: "completed" | "partial-completed" | "failed" | "cancelled";
  error?: ErrorDto;
  /** Honest tile account; null when the job never reached tile work. */
  output?: {
    doneTiles: number;
    totalTiles: number | null;
    failedTiles: number;
    partial: boolean;
    missingTiles: string[];
  };
  gapShown?: string;
  gapRest?: number;
  gapCount?: number;
}

export interface SnapshotPresentation {
  phase: SnapshotPhase;
  /** i18n key for the headline step line. */
  headlineKey: string;
  headlineVars?: Record<string, string | number>;
  progress: { current: number; total: number | null } | null;
  paused: boolean;
  selection: SnapshotSelection | null;
  terminal: SnapshotTerminal | null;
  transportLabel: string | null;
  canCancel: boolean;
  canReset: boolean;
  /** True while tiles show as ordinary images with no byte access. */
  displayOnly: boolean;
  /** True for kept partials: finished, but with named gaps. */
  partial: boolean;
}

function imageOptionsOf(catalog: CatalogDto | null): SnapshotImageOption[] {
  if (!catalog) return [];
  const out: SnapshotImageOption[] = [];
  catalog.entries.forEach((entry, index) => {
    if (entry.kind === "image") {
      const option: SnapshotImageOption = { index };
      if (typeof entry.title === "string" && entry.title !== "") option.title = entry.title;
      if (entry.width > 0) option.width = entry.width;
      if (entry.height > 0) option.height = entry.height;
      out.push(option);
    }
  });
  return out;
}

function levelOptionsOf(catalog: CatalogDto | null, image: number | null): SnapshotLevelOption[] {
  if (!catalog || image === null) return [];
  const entry = catalog.entries[image];
  if (!entry || entry.kind !== "image") return [];
  return entry.levels.map((level, index) => ({
    index,
    width: level.width,
    height: level.height,
  }));
}

function headlineForState(state: JobState): { key: string; vars?: Record<string, string | number> } {
  switch (state) {
    case "Created":
    case "Discovering":
      return { key: "view.step.discovering" };
    case "AwaitingImageSelection":
      return { key: "view.step.choosingImage" };
    case "AwaitingLevelSelection":
      return { key: "view.step.choosingLevel" };
    case "Planning":
      return { key: "view.step.preflighting" };
    case "AcquiringTiles":
      return { key: "view.step.downloading" };
    case "AwaitingPartialDecision":
      return { key: "view.step.saving" };
    case "Finalizing":
      return { key: "view.step.saving" };
    case "Cancelling":
      return { key: "view.step.working" };
    case "Completed":
    case "PartiallyCompleted":
      return { key: "view.done.ready" };
    case "Failed":
      return { key: "view.fail.title" };
    case "Cancelled":
      return { key: "view.cancel.title" };
  }
}

function terminalOf(snapshot: JobSnapshot): SnapshotTerminal | null {
  const terminal = snapshot.terminal;
  if (!terminal) return null;
  const presented: SnapshotTerminal = { kind: terminal.kind };
  if (terminal.error) presented.error = terminal.error;
  if (snapshot.output) {
    presented.output = {
      doneTiles: snapshot.output.doneTiles,
      totalTiles: snapshot.output.totalTiles,
      failedTiles: snapshot.output.failedTiles,
      partial: snapshot.output.partial,
      missingTiles: snapshot.output.missingTiles.slice(),
    };
    if (snapshot.output.missingTiles.length > 0) {
      const gap = splitGapLedger(snapshot.output.missingTiles);
      presented.gapShown = gap.shown;
      presented.gapRest = gap.rest;
      presented.gapCount = gap.count;
    }
  }
  return presented;
}

/**
 * Derive the full presentation for one authoritative snapshot. Total: every
 * snapshot, including terminals without catalog or progress, yields a
 * renderable presentation.
 */
export function presentSnapshot(
  snapshot: JobSnapshot,
  transport: string | null,
): SnapshotPresentation {
  const terminal = terminalOf(snapshot);
  const partial = snapshot.terminal?.kind === "partial-completed";
  const displayOnly = snapshot.displayOnly && terminal === null;
  let phase: SnapshotPhase = "job";
  if (terminal) {
    if (terminal.kind === "completed" || terminal.kind === "partial-completed") phase = "completed";
    else if (terminal.kind === "failed") phase = "failed";
    else phase = "cancelled";
  } else if (displayOnly) {
    phase = "display-only";
  }

  let selection: SnapshotSelection | null = null;
  if (!terminal) {
    if (snapshot.state === "AwaitingImageSelection") {
      selection = { kind: "image", options: imageOptionsOf(snapshot.catalog) };
    } else if (snapshot.state === "AwaitingLevelSelection") {
      selection = {
        kind: "level",
        options: levelOptionsOf(snapshot.catalog, snapshot.selection.image),
      };
    } else if (snapshot.state === "AwaitingPartialDecision" && snapshot.recovery) {
      selection = {
        kind: "recovery",
        generation: snapshot.recovery.generation,
        actions: snapshot.recovery.actions,
      };
    }
  }

  const headline = headlineForState(snapshot.state);
  const progress =
    snapshot.total !== null || snapshot.acquired > 0
      ? { current: snapshot.acquired, total: snapshot.total }
      : null;

  return {
    phase,
    headlineKey: displayOnly ? "view.display.title" : headline.key,
    ...(headline.vars ? { headlineVars: headline.vars } : {}),
    progress,
    paused: snapshot.paused,
    selection,
    terminal,
    transportLabel: transport === null ? null : renderTransportLabel(transport),
    canCancel: terminal === null && snapshot.state !== "Cancelling",
    canReset: terminal !== null,
    displayOnly,
    partial,
  };
}

/** Idle presentation before any job starts. */
export function presentIdle(): SnapshotPresentation {
  return {
    phase: "idle",
    headlineKey: "view.idle.submit",
    progress: null,
    paused: false,
    selection: null,
    terminal: null,
    transportLabel: null,
    canCancel: false,
    canReset: false,
    displayOnly: false,
    partial: false,
  };
}
