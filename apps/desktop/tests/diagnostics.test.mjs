import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticRecorder } from "../../../packages/app-model/src/diagnostics.ts";
import { createDesktopJobService } from "../src/jobService.ts";

test("desktop reads retained native diagnostics independently of snapshots", async () => {
  const d = createDiagnosticRecorder({ id: "native", now: () => 0 });
  d.finish("failed", { code: "tile.download-failed", http: 403 });
  const service = createDesktopJobService({
    ipc: {
      invoke: async (command, args) => {
        assert.equal(command, "get_job_diagnostics");
        assert.deepEqual(args, { job: "job:1" });
        return d.report();
      },
      listen: async () => () => {},
    },
  });
  assert.equal((await service.diagnostics("job:1")).outcome.fields.http, 403);
});
