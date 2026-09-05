// Discovery client over a real worker that owns the wasm `DiscoverySession`.
//
// The client runs on the main thread and owns every network decision
// (direct-first transport, metadata proxy fallback, tile policy); the worker
// is a pure compute engine: it hosts the wasm core discovery session and
// never fetches anything itself. Messages:
//
//   main -> worker: {type:"start", url}            begin discovery
//                   {type:"provide", id, bytes, finalUri}
//                   {type:"fail", id, message}
//                   {type:"plan", image, level}
//                   {type:"probe-submit", image, level, ok, width, height}
//                   {type:"process", recipe, bytes}
//   worker -> main: {type:"need", id, uri, headers}
//                   {type:"catalog", catalog}
//                   {type:"plan", canvas, tiles} | {type:"probe", uri, headers}
//                   {type:"processed", bytes}
//                   {type:"error", code, message}

export interface WorkerLike {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  terminate(): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export interface CatalogLevel {
  index: number;
  title?: string;
  scale?: number;
  imageSize?: { x: number; y: number };
}

export interface CatalogImage {
  id: number;
  title?: string;
  format: string;
  levels: CatalogLevel[];
}

export interface WebCatalog {
  images: CatalogImage[];
}

export interface PlanTile {
  uri: string;
  headers: Record<string, string>;
  x: number;
  y: number;
  w?: number;
  h?: number;
  processing: string;
}

export interface TilePlan {
  canvas?: { x: number; y: number };
  tiles: PlanTile[];
}

export interface StructuredFailure extends Error {
  code: string;
  retryable: boolean;
}

export function failure(code: string, message: string, retryable = true): StructuredFailure {
  const error = new Error(message) as StructuredFailure;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export interface DiscoveryClientDeps {
  worker: WorkerLike;
  /** Fetch one metadata resource (direct-first + eligible proxy fallback). */
  fetchMetadata(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ bytes: ArrayBuffer; finalUri?: string }>;
  /** Fetch one tile as readable bytes (direct only; never the proxy). */
  fetchTile(url: string, headers: Record<string, string>): Promise<{ bytes: ArrayBuffer }>;
  /** Decode one probe tile far enough to report its size. */
  probeSize(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; width: number; height: number }>;
}

export interface DiscoveryClient {
  start(url: string): Promise<WebCatalog>;
  plan(image: number, level: number): Promise<TilePlan>;
  process(recipe: string, bytes: ArrayBuffer): Promise<ArrayBuffer>;
  dispose(): void;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (error: unknown) => void;
}

export function createDiscoveryClient(deps: DiscoveryClientDeps): DiscoveryClient {
  const { worker } = deps;
  let pending: Pending | null = null;
  let pendingKind: "start" | "plan" | "process" | null = null;
  let currentImage = 0;
  let currentLevel = 0;
  let disposed = false;

  worker.onmessage = (ev: { data: unknown }) => {
    const msg = ev.data as Record<string, unknown> & { type: string };
    switch (msg.type) {
      case "need": {
        const id = msg.id as number;
        const uri = msg.uri as string;
        const headers = (msg.headers ?? {}) as Record<string, string>;
        deps
          .fetchMetadata(uri, headers)
          .then(({ bytes, finalUri }) => {
            worker.postMessage(
              { type: "provide", id, bytes, finalUri: finalUri ?? "" },
              [bytes],
            );
          })
          .catch((error: unknown) => {
            const structured = error as { code?: string; message?: string };
            worker.postMessage({
              type: "fail",
              id,
              message: structured?.message || String(error),
              code: structured?.code || "DISCOVERY_FAILED",
            });
          });
        return;
      }
      case "catalog":
        settle(pendingKind === "start" ? pending : null, msg.catalog as WebCatalog);
        return;
      case "plan":
        settle(pendingKind === "plan" ? pending : null, {
          canvas: msg.canvas as { x: number; y: number } | undefined,
          tiles: (msg.tiles ?? []) as PlanTile[],
        });
        return;
      case "probe": {
        const uri = msg.uri as string;
        const headers = (msg.headers ?? {}) as Record<string, string>;
        deps
          .probeSize(uri, headers)
          .then((size) => {
            worker.postMessage({
              type: "probe-submit",
              image: currentImage,
              level: currentLevel,
              ok: size.ok,
              width: size.width,
              height: size.height,
            });
          })
          .catch(() => {
            worker.postMessage({
              type: "probe-submit",
              image: currentImage,
              level: currentLevel,
              ok: false,
              width: 0,
              height: 0,
            });
          });
        return;
      }
      case "processed":
        settle(pendingKind === "process" ? pending : null, msg.bytes as ArrayBuffer);
        return;
      case "error": {
        const code = (msg.code as string) || "DISCOVERY_FAILED";
        const err = failure(
          code,
          (msg.message as string) || "Discovery failed.",
          code !== "NO_IMAGE_FOUND",
        );
        rejectPending(err);
        return;
      }
      default:
        return;
    }
  };

  function settle(kind: Pending | null, value: unknown): void {
    const current = pending;
    pending = null;
    pendingKind = null;
    if (kind && current === kind) {
      (current.resolve as (v: unknown) => void)(value);
    }
  }

  function rejectPending(error: unknown): void {
    const current = pending;
    pending = null;
    pendingKind = null;
    current?.reject(error);
  }

  function send(
    message: Record<string, unknown>,
    kind: "start" | "plan" | "process",
  ): Promise<unknown> {
    if (disposed) {
      return Promise.reject(failure("DISPOSED", "Discovery client is disposed.", false));
    }
    if (pending) {
      return Promise.reject(
        failure("CLIENT_BUSY", "Another discovery operation is already running.", false),
      );
    }
    return new Promise((resolve, reject) => {
      pending = { resolve: resolve as never, reject };
      pendingKind = kind;
      worker.postMessage(message);
    });
  }

  return {
    start(url: string): Promise<WebCatalog> {
      currentImage = 0;
      currentLevel = 0;
      return send({ type: "start", url }, "start") as Promise<WebCatalog>;
    },
    plan(image: number, level: number): Promise<TilePlan> {
      currentImage = image;
      currentLevel = level;
      return send({ type: "plan", image, level }, "plan") as Promise<TilePlan>;
    },
    process(recipe: string, bytes: ArrayBuffer): Promise<ArrayBuffer> {
      return send({ type: "process", recipe, bytes }, "process").then(
        (value) => value as ArrayBuffer,
      );
    },
    dispose(): void {
      disposed = true;
      rejectPending(failure("DISPOSED", "Discovery client is disposed.", false));
      try {
        worker.terminate();
      } catch {
        // Terminating twice must never throw.
      }
    },
  };
}
