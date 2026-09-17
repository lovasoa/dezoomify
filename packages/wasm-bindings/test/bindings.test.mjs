import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const declaration = await readFile(
  new URL("../src/generated.d.ts", import.meta.url),
  "utf8",
);

test("tracked declarations expose the generated typed object ABI", () => {
  assert.match(declaration, /export type JobCommand =/);
  assert.match(declaration, /export type HostMessage =/);
  assert.match(declaration, /export type DispatchResult =/);
  assert.match(declaration, /constructor\(config: SessionConfig\)/);
  assert.match(declaration, /dispatch\(command: JobCommand\): DispatchResult/);
  assert.match(declaration, /dispose\(\): DispatchResult/);
});

test("job failures carry closed typed context", () => {
  assert.match(declaration, /phase: ErrorPhase/);
  assert.match(declaration, /transport\?: ErrorTransport/);
  assert.match(declaration, /blocked_reason\?: BlockedReason/);
  assert.match(declaration, /resource_kind\?: ResourceKind/);
  assert.match(declaration, /export type JobState =/);
  assert.match(declaration, /http\?: number/);
  assert.match(declaration, /detail\?: string/);
});
