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
    keep: t("view.partial.save"),
    discard: t("view.partial.cancel"),
    retry: t("view.partial.retry"),
  };
  const canRetry =
    decision.missing.length > 0 &&
    decision.missing.every(({ failures }) => failures.at(-1)?.category === "transient");
  function answer(choice: PartialAnswer["decision"]): void {
    onAnswer({ type: "answer-partial", generation: decision.generation, decision: choice });
  }
  return (
    <div className="dz-actions-row" data-dz-partial-decision="true">
      {canRetry ? (
        <button
          type="button"
          className="dz-btn-tactile"
          data-dz-partial-choice="retry"
          onClick={() => answer("retry")}
        >
          {text.retry}
        </button>
      ) : null}
      <button
        type="button"
        className={canRetry ? "dz-btn-secondary" : "dz-btn-tactile"}
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
    </div>
  );
}
