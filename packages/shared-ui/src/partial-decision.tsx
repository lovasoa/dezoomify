import type { JobCommand, JobSnapshot } from "@dezoomify/app-model";
import type { ReactElement } from "react";
import { t } from "./i18n.ts";

type PartialAnswer = Extract<JobCommand, { type: "answer-partial" }>;

/** The UI returns the engine's generation and choice without translating either. */
export function PartialDecisionActions({
  decision,
  onAnswer,
  labels,
}: {
  decision: NonNullable<JobSnapshot["decision"]>;
  onAnswer(command: PartialAnswer): void;
  labels?: { keep: string; discard: string; retry: string };
}): ReactElement {
  const text = labels ?? {
    keep: t("desktop.rec.keep"),
    discard: t("desktop.rec.discard"),
    retry: t("desktop.rec.retryTiles"),
  };
  function answer(choice: PartialAnswer["decision"]): void {
    onAnswer({ type: "answer-partial", generation: decision.generation, decision: choice });
  }
  return (
    <div className="dz-actions-row" data-dz-partial-decision="true">
      <button
        type="button"
        className="dz-btn-tactile"
        data-dz-partial-choice="keep"
        onClick={() => answer("keep")}
      >
        {text.keep}
      </button>
      <button
        type="button"
        className="dz-btn-secondary"
        data-dz-partial-choice="discard"
        onClick={() => answer("discard")}
      >
        {text.discard}
      </button>
      <button
        type="button"
        className="dz-btn-secondary"
        data-dz-partial-choice="retry"
        onClick={() => answer("retry")}
      >
        {text.retry}
      </button>
    </div>
  );
}
