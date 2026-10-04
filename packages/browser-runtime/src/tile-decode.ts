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
  decode(bytes: ArrayBuffer, signal?: AbortSignal): Promise<TileBitmap>;
  dispose(): void;
  settle(): Promise<void>;
}

/** Browser image decoding owns its pixels until painting or cancellation closes them. */
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
