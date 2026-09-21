import test from "node:test";
import assert from "node:assert/strict";
import {
  canvasTooLargeFailure,
  desktopHandoffLink,
  isLocalFileUrl,
} from "../src/plan-gates.ts";
import { BROWSER_MAX_CANVAS_AREA } from "../src/limits.ts";

test("desktopHandoffLink encodes the source", () => {
  assert.equal(
    desktopHandoffLink("https://example.test/view?a=b"),
    "dezoomify://open?v=2&src=https%3A%2F%2Fexample.test%2Fview%3Fa%3Db",
  );
});

test("browser canvas bound matches 16384 px per side", () => {
  assert.equal(BROWSER_MAX_CANVAS_AREA, 16384 * 16384);
});

test("canvasTooLargeFailure carries both layers", () => {
  const failure = canvasTooLargeFailure(10, 20, "https://a.test/");
  assert.equal(failure.code, "PLAN_INVALID");
  assert.equal(failure.retryable, false);
  assert.match(failure.detail ?? "", /dezoomify:\/\/open/);
  assert.match(failure.technical ?? "", /canvas 10x20/);
});

test("local-file detection distinguishes file URLs", () => {
  assert.equal(isLocalFileUrl("file:///tmp/x"), true);
  assert.equal(isLocalFileUrl("https://a.test/"), false);
});
