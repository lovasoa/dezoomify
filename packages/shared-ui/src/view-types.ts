import type { AppCapabilities } from "./components.ts";
import type { SnapshotPresentation } from "./snapshot-view.ts";
import type { HistoryEntry } from "@dezoomify/app-model";
import type { ReactElement, ReactNode } from "react";

/** Effects supplied by the graphical product that hosts the shared UI. */
export interface ViewCallbacks {
  onSubmitUrl(url: string): void;
  onCancel(): void;
  onReset?(): void;
  onRetrySameUrl?(): void;
  onSave?(): void;
  onOpenOutput?(): void;
  onRevealOutput?(): void;
  onHistorySelect?(entry: HistoryEntry): void;
  onSelectImage?(index: number): void;
  onSelectLevel?(level: number): void;
  onOpenExternalLink?(url: string): void;
  onCopyDiagnostics?(text: string): void;
  onClearHistory?(): void;
  onPause?(): void;
  onResume?(): void;
}

export interface JobActivity {
  url?: string; startedAt?: number; now?: number; stepLabel?: string; detail?: string;
  pendingRequests?: number; completedRequests?: number; failedRequests?: number;
  longestPendingMs?: number; timeoutMs?: number; lastProgressAt?: number;
  log?: string[]; diagnostics?: string; paused?: boolean; pausedAt?: number;
  pausedDurationMs?: number;
}

/**
 * Host presentation context. Counts, selection geometry, and terminal data
 * ride the SnapshotPresentation; hosts set these fields from their snapshot
 * stream plus product-local surfaces (canvas blobs, saved files, history).
 */
export interface ViewContext {
  capabilities?: AppCapabilities;
  currentProgress?: { active?: number; retrying?: number; estimatedTotalMs?: number; message?: string };
  completedInfo?: { width: number; height: number; mime: string; blobUrl?: string };
  nativeSaved?: { partial: boolean };
  savedOutput?: { name: string; width: number; height: number; doneTiles: number; totalTiles: number; failedTiles: number };
  originClean?: boolean; jobActivity?: JobActivity; initialUrl?: string;
  imageChoice?: { width?: number; height?: number; tiles?: number };
  sourceUrl?: string; desktopHandoffUrl?: string; history?: HistoryEntry[];
}

/** Host-owned React content rendered inside or instead of the generic card. */
export interface ViewRenderOptions {
  /** Rendered inside the idle card, between the URL input and the history list. */
  idleBeforeHistory?: ReactNode;
  after?: ReactNode;
  replace?: ReactElement;
}

export type ViewPhase = SnapshotPresentation["phase"];

export interface ImagePickerOption { index: number; title?: string; width?: number; height?: number; tiles?: number; }
export interface ImagePickerArgs { options: ImagePickerOption[]; onPick(index: number): void; }
export interface LevelPickerOption { index: number; width: number; height: number; tiles: number; fits: boolean; }
export interface LevelPickerArgs { options: LevelPickerOption[]; onPick(index: number): void; }
export interface ConfirmModalArgs { id?: string; title: string; subtitle?: string; bodyLines: string[]; confirmLabel: string; declineLabel: string; }
export interface PlatformHints { userAgent?: string; platform?: string; }
