// Packaged off-main-thread tile decode worker.
//
// This is a real bundled module (loaded via `new Worker(new URL(...))`), not
// a string-built Blob URL: bundlers (Vite for the website, wxt for the
// extension) package it once and content-hash it like any other module.
// Behavior: decode `bytes` with createImageBitmap, normalize through an
// OffscreenCanvas when available, and transfer the finished bitmap back so
// the main thread only paints. Main-thread createImageBitmap stays the
// fallback (see `tile-decode.ts`); this module never touches the DOM.
// Minimal worker scope: this module runs as a dedicated worker, never on
// the page. Declared locally so the package build keeps DOM-only libs.
declare const self: {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

self.onmessage = async (e: MessageEvent) => {
  const data = (e.data ?? {}) as { id?: unknown; bytes?: unknown };
  const id = data.id;
  try {
    const bitmap = await createImageBitmap(new Blob([data.bytes as BlobPart]));
    let out: ImageBitmap = bitmap;
    try {
      if (typeof OffscreenCanvas !== "undefined") {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
          out = canvas.transferToImageBitmap();
          try {
            bitmap.close();
          } catch {
            // Cleanup is best-effort.
          }
        }
      }
    } catch {
      // Normalization is best-effort; the raw bitmap still decodes.
    }
    self.postMessage({ id, ok: true, bitmap: out }, [out]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err as Error)?.message ?? err) });
  }
};

export {};
