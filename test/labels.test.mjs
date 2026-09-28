import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_SESSION_TRANSPORT_LABEL,
  DIRECT_TRANSPORT_LABEL,
  DISPLAY_TRANSPORT_LABEL,
  NATIVE_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
  renderTransportLabel,
} from "../packages/shared-ui/src/labels.ts";

test("transport labels match the canonical values", () => {
  assert.equal(DIRECT_TRANSPORT_LABEL, "Direct from your browser");
  assert.equal(PROXY_TRANSPORT_LABEL, "Metadata proxy");
  assert.equal(DISPLAY_TRANSPORT_LABEL, "Display only");
  assert.equal(BROWSER_SESSION_TRANSPORT_LABEL, "Browser session");
  assert.equal(NATIVE_TRANSPORT_LABEL, "Native");
  assert.equal(renderTransportLabel("direct"), "Direct from your browser");
  assert.equal(renderTransportLabel("metadata-proxy"), "Metadata proxy");
  assert.equal(renderTransportLabel("display-only"), "Display only");
  assert.equal(renderTransportLabel("browser-session"), "Browser session");
  assert.equal(renderTransportLabel("native"), "Native");
  assert.equal(renderTransportLabel("mystery"), "mystery");
});
