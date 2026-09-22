/**
 * Dedicated job-worker entrypoint. It is intentionally a thin host around
 * the Rust/WASM Session. Commands and results cross the generated object ABI;
 * this file cannot grow a second JavaScript state machine.
 */

import { createLogger } from "@dezoomify/browser-runtime/logging";
import { createJobWorkerHost } from "@dezoomify/browser-runtime/worker-host";

// The WXT worker bundle lives below assets/. Resolve the generated glue from
// the extension root so it stays a generated public artifact, not JS source.
if (
  typeof self !== "undefined" &&
  "postMessage" in self &&
  typeof WorkerGlobalScope !== "undefined" &&
  self instanceof WorkerGlobalScope
) {
  const workerLogger = createLogger("worker");
  // Forward accepted worker lines to the job tab so the failed view's
  // technical details include the core session trace, not only job-tab lines.
  workerLogger.addSink((entry) =>
    self.postMessage({
      type: "engine.log",
      level: entry.level,
      code: entry.code,
      line: entry.line,
    }),
  );
  const host = createJobWorkerHost({
    postMessage: (message, transfer) => self.postMessage(message, transfer ?? []),
    wasm: () =>
      import(/* @vite-ignore */ new URL("../wasm/dezoomify-wasm.js", self.location.href).href),
    log: (level, code, detail) => workerLogger.log(level, code, detail),
  });
  self.addEventListener("message", (event) => {
    void host.onMessage(event.data);
  });
}
