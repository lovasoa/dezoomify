import assert from "node:assert/strict";
import test from "node:test";
import { buildCopyDiagnostics } from "../src/diagnostics.ts";

test("completed-job diagnostics retain file-action failures and tile counts", () => {
  const text = buildCopyDiagnostics({
    status: "completed",
    transport: "native",
    nativeTransport: "native",
    jobId: "job:2",
    sessionId: "sess:desktop",
    attempt: undefined,
    progress: { current: 4, total: 4 },
    origin: "https://krpano.com",
    outputActionError: { action: "folder", code: "output.launch-failed" },
  });
  assert.match(text, /Status: completed/);
  assert.match(text, /Tiles: 4 of 4/);
  assert.match(text, /File action: folder/);
  assert.match(text, /File action code: output.launch-failed/);
  // Provenance only: the typed error context comes from the shared
  // renderer the caller prepends and is never duplicated here.
  assert.ok(!text.includes("Code:"), "no duplicated code line");
  assert.ok(!text.includes("Message:"), "no duplicated message line");
});
