/**
 * Dedicated job-worker entrypoint. It is intentionally a thin host around
 * the Rust/WASM Session. Commands and results cross the generated object ABI;
 * this file cannot grow a second JavaScript state machine.
 */

import { createJobWorkerHost } from "@dezoomify/browser-runtime/worker-host";

// The WXT worker bundle lives below assets/. Resolve the generated glue from
// the extension root so it stays a generated public artifact, not JS source.
if (
  typeof self !== "undefined" &&
  "postMessage" in self &&
  typeof WorkerGlobalScope !== "undefined" &&
  self instanceof WorkerGlobalScope
) {
  const host = createJobWorkerHost({
    postMessage: (message, transfer) => self.postMessage(message, transfer ?? []),
    wasm: () =>
      import(/* @vite-ignore */ new URL("../wasm/dezoomify-wasm.js", self.location.href).href),
  });
  self.addEventListener("message", (event) => {
    void host.onMessage(event.data);
  });
}
