import type { ReactElement, ReactNode } from "react";
import type { JobActivity } from "./activity.ts";
import type { DiagnosticReport } from "./diagnostics.ts";
import type { HistoryEntry, HistoryRow } from "./history.ts";
import type { Presentation } from "./presentation.ts";

/** User actions supplied by the graphical product that hosts the shared UI. */
export interface ViewCallbacks {
  onSubmitUrl(url: string): void;
  onCancel(): void;
  onOpenSource?(): void;
  onReset?(): void;
  onRetrySameUrl?(): void;
  onRetryChoice?(choice: RetryChoice): void;
  /** Restart the job at the maximum known resolution (browser products). */
  onTryMaximum?(): void;
  onSave?(): void;
  onOpenOutput?(): Promise<void>;
  onRevealOutput?(): Promise<void>;
  onRemoveHistory?(entry: HistoryEntry): void;
  onOpenHistory?(entry: HistoryEntry): Promise<void>;
  onOpenExternalLink?(url: string): void;
  onCopyDiagnostics?(text: string): void | Promise<void>;
  onSaveDiagnostics?(report: DiagnosticReport): void | Promise<void>;
  onLoadDiagnostics?(): Promise<DiagnosticReport>;
  onClearHistory?(): void;
  onPause?(): void;
  onResume?(): void;
}

/**
 * Product-local view data alongside the generated progress, output, and errors.
 */
export interface ViewContext {
  product?: "website" | "extension" | "desktop";
  diagnosticReport?: DiagnosticReport;
  currentProgress?: {
    active?: number;
    retrying?: number;
    estimatedTotalMs?: number;
    message?: string;
  };
  /** Stable identity of the completed result; resets pending output actions. */
  outputKey?: string;
  jobActivity?: JobActivity;
  initialUrl?: string;
  sourceUrl?: string;
  history?: HistoryRow[];
  historyNow?: number;
}

/** Host-owned React content rendered inside or instead of the generic card. */
export interface ViewRenderOptions {
  /** Rendered inside the idle card, between the URL input and the history list. */
  idleBeforeHistory?: ReactNode;
  after?: ReactNode;
  replace?: ReactElement;
}

export type ViewPhase = Presentation["phase"];

export interface PlatformHints {
  userAgent?: string;
  platform?: string;
}

import type { RetryChoice } from "@dezoomify/wasm-bindings";
