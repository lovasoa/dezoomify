// GENERATED from packages/browser-runtime/src/tile-decode.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/browser-runtime/src/tile-decode.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

// Off-main-thread tile decode (todo 2.2 home, moved from `src/main.ts`).
//
// When Worker plus OffscreenCanvas exist, createImageBitmap plus drawImage
// run in a singleton decode worker (Blob URL, no extra file) and the
// ImageBitmap is transferred back; the main thread only paints the finished
// bitmap. Otherwise this falls back to main-thread createImageBitmap. Full
// transferControlToOffscreen drawing stays out: it would break the ordinary
// <img> display-only fallback and the canvas.toBlob save path, while decode
// offload already removes the costly raster from the main thread.
//
// All host constructors are injected so node tests drive the fallback and
// worker paths with fakes. Keep erasable-syntax-only for the mirrors.

export function tileDecodeWorkerCode()         {
  return (
    "self.onmessage = async (e) => {\n" +
    "  const data = e.data || {};\n" +
    "  const id = data.id;\n" +
    "  try {\n" +
    "    const bitmap = await createImageBitmap(new Blob([data.bytes]));\n" +
    "    let out = bitmap;\n" +
    "    try {\n" +
    '      if (typeof OffscreenCanvas !== "undefined") {\n' +
    "        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);\n" +
    '        const ctx = canvas.getContext("2d");\n' +
    "        if (ctx) {\n" +
    "          ctx.drawImage(bitmap, 0, 0);\n" +
    "          out = canvas.transferToImageBitmap();\n" +
    "          try { bitmap.close(); } catch (err) {}\n" +
    "        }\n" +
    "      }\n" +
    "    } catch (err) {}\n" +
    "    self.postMessage({ id, ok: true, bitmap: out }, [out]);\n" +
    "  } catch (err) {\n" +
    "    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });\n" +
    "  }\n" +
    "};\n"
  );
}

export function createTileDecoder(host                 )              {
  const h = host ?? {};
  let worker                              = null;
  let seq = 0;
  let unavailable = false;
  const pending = new Map                                                                            ();

  function defaultHostAvailable()          {
    if (h.workerCtor || h.createImageBitmap || h.blobCtor || h.createObjectURL) return true;
    try {
      return (
        typeof Worker !== "undefined" &&
        (h.offscreenCanvasAvailable ?? (typeof OffscreenCanvas !== "undefined")) &&
        typeof Blob !== "undefined" &&
        typeof URL !== "undefined" &&
        typeof (URL                                            ).createObjectURL === "function" &&
        typeof createImageBitmap === "function"
      );
    } catch {
      return false;
    }
  }

  function spawnWorker()                              {
    if (unavailable) return null;
    if (worker) return worker;
    try {
      const WorkerCtor =
        h.workerCtor ??
        (typeof Worker !== "undefined" ? (Worker                                                        ) : undefined);
      const blobCtor =
        h.blobCtor ?? (typeof Blob !== "undefined" ? (Blob                                         ) : undefined);
      const createUrl =
        h.createObjectURL ??
        (typeof URL !== "undefined"
          ? (URL                                                           ).createObjectURL?.bind(URL)
          : undefined);
      const offscreen =
        h.offscreenCanvasAvailable ?? (typeof OffscreenCanvas !== "undefined");
      if (!WorkerCtor || !blobCtor || !createUrl || !offscreen) {
        unavailable = true;
        return null;
      }
      const w                       = new WorkerCtor(
        createUrl(new blobCtor([tileDecodeWorkerCode()], { type: "text/javascript" })),
      );
      w.onmessage = (e                    ) => {
        const data = (e?.data ?? {})                                                                     ;
        const id = typeof data.id === "number" ? data.id : -1;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (data.ok === true && data.bitmap) {
          entry.resolve(data.bitmap              );
        } else {
          entry.reject(new Error(typeof data.error === "string" ? data.error : "tile decode failed"));
        }
      };
      w.onerror = () => {
        unavailable = true;
        for (const [, entry] of pending) {
          try {
            entry.reject(new Error("tile decode worker failed"));
          } catch {
            // Rejecting must never throw.
          }
        }
        pending.clear();
        try {
          w.terminate();
        } catch {
          // Termination is best-effort.
        }
        worker = null;
      };
      worker = w;
      return w;
    } catch {
      unavailable = true;
      return null;
    }
  }

  function mainThreadDecode(bytes             )                      {
    const rawImpl = h.createImageBitmap ?? (typeof createImageBitmap === "function" ? createImageBitmap : undefined);
    const impl = rawImpl                                                     ;
    const blobCtor = h.blobCtor ?? (typeof Blob !== "undefined" ? Blob : undefined);
    if (!impl || !blobCtor) return Promise.reject(new Error("tile decode unavailable: no createImageBitmap"));
    try {
      return (impl(new blobCtor([bytes]))                       ).catch((e) => {
        throw e;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function decode(bytes             )                      {
    const w = defaultHostAvailable() ? spawnWorker() : null;
    if (!w) return mainThreadDecode(bytes);
    try {
      const id = ++seq;
      const copy = bytes.slice(0);
      const gate = new Promise            ((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
      try {
        w.postMessage({ id, bytes: copy }, [copy]);
      } catch {
        pending.delete(id);
        return mainThreadDecode(bytes);
      }
      return gate.catch(() => mainThreadDecode(bytes));
    } catch {
      return mainThreadDecode(bytes);
    }
  }

  function dispose()       {
    unavailable = true;
    for (const [, entry] of pending) {
      try {
        entry.reject(new Error("tile decoder disposed"));
      } catch {
        // Rejecting must never throw.
      }
    }
    pending.clear();
    try {
      worker?.terminate();
    } catch {
      // Termination is best-effort.
    }
    worker = null;
  }

  return {
    decode,
    dispose,
    get workered()          {
      return worker !== null;
    },
  };
}
