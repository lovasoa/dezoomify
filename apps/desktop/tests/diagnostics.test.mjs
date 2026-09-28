import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticRecorder } from "../../../packages/shared-ui/src/diagnostics.ts";
import { readNativeDiagnostics } from "../src/native.ts";

test("desktop reads retained native diagnostics after a failed invocation", async () => {
  const d = createDiagnosticRecorder({ id: "native", now: () => 0 });
  d.finish("failed", { code: "tile.download-failed", http: 403 });
  const api = {
    invoke: async (command, args) => {
      assert.equal(command, "get_job_diagnostics");
      assert.deepEqual(args, { job: "job:1" });
      return d.report();
    },
    listen: async () => () => {},
  };
  assert.equal((await readNativeDiagnostics("job:1", api)).outcome.fields.http, 403);
});
