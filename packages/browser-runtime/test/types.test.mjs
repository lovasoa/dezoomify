import test from "node:test";
import assert from "node:assert/strict";
import {
  SAVE_REQUIRES_READABLE_BYTES,
  ERROR_CODES,
  describeOutcome,
  assertNever,
  saveCapabilityFor,
  DIRECT_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
} from "../src/types.ts";

test("error codes include SAVE_REQUIRES_READABLE_BYTES", () => {
  assert.equal(SAVE_REQUIRES_READABLE_BYTES, "SAVE_REQUIRES_READABLE_BYTES");
  assert.equal(ERROR_CODES.SAVE_REQUIRES_READABLE_BYTES, "SAVE_REQUIRES_READABLE_BYTES");
});

test("exhaustive switch covers all transport outcomes", () => {
  const outcomes = [
    "readable",
    "ordinary-image-allowed",
    "http-error",
    "network-error",
    "cancelled",
    "policy-denied",
  ];
  for (const o of outcomes) {
    const s = describeOutcome(o);
    assert.ok(typeof s === "string" && s.length > 0, o);
  }
});

test("assertNever throws on unreachable", () => {
  assert.throws(() => assertNever("oops"), /unexpected value/);
});

test("saveCapabilityFor is denied when tainted", () => {
  const clean = saveCapabilityFor(true);
  assert.equal(clean.available, true);
  const tainted = saveCapabilityFor(false);
  assert.equal(tainted.available, false);
  assert.equal(tainted.code, SAVE_REQUIRES_READABLE_BYTES);
});

test("transport labels are visible and distinct", () => {
  assert.equal(DIRECT_TRANSPORT_LABEL, "Direct from your browser");
  assert.equal(PROXY_TRANSPORT_LABEL, "Metadata proxy");
  assert.notEqual(DIRECT_TRANSPORT_LABEL, PROXY_TRANSPORT_LABEL);
});
