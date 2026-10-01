import type { Error as JobError, MissingTiles, Output, Progress } from "@dezoomify/wasm-bindings";
import { type I18nKey, t } from "./i18n.ts";

export interface ResolutionChoice {
  selected: { width: number; height: number };
  maximum: { width: number; height: number };
}

export type PresentationStatus =
  | "idle"
  | "discovering"
  | "preflighting"
  | "downloading"
  | "saving"
  | "display-only"
  | "completed"
  | "failed"
  | "cancelled";

export interface Presentation {
  phase: "idle" | "job" | "display-only" | "completed" | "failed" | "cancelled";
  headlineKey: I18nKey;
  headlineVars?: Record<string, string | number>;
  detailKey?: I18nKey;
  detailVars?: Record<string, string | number>;
  progress: { current: number; total: number | null } | null;
  paused: boolean;
  error?: JobError;
  output?: Output;
  decision?: MissingTiles;
  resolution?: ResolutionChoice;
}

const headlines: Record<PresentationStatus, I18nKey> = {
  idle: "view.idle.submit",
  discovering: "view.step.discovering",
  preflighting: "view.step.preflighting",
  downloading: "view.step.downloading",
  saving: "view.step.saving",
  "display-only": "view.display.title",
  completed: "view.done.ready",
  failed: "view.fail.title",
  cancelled: "view.cancel.title",
};

export function presentStatus(
  status: PresentationStatus,
  opts?: { error?: JobError },
): Presentation {
  const finished = ["completed", "failed", "cancelled", "display-only"].includes(status);
  return {
    phase: status === "idle" || finished ? (status as Presentation["phase"]) : "job",
    headlineKey: headlines[status],
    ...(status === "discovering" ? { detailKey: "view.step.contactingDetail" as const } : {}),
    progress: null,
    paused: false,
    error:
      status === "failed"
        ? (opts?.error ?? {
            code: "native.internal",
            phase: "output",
            retryable: true,
            message: t("view.fail.fallback"),
          })
        : undefined,
  };
}

export function presentProgress(progress: Progress, opts?: { paused?: boolean }): Presentation {
  const status = {
    discovery: "discovering",
    planning: "preflighting",
    acquisition: "downloading",
    output: "saving",
  } as const;
  const selected = progress.selected;
  const maximum = progress.maximum;
  return {
    ...presentStatus(status[progress.phase]),
    progress:
      progress.total != null || progress.completed > 0
        ? { current: progress.completed, total: progress.total ?? null }
        : null,
    paused: opts?.paused === true,
    ...(selected && maximum && selected.width * selected.height < maximum.width * maximum.height
      ? { resolution: { selected, maximum } }
      : {}),
  };
}

export function presentOutput(output: Output, progress: Progress | undefined): Presentation {
  const displayOnly = output.disposition === "display-only";
  const presented = presentStatus(displayOnly ? "display-only" : "completed");
  return {
    ...presented,
    progress: progress ? { current: progress.completed, total: progress.total ?? null } : null,
    ...(progress ? { resolution: presentProgress(progress).resolution } : {}),
    output,
  };
}

export function presentFailure(error: JobError): Presentation {
  return presentStatus("failed", { error });
}

export function presentIdle(): Presentation {
  return presentStatus("idle");
}
