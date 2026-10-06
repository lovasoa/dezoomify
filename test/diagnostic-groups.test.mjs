import assert from "node:assert/strict";
import test from "node:test";
import { createDiagnosticRecorder } from "../packages/shared-ui/src/diagnostics.ts";

const recorder = () => createDiagnosticRecorder({ id: "test", now: () => 0, context: {} });

test("policy denials with different reasons form separate groups", () => {
  const d = recorder();
  d.record("warn", "request-failed", {
    kind: "policy-denied",
    blocked_reason: "signed-query",
    transport: "metadata-proxy",
  });
  d.record("warn", "request-failed", {
    kind: "policy-denied",
    blocked_reason: "private-host",
    transport: "metadata-proxy",
  });
  assert.equal(d.report().failures.length, 2);
});

test("same policy denial reason stays in one group", () => {
  const d = recorder();
  for (let i = 0; i < 3; i++)
    d.record("warn", "request-failed", {
      kind: "policy-denied",
      blocked_reason: "signed-query",
      transport: "metadata-proxy",
    });
  const failures = d.report().failures;
  assert.equal(failures.length, 1);
  assert.equal(failures[0].count, 3);
});
