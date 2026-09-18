// Desktop job control (todo 2.2 split from main.tsx).
// Failure/completion terminals plus the opaque shell choice strings. Job
// state arrives through explicit env callbacks, so this module owns no
// globals. Shell lifecycle signals map to single controller transitions;
// selection steps are never synthesized here.
// File move, no behavior change.
import { describeFailure, t } from "@dezoomify/shared-ui";
import {
  formatMissingSummary,
  phaseFor,
  trimTechnical,
} from "./errorCopy.ts";

// Typed desktop choice shapes sent to the shell `answer_choice` command.
// Structured end to end: these objects decode to the shell `Choice` enum
// directly; no string parsing is involved.
export type AnswerChoice =
  | { kind: "image"; index: number }
  | { kind: "level"; index: number }
  | { kind: "partial"; keep: boolean }
  | { kind: "retry" };


export function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}


export interface PendingDecision {
  kind: "destination-recovery" | "partial-recovery";
  reason: string;
  recovery?: string;
  attempt?: string;
  missingTiles?: Array<string>;
  failedCount?: number;
  totalCount?: number;
}

export interface FailEnv {
  dispatch: (event: unknown) => void;
  getStatus: () => string;
  sessionId: () => string;
  next: () => number;
  nativeTransport: string;
  host: () => string;
  origin: () => string;
  sourceUrl: () => string;
  clearPending: () => void;
  stopHeartbeat: () => void;
  pushLog: (line: string) => void;
  update: () => void;
}

export interface FailOpts {
  transport?: string;
  phase?: string;
  detail?: string;
  retryable?: boolean;
  resourceKind?: string;
}

export function dispatchFail(env: FailEnv, code: string, message: string, opts?: FailOpts): void {
  const transport = opts?.transport ?? env.nativeTransport;
  // Layered presentation is shared with the other products: the plain
  // headline, the stable category/phase, and the engine block moved to
  // `detail` all come from one presenter, so no surface re-implements the
  // split. Desktop-only provenance lines ride as `extras`.
  const error = describeFailure({
    code,
    engineDetail: trimTechnical(message || ""),
    extraDetail: opts?.detail && opts.detail !== message ? trimTechnical(opts.detail) : undefined,
    // Prefer the backend's retryable verdict when present (stable codes);
    // fall back to the legacy local heuristic only for payloads without it.
    retryable:
      opts?.retryable ?? (code !== "INVALID_URL" && code !== "NO_IMAGE_FOUND" && code !== "OUTPUT_DENIED"),
    transport,
    phase: opts?.phase ?? phaseFor(code),
    url: env.sourceUrl() || undefined,
    host: env.host(),
    extras: [
      `Status: ${env.getStatus()}`,
      `Origin: ${env.origin() === "" ? "n/a" : env.origin()}`,
      ...(opts?.resourceKind ? [`Resource: ${opts.resourceKind}`] : []),
    ],
  });
  env.dispatch({
    seq: env.next(),
    sessionId: env.sessionId(),
    kind: "fail",
    transport,
    error,
  });
  env.pushLog(`Failed (${code}): ${trimTechnical(message, 160)}`);
  env.clearPending();
  env.stopHeartbeat();
  env.update();
}


export interface CompletedInfo {
  width: number;
  height: number;
  mime: string;
}

export interface CatalogNotice {
  imageCount: number;
  width?: number;
  height?: number;
  tiles?: number;
}

export interface CompleteJobEnv {
  dispatch: (event: unknown) => void;
  getStatus: () => string;
  sessionId: () => string;
  next: () => number;
  nativeTransport: string;
  getImageCount: () => number;
  getProgressTotal: () => number | undefined;
  getCompletedInfo: () => CompletedInfo | undefined;
  setCompletedInfo: (info: CompletedInfo | undefined) => void;
  setImageChoice: (choice: { width: number; height: number; tiles?: number } | undefined) => void;
  getCatalogNotice: () => CatalogNotice | null;
  setCatalogNotice: (notice: CatalogNotice | null) => void;
  setPendingDecision: (decision: PendingDecision | null) => void;
  setCompletedPartial: (partial: boolean, missing: Array<string>) => void;
  pushLog: (line: string) => void;
  setStep: (label: string, detail?: string) => void;
  stopHeartbeat: () => void;
  update: () => void;
}

export function completeJob(
  env: CompleteJobEnv,
  completedInfo?: { width: number; height: number; mime: string },
  partial?: boolean,
  missing?: Array<string>,
): void {
  if (isTerminalStatus(env.getStatus())) return;
  if (completedInfo) env.setCompletedInfo(completedInfo);
  const info = env.getCompletedInfo();
  if (info && info.width > 0 && info.height > 0) {
    const prevNotice = env.getCatalogNotice();
    const prevCount = prevNotice?.imageCount ?? env.getImageCount() ?? 0;
    const total = env.getProgressTotal();
    env.setCatalogNotice({
      ...(prevNotice ?? {}),
      imageCount: prevCount,
      width: info.width,
      height: info.height,
      ...(typeof total === "number" && total > 0 ? { tiles: total } : {}),
    });
    env.setImageChoice({
      width: info.width,
      height: info.height,
      ...(typeof total === "number" && total > 0 ? { tiles: total } : {}),
    });
  }
  env.setPendingDecision(null);
  const isPartial = partial === true;
  const missingList = Array.isArray(missing) ? missing.slice(0, 60) : [];
  env.setCompletedPartial(isPartial, missingList);
  if (info) {
    if (isPartial) {
      const summary = formatMissingSummary(missingList, missingList.length);
      env.pushLog(`Partial done: ${info.width}x${info.height} (${info.mime}); ${summary}`);
      env.setStep(t("view.step.saving"), t("desktop.step.partialDims", { width: info.width, height: info.height, summary }));
    } else {
      env.pushLog(`Saved: ${info.width}x${info.height} (${info.mime})`);
      // Honest native completion copy (todo 0.2): the output file is written,
      // while the website shows a pre-click ready state. Transport captions
      // stay canonical via shared-ui renderTransportLabel.
      env.setStep(t("view.step.saving"), t("desktop.step.savedDims", { width: info.width, height: info.height }));
    }
  } else if (isPartial) {
    const summary = formatMissingSummary(missingList, missingList.length);
    env.pushLog(`Partial done; ${summary}`);
    env.setStep(t("view.step.saving"), t("desktop.step.partialSaved", { summary }));
  } else {
    env.pushLog("Saved");
    env.setStep(t("view.step.saving"), t("desktop.step.savedWord"));
  }
  env.dispatch({ seq: env.next(), sessionId: env.sessionId(), kind: "save-start" });
  env.dispatch({ seq: env.next(), sessionId: env.sessionId(), kind: "save-done" });
  env.stopHeartbeat();
  env.update();
}
