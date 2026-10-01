import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticRecorder } from "../../../packages/shared-ui/src/diagnostics.ts";
import { readNativeDiagnostics } from "../src/native.ts";

function fakeApi(invoke) {
  return { invoke, listen: async () => () => {} };
}

test("desktop requests job diagnostics by job id and returns the report unchanged", async () => {
  const d = createDiagnosticRecorder({ id: "native", now: () => 0 });
  d.finish("failed", { code: "TRANSPORT_HTTP_ERROR", http: 403 });
  const report = d.report();
  const calls = [];
  const api = fakeApi(async (command, args) => {
    calls.push({ command, args });
    return report;
  });
  const result = await readNativeDiagnostics("job:1", api);
  assert.deepEqual(calls, [{ command: "get_job_diagnostics", args: { job: "job:1" } }]);
  // readNativeDiagnostics owns no report shaping: the retained report
  // crosses the IPC boundary as-is.
  assert.equal(result, report);
});

test("desktop passes through when the native side retains no report", async () => {
  for (const missing of [null, undefined]) {
    const api = fakeApi(async () => missing);
    assert.equal(await readNativeDiagnostics("job:1", api), missing);
  }
});
