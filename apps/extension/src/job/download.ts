import { outputError } from "@dezoomify/browser-runtime";
import type { browser } from "wxt/browser";

type Downloads = Pick<typeof browser.downloads, "download" | "search" | "cancel" | "onChanged">;
type DownloadDelta = Parameters<Parameters<Downloads["onChanged"]["addListener"]>[0]>[0];

/** Wait for the browser's saved-file result before the Rust algorithm can complete. */
export function saveExtensionBlob(
  downloads: Downloads,
  blob: Blob,
  filename: string,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  const url = URL.createObjectURL(blob);
  return saveExtensionUrl(downloads, url, filename, signal).finally(() => URL.revokeObjectURL(url));
}

/** Download an existing image directly, retaining the same completion/cancellation handling. */
export function saveExtensionUrl(
  downloads: Downloads,
  url: string,
  filename: string | undefined,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  return new Promise<number>((resolve, reject) => {
    let id: number | null = null;
    let settled = false;
    let aborted = false;
    let cancelling = false;
    const early = new Map<number, DownloadDelta>();

    const finish = (result: { id: number } | { error: unknown }) => {
      if (settled) return;
      settled = true;
      downloads.onChanged.removeListener(onChanged);
      signal.removeEventListener("abort", onAbort);
      if ("id" in result) resolve(result.id);
      else reject(result.error);
    };
    const failed = (detail: string) => outputError("write-failed", detail);
    const finishState = (state?: string, error?: string) => {
      if (id === null) return;
      if (aborted) finish({ error: signal.reason });
      else if (state === "complete") finish({ id });
      else if (state === "interrupted") finish({ error: failed(error ?? "download interrupted") });
    };
    const onChanged = (delta: DownloadDelta) => {
      if (delta.state?.current !== "complete" && delta.state?.current !== "interrupted") return;
      if (id === null) {
        if (early.size < 16) early.set(delta.id, delta);
        return;
      }
      if (delta.id !== id) return;
      finishState(delta.state.current, delta.error?.current);
    };
    const cancelAndFinish = (error: unknown) => {
      if (id === null || settled || cancelling) return;
      cancelling = true;
      // The manager may still be reading the Blob until cancellation settles.
      void downloads.cancel(id).then(
        () => finish({ error }),
        () => finish({ error }),
      );
    };
    const onAbort = () => {
      aborted = true;
      cancelAndFinish(signal.reason ?? new DOMException("Job cancelled", "AbortError"));
    };

    const inspectDownload = async (startedId: number) => {
      try {
        const [item] = await downloads.search({ id: startedId });
        if (settled) return;
        if (signal.aborted) onAbort();
        else finishState(item?.state, item?.error);
      } catch (error) {
        cancelAndFinish(failed(error instanceof Error ? error.message : String(error)));
      }
    };
    const onStarted = async (startedId: number) => {
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
      await inspectDownload(startedId);
    };
    downloads.onChanged.addListener(onChanged);
    signal.addEventListener("abort", onAbort, { once: true });
    void downloads
      .download({ url, ...(filename ? { filename } : {}), saveAs: false })
      .then(onStarted, (error) =>
        finish({
          error: signal.aborted
            ? (signal.reason ?? new DOMException("Job cancelled", "AbortError"))
            : failed(error instanceof Error ? error.message : String(error)),
        }),
      );
  });
}
