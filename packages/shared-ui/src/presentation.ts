import type { Error as JobError, MissingTiles, Output, Progress } from "@dezoomify/wasm-bindings";
import { splitGapLedger } from "./components.ts";
import { categoryFor } from "./failure.ts";
import { type I18nKey, t } from "./i18n.ts";
import { renderTransportLabel } from "./labels.ts";

export interface StructuredError {
  code: string;
  category: string;
  retryable: boolean;
  message: string;
  detail?: string;
  transport?: string;
  phase?: string;
  url?: string;
  http?: number;
  preview?: string;
  extras?: string[];
}

export interface ResolutionChoice {
  selected: { width: number; height: number };
  maximum: { width: number; height: number };
}

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

export interface Presentation {
  phase: "idle" | "job" | "display-only" | "completed" | "failed" | "cancelled";
  stateLabel: string | null;
  headlineKey: I18nKey;
  headlineVars?: Record<string, string | number>;
  detailKey?: I18nKey;
  detailVars?: Record<string, string | number>;
  progress: { current: number; total: number | null } | null;
  paused: boolean;
  terminal: {
    kind: "completed" | "partial-completed" | "failed" | "cancelled";
    error?: StructuredError;
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
  } | null;
  transport: string | null;
  transportLabel: string | null;
  canCancel: boolean;
  canReset: boolean;
  displayOnly: boolean;
  partial: boolean;
  decision?: MissingTiles;
  resolution?: ResolutionChoice;
}

const headlines: Record<PresentationStatus, I18nKey> = {
  idle: "view.idle.submit",
  discovering: "view.step.discovering",
  "choosing-image": "view.step.choosingImage",
  "choosing-level": "view.step.choosingLevel",
  preflighting: "view.step.preflighting",
  downloading: "view.step.downloading",
  saving: "view.step.saving",
  "display-only": "view.display.title",
  completed: "view.done.ready",
  failed: "view.fail.title",
  cancelled: "view.cancel.title",
};

export function structuredErrorOf(error: JobError): StructuredError {
  return {
    code: error.code,
    category: categoryFor(error.code),
    retryable: error.retryable,
    message: error.message,
    phase: error.phase,
    ...(error.detail ? { detail: error.detail } : {}),
    ...(error.transport ? { transport: error.transport } : {}),
    ...(error.request ? { url: error.request } : {}),
    ...(error.http != null ? { http: error.http } : {}),
    ...(error.preview ? { preview: error.preview } : {}),
    ...(error.resource_kind ? { extras: [`Resource: ${error.resource_kind}`] } : {}),
  };
}

export function presentStatus(
  status: PresentationStatus,
  opts?: { transport?: string | null; error?: StructuredError; partial?: boolean },
): Presentation {
  const transport = opts?.transport ?? null;
  const finished = ["completed", "failed", "cancelled", "display-only"].includes(status);
  return {
    phase: status === "idle" || finished ? (status as Presentation["phase"]) : "job",
    stateLabel: status,
    headlineKey: headlines[status],
    ...(status === "discovering" ? { detailKey: "view.step.contactingDetail" as const } : {}),
    progress: null,
    paused: false,
    terminal:
      status === "failed"
        ? {
            kind: "failed",
            error: opts?.error ?? {
              code: "UNKNOWN",
              category: "unknown",
              retryable: true,
              message: t("view.fail.fallback"),
            },
          }
        : status === "cancelled"
          ? { kind: "cancelled" }
          : status === "completed"
            ? { kind: opts?.partial ? "partial-completed" : "completed" }
            : null,
    transport,
    transportLabel: transport === null ? null : renderTransportLabel(transport),
    canCancel: !finished && status !== "idle",
    canReset: finished,
    displayOnly: status === "display-only",
    partial: opts?.partial === true,
  };
}

export function presentProgress(
  progress: Progress,
  transport: string | null,
  opts?: { paused?: boolean; displayOnly?: boolean },
): Presentation {
  const status = {
    discovery: "discovering",
    planning: "preflighting",
    acquisition: "downloading",
    output: "saving",
  } as const;
  const selected = progress.selected;
  const maximum = progress.maximum;
  return {
    ...presentStatus(status[progress.phase], { transport }),
    progress:
      progress.total != null || progress.completed > 0
        ? { current: progress.completed, total: progress.total ?? null }
        : null,
    paused: opts?.paused === true,
    displayOnly: opts?.displayOnly === true,
    ...(selected && maximum && selected.width * selected.height < maximum.width * maximum.height
      ? { resolution: { selected, maximum } }
      : {}),
  };
}

export function presentOutput(
  output: Output,
  progress: Progress | undefined,
  transport: string | null,
): Presentation {
  const displayOnly = output.disposition === "display-only";
  const missingTiles = output.missing.map(String);
  const gap = splitGapLedger(missingTiles);
  const presented = presentStatus(displayOnly ? "display-only" : "completed", {
    transport,
    partial: !output.complete,
  });
  return {
    ...presented,
    progress: progress ? { current: progress.completed, total: progress.total ?? null } : null,
    ...(progress ? { resolution: presentProgress(progress, transport).resolution } : {}),
    terminal: {
      kind: output.complete ? "completed" : "partial-completed",
      output: {
        doneTiles: progress?.completed ?? 0,
        totalTiles: progress?.total ?? null,
        failedTiles: missingTiles.length,
        partial: !output.complete,
        missingTiles,
      },
      gapShown: gap.shown,
      gapRest: gap.rest,
      gapCount: gap.count,
    },
  };
}

export function presentFailure(error: StructuredError, transport: string | null): Presentation {
  return presentStatus("failed", { error, transport });
}

export function presentIdle(): Presentation {
  return presentStatus("idle");
}
