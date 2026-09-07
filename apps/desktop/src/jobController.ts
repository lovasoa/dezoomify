// Desktop job control (todo 2.2 split from main.tsx).
// Controller walks plus the failure/completion terminals. Job state arrives
// through explicit env callbacks, so this module owns no globals.
// File move, no behavior change.
import { t } from "@dezoomify/shared-ui";
import {
  categoryFor,
  formatMissingSummary,
  phaseFor,
  plainMessageFor,
  technicalDetailFor,
  trimTechnical,
} from "./errorCopy.ts";

// Opaque desktop choice strings. They must keep matching the shell mapping
// (apps/desktop/src-tauri/src/jobs.rs map_choice_kind) and the engine
// response shapes (RetryReady needs att:<suffix>, PartialKeep derives keep
// from keep/discard/partial markers):
// - retry -> RetryReady ("att:" prefix)
// - keep-partial / discard-partial -> PartialKeep ("partial:" + keep/discard)
export const RETRY_CHOICE = "att:0:ready";
export const KEEP_PARTIAL_CHOICE = "partial:keep";
export const DISCARD_PARTIAL_CHOICE = "partial:discard";


export function isTerminalStatus(status: string): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}


export interface PendingDecision {
  kind: "destination-request" | "destination-recovery" | "partial-recovery";
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
  const phase = opts?.phase ?? phaseFor(code);
  // Prefer the backend's retryable verdict when present (stable codes);
  // fall back to the legacy local heuristic only for payloads without it.
  const retryable =
    opts?.retryable ?? (code !== "INVALID_URL" && code !== "NO_IMAGE_FOUND" && code !== "OUTPUT_DENIED");
  // Layered presentation: the first message stays a plain jargon-free
  // sentence naming the step, picture source, and single best action.
  // The technical chain (transport, status, trimmed origin, engine text)
  // lives only in the collapsible detail.
  const plain = plainMessageFor(code, message, env.host());
  const technical = technicalDetailFor(
    code,
    message,
    opts?.detail,
    {
      phase,
      transport,
      ...(opts?.resourceKind ? { resourceKind: opts.resourceKind } : {}),
    },
    env.getStatus(),
    env.origin(),
    env.nativeTransport,
  );
  env.dispatch({
    seq: env.next(),
    sessionId: env.sessionId(),
    kind: "fail",
    transport,
    error: {
      code,
      category: categoryFor(code),
      retryable,
      message: plain,
      transport,
      phase,
      detail: technical,
    },
  });
  env.pushLog(`Failed (${code}): ${trimTechnical(message, 160)}`);
  env.clearPending();
  env.stopHeartbeat();
  env.update();
}


export function ensureChosenThroughPreflight(
  dispatch: (event: unknown) => void,
  sessionId: string,
  next: () => number,
  nativeTransport: string,
  imageCount?: number,
): void {
  dispatch({
    seq: next(),
    sessionId,
    kind: "images-found",
    ...(typeof imageCount === "number" ? { imageCount } : {}),
    transport: nativeTransport,
  });
  dispatch({ seq: next(), sessionId, kind: "image-chosen" });
  dispatch({ seq: next(), sessionId, kind: "level-chosen" });
  dispatch({ seq: next(), sessionId, kind: "preflight-ok", transport: nativeTransport });
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
  ensureChosenThroughPreflight(env.dispatch, env.sessionId(), env.next, env.nativeTransport);
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
