import type { AppCapabilities, ControllerState } from "./controller.ts";
import type { HistoryEntry } from "./history.ts";
import type { ReactElement, ReactNode } from "react";

/** Effects supplied by the graphical product that hosts the shared UI. */
export interface ViewCallbacks {
  onSubmitUrl(url: string): void;
  onCancel(): void;
  onReset(): void;
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

export interface ViewContext {
  capabilities?: AppCapabilities;
  currentProgress?: { current: number; total: number; active?: number; retrying?: number; estimatedTotalMs?: number; message?: string };
  completedInfo?: { width: number; height: number; mime: string; blobUrl?: string };
  nativeSaved?: { partial: boolean };
  savedOutput?: { name: string; width: number; height: number; doneTiles: number; totalTiles: number; failedTiles: number };
  originClean?: boolean; jobActivity?: JobActivity; initialUrl?: string;
  imageChoice?: { width?: number; height?: number; tiles?: number };
  sourceUrl?: string; desktopHandoffUrl?: string; history?: HistoryEntry[]; paused?: boolean;
}

/** Host-owned React content rendered inside or instead of the generic card. */
export interface ViewRenderOptions {
  after?: ReactNode;
  replace?: ReactElement;
}

export type ViewPhase = "idle" | "job" | "display-only" | "completed" | "failed" | "cancelled" | "generic";

export function getPhaseForStatus(status: ControllerState["status"]): ViewPhase {
  if (status === "idle") return "idle";
  if (["discovering", "choosing-image", "choosing-level", "preflighting", "downloading", "saving"].includes(status)) return "job";
  if (status === "display-only" || status === "completed" || status === "failed" || status === "cancelled") return status;
  return "generic";
}

export interface ImagePickerOption { index: number; title?: string; width?: number; height?: number; tiles?: number; }
export interface ImagePickerArgs { options: ImagePickerOption[]; onPick(index: number): void; }
export interface LevelPickerOption { index: number; width: number; height: number; tiles: number; fits: boolean; }
export interface LevelPickerArgs { options: LevelPickerOption[]; onPick(index: number): void; }
export interface ConfirmModalArgs { title: string; subtitle: string; bodyLines: string[]; confirmLabel: string; declineLabel: string; }
export interface PlatformHints { userAgent?: string; platform?: string; }
