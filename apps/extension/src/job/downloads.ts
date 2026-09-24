import { failure } from "@dezoomify/browser-runtime";
import type { Browser, WxtBrowser } from "wxt/browser";

export type DownloadsApi = Pick<
  WxtBrowser["downloads"],
  "download" | "search" | "open" | "show" | "onChanged"
>;
type DownloadItem = Browser.downloads.DownloadItem;
type DownloadDelta = Browser.downloads.DownloadDelta;

function saveFailure(detail: string, cause?: unknown) {
  const error = failure(
    "OUTPUT_SAVE_FAILED",
    "The browser could not finish saving the image.",
    false,
    detail,
    cause === undefined ? undefined : cause instanceof Error ? cause.message : String(cause),
  );
  return error;
}

/** Start this job's Blob download and wait for this exact browser download to finish. */
export async function downloadAndWait(
  downloads: DownloadsApi,
  url: string,
  filename: string,
): Promise<DownloadItem> {
  let id: number;
  try {
    id = await downloads.download({ url, filename });
  } catch (error) {
    throw saveFailure("browser rejected the save request", error);
  }
  if (!Number.isSafeInteger(id) || id < 0)
    throw saveFailure("browser returned an invalid download id");

  for (;;) {
    let resolveChange!: () => void;
    const changed = new Promise<void>((resolve) => {
      resolveChange = resolve;
    });
    const onChanged = (delta: DownloadDelta) => {
      if (delta.id === id) resolveChange();
    };
    downloads.onChanged.addListener(onChanged);
    try {
      let item: DownloadItem | undefined;
      try {
        [item] = await downloads.search({ id });
      } catch (error) {
        throw saveFailure("could not read the browser download status", error);
      }
      if (!item || item.id !== id) throw saveFailure("browser could not find this download");
      if (item.state === "complete") return item;
      if (item.state === "interrupted")
        throw saveFailure(`download interrupted${item.error ? ` (${item.error})` : ""}`);
      await changed;
    } finally {
      downloads.onChanged.removeListener(onChanged);
    }
  }
}

/** Invoke the browser's native action on this job's completed download. */
export async function actOnDownload(
  downloads: Pick<DownloadsApi, "open" | "show">,
  downloadId: number,
  action: "open" | "reveal",
): Promise<void> {
  if (action === "open") await downloads.open(downloadId);
  else downloads.show(downloadId);
}
