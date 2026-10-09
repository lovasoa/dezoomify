import type { RetryChoice } from "@dezoomify/wasm-bindings";
import { t } from "./i18n.ts";

export function RetryActions({ onAnswer }: { onAnswer(choice: RetryChoice): void }) {
  return (
    <div className="dz-actions-row" data-dz-retry-actions="true">
      <button
        type="button"
        className="dz-btn-tactile"
        data-dz-retry-choice="retry"
        onClick={() => onAnswer("retry")}
      >
        {t("view.retry.retry")}
      </button>
      <button
        type="button"
        className="dz-btn-secondary"
        data-dz-retry-choice="cancel"
        onClick={() => onAnswer("cancel")}
      >
        {t("view.retry.cancel")}
      </button>
    </div>
  );
}
