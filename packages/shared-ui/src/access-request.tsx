import type { ReactElement } from "react";
import { t } from "./i18n.ts";

export function AccessRequestView({
  origin,
  requesting,
  onRequest,
}: {
  origin: string;
  requesting: boolean;
  onRequest(): void;
}): ReactElement {
  return (
    <div className="dz-permission-request">
      <div className="dz-permission-icon" aria-hidden="true">
        <svg
          aria-hidden="true"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
        >
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          <rect x="5" y="10" width="14" height="10" rx="1" />
        </svg>
      </div>
      <h1>{t("view.access.title")}</h1>
      <p>{t("view.access.usesOrigin", { origin })}</p>
      <p>{t("view.access.needAccess")}</p>
      <button
        type="button"
        className="dz-btn-tactile dz-permission-button"
        data-dz-allow-access="true"
        disabled={requesting}
        onClick={onRequest}
      >
        {requesting ? t("view.access.requesting") : t("view.access.allow")}
      </button>
    </div>
  );
}
