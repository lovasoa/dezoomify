import type { RetryChoice } from "@dezoomify/wasm-bindings";
import { t } from "./i18n.ts";
import { NoticeAction, NoticeActions } from "./notice.tsx";

export function RetryActions({ onAnswer }: { onAnswer(choice: RetryChoice): void }) {
  return (
    <NoticeActions data-dz-retry-actions="true">
      <NoticeAction primary data-dz-retry-choice="retry" onClick={() => onAnswer("retry")}>
        {t("view.retry.retry")}
      </NoticeAction>
      <NoticeAction data-dz-retry-choice="cancel" onClick={() => onAnswer("cancel")}>
        {t("view.retry.cancel")}
      </NoticeAction>
    </NoticeActions>
  );
}
