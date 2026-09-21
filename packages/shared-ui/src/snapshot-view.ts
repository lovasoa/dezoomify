// Snapshot presentation: shared UI renders authoritative JobSnapshots.
// Pure and host-neutral (no React, no host globals). This module is the
// single presentation contract: instead of walking synthetic preflight,
// save, and selection events, the UI derives one presentation from the
// latest snapshot. Every terminal snapshot yields a complete terminal
// presentation even when the catalog or progress never arrived.
//
// JobSnapshot is the generated EngineSnapshotDto verbatim: lifecycle,
// progress, selection, decision, terminal, and output are read exactly as
// the engine projected them. No legacy folded fields are accepted here;
// unknown job ids and stale revisions are dropped at the subscription
// boundary (the runner), never in this view.
//
// User copy travels as i18n keys plus vars; the view renders them through
// `t()`. Counts, labels, and gap ledgers stay literal data.

import type {
  ErrorDto,
  JobSnapshot,
  JobState,
} from "@dezoomify/app-model";
import { categoryFor } from "./failure.ts";
import { renderTransportLabel, splitGapLedger } from "./components.ts";
import { t, type I18nKey } from "./i18n.ts";

/**
 * The layered failure shape every product renders through the shared view:
 * plain headline in `message`, raw engine diagnostics in `detail`, stable
 * classification, and the optional on-device fetch context. Hosts build it
 * with `describeFailure`; snapshots project it from the generated ErrorDto.
 */
export interface StructuredError {
  code: string;
  category: string;
  retryable: boolean;
  message: string;
  /** Raw engine diagnostics (headline-free per-format bullet block); rendered only in the collapsible technical section. */
  detail?: string;
  transport?: string;
  phase?: string;
  /** Full request URL of the failed fetch; rendered verbatim in on-device details only. */
  url?: string;
  /** HTTP status of the failed fetch, when it is an HTTP refusal. */
  http?: number;
  /** Bounded single-line server signal captured from an HTTP error body. */
  preview?: string;
  /** Host-provided provenance lines (status, origin, resource kind), rendered after the trailing line. */
  extras?: string[];
}

export type SnapshotPhase = "idle" | "job" | "display-only" | "completed" | "failed" | "cancelled";

/** Host-reported step names for products that render without a snapshot yet. */
export type PresentationStatus =
  | "idle"
  | "discovering"
  | "choosing-image"
  | "choosing-level"
  | "preflighting"
  | "downloading"
  | "saving"
  | "display-only"
  | "completed"
  | "failed"
  | "cancelled";

/** Terminal view model: kind aliases the authoritative outcome; the rest is presentation-only ledger. */
export type SnapshotTerminal = {
  kind: "completed" | "partial-completed" | "failed" | "cancelled";
  error?: StructuredError;
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
};

export interface SnapshotPresentation {
  phase: SnapshotPhase;
  /** Engine job id; null before any job started. */
  jobId: string | null;
  /** Engine state name (or host step) for diagnostics; null when idle. */
  stateLabel: string | null;
  /** i18n key for the headline step line. */
  headlineKey: I18nKey;
  headlineVars?: Record<string, string | number>;
  /** i18n key for the detail line under the headline, when the state names one. */
  detailKey?: I18nKey;
  detailVars?: Record<string, string | number>;
  progress: { current: number; total: number | null } | null;
  paused: boolean;
  terminal: SnapshotTerminal | null;
  /** Raw transport code (diagnostics); `transportLabel` carries the display string. */
  transport: string | null;
  transportLabel: string | null;
  canCancel: boolean;
  canReset: boolean;
  /** True while tiles show as ordinary images with no byte access. */
  displayOnly: boolean;
  /** True for kept partials: finished, but with named gaps. */
  partial: boolean;
}

function headlineForState(state: JobState): {
  key: I18nKey;
  vars?: Record<string, string | number>;
  detail?: I18nKey;
  detailVars?: Record<string, string | number>;
} {
  switch (state) {
    case "Created":
    case "Discovering":
      return { key: "view.step.discovering", detail: "view.step.contactingDetail" };
    case "AwaitingImageSelection":
      return { key: "view.step.choosingImage" };
    case "AwaitingLevelSelection":
      return { key: "view.step.choosingLevel" };
    case "Planning":
      return { key: "view.step.preflighting" };
    case "AcquiringTiles":
      return { key: "view.step.downloading" };
    case "AwaitingPartialDecision":
      return { key: "view.step.saving", detail: "view.step.recoveryDetail" };
    case "Finalizing":
      return { key: "view.step.saving", detail: "view.step.encodingDetail" };
    case "Cancelling":
      return { key: "view.step.working", detail: "view.step.cleanupDetail" };
    case "Completed":
    case "PartiallyCompleted":
      return { key: "view.done.ready" };
    case "Failed":
      return { key: "view.fail.title" };
    case "Cancelled":
      return { key: "view.cancel.title" };
  }
}

