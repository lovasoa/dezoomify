import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";

/** Shared presentation for failures and warnings; hosts supply the available actions. */
export function Notice({
  id,
  tone,
  title,
  message,
  messageId,
  details,
  actions,
  children,
  className = "",
}: {
  id: string;
  tone: "error" | "warning";
  title: string;
  message: ReactNode;
  messageId?: string;
  details?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      id={id}
      className={`dz-notice dz-notice--${tone} ${className}`}
      aria-labelledby={`${id}-title`}
    >
      <div
        className="dz-notice-header"
        role={tone === "error" ? "alert" : "status"}
        aria-atomic="true"
      >
        <svg
          className="dz-notice-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {tone === "error" ? (
            <circle cx="12" cy="12" r="10" />
          ) : (
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          )}
          <path d="M12 8v5m0 4h.01" />
        </svg>
        <div className="dz-notice-content">
          <h2 className="dz-notice-title" id={`${id}-title`}>
            {title}
          </h2>
          <p className="dz-notice-message" id={messageId}>
            {message}
          </p>
          {details ? <div className="dz-notice-details">{details}</div> : null}
        </div>
      </div>
      {actions}
      {children}
    </section>
  );
}

export function NoticeActions({ className = "", ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div {...props} className={`dz-actions-row dz-notice-actions ${className}`} />;
}

export function NoticeAction({
  primary = false,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      {...props}
      type="button"
      className={`${primary ? "dz-btn-tactile" : "dz-btn-secondary"} ${className}`}
    />
  );
}
