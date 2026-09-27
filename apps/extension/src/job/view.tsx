import type { ReactElement } from "react";

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
      <h1>Allow access to continue</h1>
      <p>This image uses files from {origin}.</p>
      <p>Dezoomify needs access to read those files and assemble your image in this browser.</p>
      <button
        type="button"
        className="dz-btn-tactile dz-permission-button"
        data-dz-allow-access="true"
        disabled={requesting}
        onClick={onRequest}
      >
        {requesting ? "Requesting access…" : "Allow access and continue"}
      </button>
    </div>
  );
}