/** Project the generated error DTO onto the layered view error. */
export function structuredErrorOf(error: ErrorDto): StructuredError {
  const presented: StructuredError = {
    code: error.code,
    category: categoryFor(error.code),
    retryable: error.retryable,
    message: error.message,
    phase: error.phase,
  };
  if (error.detail) presented.detail = error.detail;
  if (error.transport) presented.transport = error.transport;
  if (error.request) presented.url = error.request;
  if (typeof error.http === "number") presented.http = error.http;
  if (error.preview) presented.preview = error.preview;
  if (error.resource_kind) presented.extras = [`Resource: ${error.resource_kind}`];
  return presented;
}

function terminalOf(snapshot: JobSnapshot): SnapshotTerminal | null {
  const terminal = snapshot.terminal;
  if (!terminal) return null;
  const presented: SnapshotTerminal = { kind: terminal.type };
  if (terminal.type === "failed") presented.error = structuredErrorOf(terminal.error);
  const out = snapshot.output;
  if (out) {
    // Honest tile account off engine facts only: finalized units from
    // progress, gaps from the output ledger, partial from the terminal tag.
    const missingTiles = out.missing.map((n) => String(n));
    presented.output = {
      doneTiles: snapshot.progress.completed,
      totalTiles: snapshot.progress.total ?? null,
      failedTiles: missingTiles.length,
      partial: terminal.type === "partial-completed",
      missingTiles,
    };
    if (missingTiles.length > 0) {
      const gap = splitGapLedger(missingTiles);
      presented.gapShown = gap.shown;
      presented.gapRest = gap.rest;
      presented.gapCount = gap.count;
    }
  }
  return presented;
}

function basePresentation(): SnapshotPresentation {
  return {
    phase: "job",
    jobId: null,
    stateLabel: null,
    headlineKey: "view.step.working",
    progress: null,
    paused: false,
    terminal: null,
    transport: null,
    transportLabel: null,
    canCancel: true,
    canReset: false,
    displayOnly: false,
    partial: false,
  };
}

/**
 * Derive the full presentation for one authoritative snapshot. Total: every
 * snapshot, including terminals without catalog or progress, yields a
 * renderable presentation.
 */
export function presentSnapshot(
  snapshot: JobSnapshot,
  transport: string | null,
  options?: { displayOnly?: boolean },
): SnapshotPresentation {
  // Render the authoritative snapshot directly: every field below is the
  // generated EngineSnapshotDto shape (lifecycle/progress/decision with
  // generation+missing/terminal.type/output with missing+disposition). The
  // transport argument only labels diagnostics.
  const terminal = terminalOf(snapshot);
  const partial = snapshot.terminal?.type === "partial-completed";
  // Display-only is a host-known output fact (tainted canvas): the assembly
  // reports it explicitly via options until the engine snapshot round-trips
  // with output.disposition. The host flag never overrides a terminal, and
  // never cuts the live progress short: while the job is still running the
  // view stays on the progress bar and only switches to the preview message
  // once the engine reports a display-only disposition on a finished job.
  const engineDisplayOnly = snapshot.output?.disposition === "display-only"
    && (terminal?.kind === "completed" || terminal?.kind === "partial-completed");
  const displayOnly =
    ((options?.displayOnly === true || snapshot.output?.disposition === "display-only") &&
      terminal === null)
    || engineDisplayOnly;
  let phase: SnapshotPhase = "job";
  if (engineDisplayOnly) {
    phase = "display-only";
  } else if (terminal) {
    if (terminal.kind === "completed" || terminal.kind === "partial-completed") phase = "completed";
    else if (terminal.kind === "failed") phase = "failed";
    else phase = "cancelled";
  }

  const lifecycle: JobState = snapshot.lifecycle;
  const headline = headlineForState(lifecycle);
  const completed = snapshot.progress.completed;
  const total = snapshot.progress.total ?? null;
  const progress =
    total !== null || completed > 0
      ? { current: completed, total }
      : null;

  const detailKey = engineDisplayOnly ? undefined : headline.detail;
  const detailVars =
    engineDisplayOnly || !headline.detailVars ? undefined : headline.detailVars;
  return {
    ...basePresentation(),
    phase,
    // The engine projection carries no job id; products track ownership.
    jobId: null,
    stateLabel: lifecycle,
    headlineKey: engineDisplayOnly ? "view.display.title" : headline.key,
    ...(headline.vars ? { headlineVars: headline.vars } : {}),
    ...(detailKey ? { detailKey } : {}),
    ...(detailVars ? { detailVars } : {}),
    progress,
    paused: snapshot.paused ?? false,
    terminal,
    transport,
    transportLabel: transport === null ? null : renderTransportLabel(transport),
    canCancel: terminal === null && lifecycle !== "Cancelling",
    canReset: terminal !== null,
    displayOnly,
    partial,
  };
}

