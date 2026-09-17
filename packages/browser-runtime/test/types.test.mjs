import test from "node:test";
import assert from "node:assert/strict";
import {
  SAVE_REQUIRES_READABLE_BYTES,
  saveCapabilityFor,
  DIRECT_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
} from "../src/types.ts";

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
