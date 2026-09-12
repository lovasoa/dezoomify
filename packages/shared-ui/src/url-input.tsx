import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactElement } from "react";
import { t } from "./i18n.ts";

/** The canonical URL entry and submit control used by graphical products. */
export function UrlInput({ initialUrl, onSubmit }: { initialUrl?: string; onSubmit(url: string): void }): ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [hasValue, setHasValue] = useState(Boolean(initialUrl));

  useEffect(() => {
    const input = inputRef.current;
    if (input && !input.value && initialUrl) {
      input.value = initialUrl;
      setHasValue(true);
    }
  }, [initialUrl]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = inputRef.current?.value.trim() ?? "";
    if (!url) return inputRef.current?.focus();
    onSubmit(url);
  };

  return <form className="dz-form" onSubmit={submit}>
    <div className="dz-input-wrapper">
      <input ref={inputRef} type="url" id="dz-url-input" className="dz-input" placeholder={t("view.input.placeholder")} required autoFocus defaultValue={initialUrl ?? ""} aria-label={t("view.input.aria")} onChange={(event) => setHasValue(event.currentTarget.value.length > 0)} />
      <button type="button" className="dz-input-clear" id="dz-btn-clear" title={t("view.idle.clearTitle")} aria-label={t("view.idle.clearTitle")} style={{ display: hasValue ? "flex" : "none" }} onClick={() => {
        const input = inputRef.current;
        if (!input) return;
        input.value = "";
        setHasValue(false);
        input.focus();
      }}>×</button>
    </div>
    <div className="dz-button-row"><button type="submit" className="dz-btn-tactile"><span>{t("view.input.start")}</span><span className="dz-button-key" aria-hidden="true">↵</span></button></div>
  </form>;
}
