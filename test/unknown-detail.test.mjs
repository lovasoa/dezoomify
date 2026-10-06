import assert from "node:assert/strict";
import test from "node:test";
import { unknownDetail } from "../packages/shared-ui/src/failure.ts";

test("unknown throws never render as [object Object]", () => {
  assert.equal(
    unknownDetail({ kind: "http-error", status: 404 }),
    '{"kind":"http-error","status":404}',
  );
  assert.equal(unknownDetail(new Error("boom")), "Error: boom");
  assert.ok(!unknownDetail({ a: 1 }).includes("[object Object]"));
});
