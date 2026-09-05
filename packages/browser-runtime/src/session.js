// Browser-importable mirror of session.ts (no build step). Keep both files
// in sync: session.ts is type-checked and node-tested, this mirror is what
// the browser ES module imports.

export function failure(code, message, retryable = true) {
  const error = new Error(message);
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function createDiscoveryClient(deps) {
  const { worker } = deps;
  let pending = null;
  let pendingKind = null;
  let currentImage = 0;
  let currentLevel = 0;
  let disposed = false;

  worker.onmessage = (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "need": {
        const { id, uri } = msg;
        const headers = msg.headers ?? {};
        deps
          .fetchMetadata(uri, headers)
          .then(({ bytes, finalUri }) => {
            worker.postMessage(
              { type: "provide", id, bytes, finalUri: finalUri ?? "" },
              [bytes],
            );
          })
          .catch((error) => {
            worker.postMessage({
              type: "fail",
              id,
              message: (error && error.message) || String(error),
              code: (error && error.code) || "DISCOVERY_FAILED",
            });
          });
        return;
      }
      case "catalog":
        settle("start", msg.catalog);
        return;
      case "plan":
        settle("plan", {
          canvas: msg.canvas,
          tiles: msg.tiles ?? [],
        });
        return;
      case "probe": {
        const { uri } = msg;
        const headers = msg.headers ?? {};
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
        settle("process", msg.bytes);
        return;
      case "error": {
        const code = msg.code || "DISCOVERY_FAILED";
        rejectPending(
          failure(code, msg.message || "Discovery failed.", code !== "NO_IMAGE_FOUND"),
        );
        return;
      }
      default:
        return;
    }
  };

  function settle(kind, value) {
    if (pendingKind !== kind || !pending) return;
    const current = pending;
    pending = null;
    pendingKind = null;
    current.resolve(value);
  }

  function rejectPending(error) {
    const current = pending;
    pending = null;
    pendingKind = null;
    if (current) current.reject(error);
  }

  function send(message, kind) {
    if (disposed) {
      return Promise.reject(failure("DISPOSED", "Discovery client is disposed.", false));
    }
    if (pending) {
      return Promise.reject(
        failure("CLIENT_BUSY", "Another discovery operation is already running.", false),
      );
    }
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
      pendingKind = kind;
      worker.postMessage(message);
    });
  }

  return {
    start(url) {
      currentImage = 0;
      currentLevel = 0;
      return send({ type: "start", url }, "start");
    },
    plan(image, level) {
      currentImage = image;
      currentLevel = level;
      return send({ type: "plan", image, level }, "plan");
    },
    process(recipe, bytes) {
      return send({ type: "process", recipe, bytes }, "process");
    },
    dispose() {
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
