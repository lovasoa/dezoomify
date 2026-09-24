import { failure } from "@dezoomify/browser-runtime";
import type { browser } from "wxt/browser";

type Downloads = Pick<typeof browser.downloads, "download" | "search" | "cancel" | "onChanged">;
type DownloadDelta = Parameters<Parameters<Downloads["onChanged"]["addListener"]>[0]>[0];

/** Wait for the browser's saved-file result before the engine can complete. */
export function saveExtensionBlob(
  downloads: Downloads,
  blob: Blob,
  filename: string,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  return new Promise<number>((resolve, reject) => {
    let id: number | null = null;
    let settled = false;
    let aborted = false;
    const early = new Map<number, DownloadDelta>();

    const finish = (result: { id: number } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      downloads.onChanged.removeListener(onChanged);
      signal.removeEventListener("abort", onAbort);
      URL.revokeObjectURL(url);
      if ("id" in result) resolve(result.id);
      else reject(result.error);
    };
    const failed = (detail: string) =>
      failure("OUTPUT_FAILED", "The browser could not save the image.", false, undefined, detail);
    const onChanged = (delta: DownloadDelta) => {
      if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
      if (id === null) {
        if (early.size < 16) early.set(delta.id, delta);
        return;
      }
      if (delta.id !== id) return;
      if (delta.state.current === "complete") finish({ id });
      else finish({ error: failed(delta.error?.current ?? "download interrupted") });
    };
    const onAbort = () => {
      aborted = true;
      if (id === null) return;
      void downloads.cancel(id).catch(() => {});
      finish({ error: signal.reason ?? new DOMException("Job cancelled", "AbortError") });
    };

    downloads.onChanged.addListener(onChanged);
    signal.addEventListener("abort", onAbort, { once: true });
    void downloads.download({ url, filename, saveAs: false }).then(
      async (startedId) => {
        id = startedId;
        if (aborted || signal.aborted) {
          onAbort();
          return;
        }
        const event = early.get(startedId);
        if (event) {
          onChanged(event);
          if (settled) return;
        }
        try {
          const [item] = await downloads.search({ id: startedId });
          if (settled) return;
          if (signal.aborted) {
            onAbort();
          } else if (item?.state === "complete") {
            finish({ id: startedId });
          } else if (item?.state === "interrupted") {
            finish({ error: failed(item.error ?? "download interrupted") });
          }
        } catch (error) {
          finish({ error: failed(error instanceof Error ? error.message : String(error)) });
        }
      },
      (error) =>
        finish({
          error: signal.aborted
            ? (signal.reason ?? new DOMException("Job cancelled", "AbortError"))
            : failed(error instanceof Error ? error.message : String(error)),
        }),
    );
  });
}
