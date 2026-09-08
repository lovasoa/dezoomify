import test from "node:test";
import assert from "node:assert/strict";
import { buildCopyDiagnostics } from "../src/diagnostics.ts";

test("completed-job diagnostics retain file-action failures and tile counts", () => {
  const text = buildCopyDiagnostics({
    status: "completed", transport: "native", nativeTransport: "native",
    jobId: "job:2", sessionId: "sess:desktop", attempt: undefined,
    error: null, progress: { current: 4, total: 4 }, origin: "https://krpano.com",
    outputActionError: { action: "folder", code: "output.launch-failed" },
  });
  assert.match(text, /Status: completed/);
  assert.match(text, /Tiles: 4 of 4/);
  assert.match(text, /File action: folder/);
  assert.match(text, /File action code: output.launch-failed/);
});
