import type { DiagnosticRecorder } from "../../shared-ui/src/diagnostics.ts";
import { tileError } from "./failure.ts";

export interface TileBitmap {
  width: number;
  height: number;
  close(): void;
}
export interface TileDecodeHost {
  createImageBitmap?: (blob: unknown) => Promise<unknown>;
  blobCtor?: new (parts: Array<unknown>, opts?: { type?: string }) => unknown;
}
export interface TileDecoder {
  /** Success transfers the bitmap to the caller, which must close it. Aborting
   * rejects the wait immediately; the native decoder may still be running. */
  decode(bytes: ArrayBuffer, signal?: AbortSignal): Promise<TileBitmap>;
  /** Reject pending waits and close their eventual results. Already returned
   * bitmaps remain the caller's responsibility. */
  dispose(): void;
  /** Await native callbacks before reusing invocation resources. Call dispose
   * first and stop submitting work; settlement alone does not prevent new decodes. */
  settle(): Promise<void>;
}

export function createTileDecoder(
  host: TileDecodeHost = {},
  diagnostics?: DiagnosticRecorder,
): TileDecoder {
  const lifetime = new AbortController();
  const pending = new Set<Promise<void>>();
  return {
    decode(bytes, signal) {
      const owned = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      if (owned.aborted) return Promise.reject({ kind: "cancelled" });
      const decode = host.createImageBitmap ?? globalThis.createImageBitmap;
      const BlobClass = host.blobCtor ?? Blob;
      return new Promise<TileBitmap>((resolve, reject) => {
        const abort = () => reject({ kind: "cancelled" });
        owned.addEventListener("abort", abort, { once: true });
        const work = Promise.resolve()
          .then(() => {
            owned.throwIfAborted();
            return decode(new BlobClass([bytes]) as Blob);
          })
          .then(
            (value) => {
              owned.removeEventListener("abort", abort);
              const bitmap = value as TileBitmap;
              if (owned.aborted) {
                bitmap.close();
                reject({ kind: "cancelled" });
              } else resolve(bitmap);
            },
            (error) => {
              owned.removeEventListener("abort", abort);
              diagnostics?.record("debug", "decode-failed", error);
              reject(owned.aborted ? { kind: "cancelled" } : tileError("decode-failed", error));
            },
          )
          .finally(() => pending.delete(work));
        pending.add(work);
        void work.catch(reject);
      });
    },
    dispose() {
      lifetime.abort();
    },
    async settle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
