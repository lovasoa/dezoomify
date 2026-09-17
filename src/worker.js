// Web worker: owns the real wasm job-engine Session. Pure computation: the
// worker never fetches anything; the main thread performs every network
// request through the classified transport and feeds bytes back here. The
// shared worker host keeps commands and effects as protocol envelopes, so
// the website and the extension run the same engine session.
import { createJobWorkerHost } from "../packages/browser-runtime/src/worker-host.ts";
import init, { Session } from "../wasm/dezoomify-wasm.js";

const host = createJobWorkerHost({
  postMessage: (message, transfer) => self.postMessage(message, transfer ?? []),
  wasm: async () => ({ default: init, Session }),
});

self.addEventListener("message", (event) => {
  void host.onMessage(event.data);
});
