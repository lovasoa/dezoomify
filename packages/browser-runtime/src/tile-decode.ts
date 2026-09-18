// Off-main-thread tile decode.
// When Worker plus OffscreenCanvas exist, createImageBitmap plus drawImage
// run in the packaged decode worker (`./tile-decode-worker.ts`, bundled once
// like any other module -- never a string-built Blob URL) and the ImageBitmap
// is transferred back; the main thread only paints the finished bitmap.
// Otherwise this falls back to main-thread createImageBitmap. Full
// transferControlToOffscreen drawing stays out: it would break the ordinary
// <img> display-only fallback and the canvas.toBlob save path, while decode
// offload already removes the costly raster from the main thread.
//
// All host constructors are injected so node tests drive the fallback and
// worker paths with fakes.
export interface TileDecodeHost {
  workerCtor?: new (url: string | URL) => TileDecodeWorkerLike;
  /** Packaged worker URL override (tests); defaults to the bundled module. */
  workerUrl?: string | URL;
  createImageBitmap?: (blob: unknown) => Promise<unknown>;
  blobCtor?: new (parts: Array<unknown>, opts?: { type?: string }) => unknown;
  offscreenCanvasAvailable?: boolean;
}

export interface TileDecodeWorkerLike {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
  onmessage: ((ev: { data?: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface TileBitmap {
  width: number;
  height: number;
  close(): void;
}

export interface TileDecoder {
  decode(bytes: ArrayBuffer): Promise<TileBitmap>;
  dispose(): void;
  get workered(): boolean;
}

export function createTileDecoder(host?: TileDecodeHost): TileDecoder {
  const h = host ?? {};
  let worker: TileDecodeWorkerLike | null = null;
  let seq = 0;
  let unavailable = false;
  const pending = new Map<number, { resolve: (b: TileBitmap) => void; reject: (e: unknown) => void }>();

  function defaultHostAvailable(): boolean {
    if (h.workerCtor || h.workerUrl) return true;
    try {
      return (
        typeof Worker !== "undefined" &&
        (h.offscreenCanvasAvailable ?? (typeof OffscreenCanvas !== "undefined")) &&
        typeof createImageBitmap === "function"
      );
    } catch {
      return false;
    }
  }

  function spawnWorker(): TileDecodeWorkerLike | null {
    if (unavailable) return null;
    if (worker) return worker;
    try {
      const WorkerCtor =
        h.workerCtor ??
        (typeof Worker !== "undefined" ? (Worker as unknown as new (url: string | URL) => TileDecodeWorkerLike) : undefined);
      const offscreen =
        h.offscreenCanvasAvailable ?? (typeof OffscreenCanvas !== "undefined");
      // The packaged decode module; bundlers resolve and hash it at build
      // time. Tests inject `workerUrl`/`workerCtor` fakes instead.
      const url = h.workerUrl ?? new URL("./tile-decode-worker.ts", import.meta.url);
      if (!WorkerCtor || !offscreen) {
        unavailable = true;
        return null;
      }
      const w: TileDecodeWorkerLike = new WorkerCtor(url);
      w.onmessage = (e: { data?: unknown }) => {
        const data = (e?.data ?? {}) as { id?: unknown; ok?: unknown; bitmap?: unknown; error?: unknown };
        const id = typeof data.id === "number" ? data.id : -1;
        const entry = pending.get(id);
        if (!entry) return;
        pending.delete(id);
        if (data.ok === true && data.bitmap) {
          entry.resolve(data.bitmap as TileBitmap);
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

  function mainThreadDecode(bytes: ArrayBuffer): Promise<TileBitmap> {
    const rawImpl = h.createImageBitmap ?? (typeof createImageBitmap === "function" ? createImageBitmap : undefined);
    const impl = rawImpl as ((blob: unknown) => Promise<unknown>) | undefined;
    const blobCtor = h.blobCtor ?? (typeof Blob !== "undefined" ? Blob : undefined);
    if (!impl || !blobCtor) return Promise.reject(new Error("tile decode unavailable: no createImageBitmap"));
    try {
      return (impl(new blobCtor([bytes])) as Promise<TileBitmap>).catch((e) => {
        throw e;
      });
    } catch (e) {
      return Promise.reject(e);
    }
  }

  function decode(bytes: ArrayBuffer): Promise<TileBitmap> {
    const w = defaultHostAvailable() ? spawnWorker() : null;
    if (!w) return mainThreadDecode(bytes);
    try {
      const id = ++seq;
      const copy = bytes.slice(0);
      const gate = new Promise<TileBitmap>((resolve, reject) => {
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

  function dispose(): void {
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
    get workered(): boolean {
      return worker !== null;
    },
  };
}
