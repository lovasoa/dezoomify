import type { MissingTiles, RecoveryChoice } from "@dezoomify/wasm-bindings";
import type { ReactElement } from "react";
import { t } from "./i18n.ts";

export function PartialDecisionActions({
  decision,
  onAnswer,
  labels,
}: {
  decision: MissingTiles;
  onAnswer(choice: RecoveryChoice): void;
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
  const answer = onAnswer;
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
