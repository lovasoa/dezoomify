// GENERATED from packages/browser-runtime/src/session.ts by scripts/sync-web-js.mjs. Do not hand-edit.
// Source of truth: packages/browser-runtime/src/session.ts (erasable-syntax TypeScript). Regenerate with:
//   node scripts/sync-web-js.mjs

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

export function failure(code        , message        , retryable = true)                    {
  const error = new Error(message)                     ;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function createDiscoveryClient(deps                     )                  {
  const { worker } = deps;
  let pending                 = null;
  let pendingKind                                      = null;
  let currentImage = 0;
  let currentLevel = 0;
  let disposed = false;

  worker.onmessage = (ev                   ) => {
    const raw = ev.data                                                ;
    if (raw === null || typeof raw !== "object" || typeof raw.type !== "string") return;
    const msg = raw                                              ;
    switch (msg.type) {
      case "need": {
        const id = msg.id          ;
        const uri = msg.uri          ;
        const headers = (msg.headers ?? {})                          ;
        deps
          .fetchMetadata(uri, headers)
          .then(({ bytes, finalUri }) => {
            worker.postMessage(
              { type: "provide", id, bytes, finalUri: finalUri ?? "" },
              [bytes],
            );
          })
          .catch((error         ) => {
            const structured = error                                       ;
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
        settle("start", msg.catalog              );
        return;
      case "plan":
        settle("plan", {
          canvas: msg.canvas                                        ,
          tiles: (msg.tiles ?? [])              ,
        });
        return;
      case "probe": {
        const uri = msg.uri          ;
        const headers = (msg.headers ?? {})                          ;
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
        settle("process", msg.bytes               );
        return;
      case "error": {
        const code = (msg.code          ) || "DISCOVERY_FAILED";
        const err = failure(
          code,
          (msg.message          ) || "Discovery failed.",
          code !== "NO_IMAGE_FOUND",
        );
        rejectPending(err);
        return;
      }
      default:
        return;
    }
  };

  function settle(kind                              , value         )       {
    // A message for another operation must never cancel the pending one:
    // ignore kind mismatches without clearing pending state.
    if (pendingKind !== kind || !pending) return;
    const current = pending;
    pending = null;
    pendingKind = null;
    (current.resolve                        )(value);
  }

  function rejectPending(error         )       {
    const current = pending;
    pending = null;
    pendingKind = null;
    current?.reject(error);
  }

  function send(
    message                         ,
    kind                              ,
  )                   {
    if (disposed) {
      return Promise.reject(failure("DISPOSED", "Discovery client is disposed.", false));
    }
    if (pending) {
      return Promise.reject(
        failure("CLIENT_BUSY", "Another discovery operation is already running.", false),
      );
    }
    return new Promise((resolve, reject) => {
      pending = { resolve: resolve         , reject };
      pendingKind = kind;
      worker.postMessage(message);
    });
  }

  return {
    start(url        )                      {
      currentImage = 0;
      currentLevel = 0;
      return send({ type: "start", url }, "start")                       ;
    },
    plan(image        , level        )                    {
      currentImage = image;
      currentLevel = level;
      return send({ type: "plan", image, level }, "plan")                     ;
    },
    process(recipe        , bytes             )                       {
      return send({ type: "process", recipe, bytes }, "process").then(
        (value) => value               ,
      );
    },
    dispose()       {
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