/**
 * Failed presentation for host-local failures that never reached an engine
 * snapshot (input validation, start rejections). Same contract as a failed
 * terminal: the layered error drives the view.
 */
export function presentFailure(
  error: StructuredError,
  transport: string | null,
): SnapshotPresentation {
  return {
    ...basePresentation(),
    phase: "failed",
    stateLabel: "Failed",
    headlineKey: "view.fail.title",
    terminal: { kind: "failed", error },
    transport,
    transportLabel: transport === null ? null : renderTransportLabel(transport),
    canCancel: false,
    canReset: true,
  };
}

/**
 * Presentation for a host-reported step (products without a snapshot yet).
 * Headlines come from the single `headlineForState` step table: each host
 * step maps to its engine state, so copy stays identical without a shadow
 * taxonomy. `saving` keeps the bare headline (no encoding detail) to
 * preserve the established pre-snapshot copy.
 */
export function presentStatus(
  status: PresentationStatus,
  opts?: { transport?: string | null; error?: StructuredError; partial?: boolean },
): SnapshotPresentation {
  const transport = opts?.transport ?? null;
  const state = stateForHostStep(status);
  const headline = state === null ? hostStepHeadline(status) : headlineForState(state);
  // `saving` is the pre-snapshot assembly step: same headline as Finalizing
  // without its encoding detail line.
  const detailKey = status === "saving" ? undefined : headline.detail;
  const presentation: SnapshotPresentation = {
    ...basePresentation(),
    phase: hostStepPhase(status),
    stateLabel: status,
    headlineKey: headline.key,
    ...(detailKey ? { detailKey } : {}),
    transport,
    transportLabel: transport === null ? null : renderTransportLabel(transport),
  };
  if (status === "failed") {
    presentation.terminal = { kind: "failed", error: opts?.error ?? unknownFailure() };
    presentation.canCancel = false;
    presentation.canReset = true;
  } else if (status === "completed" || status === "cancelled" || status === "display-only") {
    presentation.terminal =
      status === "completed"
        ? { kind: opts?.partial === true ? "partial-completed" : "completed" }
        : status === "cancelled"
          ? { kind: "cancelled" }
          : null;
    presentation.displayOnly = status === "display-only";
    presentation.partial = status === "completed" && opts?.partial === true;
    presentation.canCancel = false;
    presentation.canReset = true;
  }
  return presentation;
}

function unknownFailure(): StructuredError {
  return { code: "UNKNOWN", category: "unknown", retryable: true, message: t("view.fail.fallback") };
}

function hostStepPhase(status: PresentationStatus): SnapshotPhase {
  if (status === "idle") return "idle";
  if (status === "display-only") return "display-only";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "job";
}

/** Map a host step onto its engine state; null when the step has no engine state (idle, display-only). */
function stateForHostStep(status: PresentationStatus): JobState | null {
  switch (status) {
    case "discovering":
      return "Discovering";
    case "choosing-image":
      return "AwaitingImageSelection";
    case "choosing-level":
      return "AwaitingLevelSelection";
    case "preflighting":
      return "Planning";
    case "downloading":
      return "AcquiringTiles";
    case "saving":
      return "Finalizing";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "idle":
    case "display-only":
      return null;
  }
}

/** Headlines for steps without an engine state; covered by the same keys as the old table. */
function hostStepHeadline(status: PresentationStatus): { key: I18nKey; detail?: I18nKey } {
  if (status === "idle") return { key: "view.idle.submit" };
  return { key: "view.display.title" };
}

/** Idle presentation before any job starts. */
export function presentIdle(): SnapshotPresentation {
  return {
    ...basePresentation(),
    phase: "idle",
    headlineKey: "view.idle.submit",
    canCancel: false,
    canReset: false,
  };
}
