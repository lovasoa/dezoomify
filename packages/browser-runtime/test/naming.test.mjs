import test from "node:test";
import assert from "node:assert/strict";
import { extensionForSaveFormat, suggestedNameFor } from "../src/save-name.ts";
import { suggestedNameFor as sharedSuggestedNameFor } from "../../shared-ui/src/saveName.ts";
import {
  BROWSER_SESSION_TRANSPORT_LABEL,
  DIRECT_TRANSPORT_LABEL,
  DISPLAY_TRANSPORT_LABEL,
  NATIVE_TRANSPORT_LABEL,
  PROXY_TRANSPORT_LABEL,
} from "../src/transport-labels.ts";
import {
  DIRECT_TRANSPORT_LABEL as typesDirect,
  PROXY_TRANSPORT_LABEL as typesProxy,
} from "../src/types.ts";
import {
  DIRECT_TRANSPORT_LABEL as componentsDirect,
} from "../../shared-ui/src/components.ts";

test("suggestedNameFor builds dezoomify-WxH names with format extensions", () => {
  assert.equal(suggestedNameFor(800, 600, "png"), "dezoomify-800x600.png");
  assert.equal(suggestedNameFor(800, 600, "jpeg"), "dezoomify-800x600.jpg");
  assert.equal(suggestedNameFor(0, 600, "png"), "dezoomify.png");
  assert.equal(suggestedNameFor(undefined, undefined, "tiff"), "dezoomify.tif");
  assert.equal(extensionForSaveFormat("jpg"), "jpg");
  assert.equal(extensionForSaveFormat("tif"), "tif");
  assert.equal(extensionForSaveFormat("zif"), "zif");
  assert.equal(extensionForSaveFormat("webp"), "webp");
  assert.equal(extensionForSaveFormat("iiif"), "iiif");
  assert.equal(extensionForSaveFormat("iiif-dir"), "iiif");
  assert.equal(suggestedNameFor(800, 600, "zif"), "dezoomify-800x600.zif");
  assert.equal(suggestedNameFor(800, 600, "webp"), "dezoomify-800x600.webp");
  assert.equal(suggestedNameFor(800, 600, "iiif-dir"), "dezoomify-800x600.iiif");
});

test("shared-ui re-exports the canonical save-name helper (no fork)", () => {
  assert.equal(sharedSuggestedNameFor(4, 4, "png"), suggestedNameFor(4, 4, "png"));
});

test("transport labels are canonical and distinct", () => {
  assert.equal(DIRECT_TRANSPORT_LABEL, "Direct from your browser");
  assert.equal(PROXY_TRANSPORT_LABEL, "Metadata proxy");
  assert.equal(DISPLAY_TRANSPORT_LABEL, "Display only");
  assert.equal(BROWSER_SESSION_TRANSPORT_LABEL, "Browser session");
  assert.equal(NATIVE_TRANSPORT_LABEL, "Native");
  assert.equal(typesDirect, DIRECT_TRANSPORT_LABEL);
  assert.equal(typesProxy, PROXY_TRANSPORT_LABEL);
  assert.equal(componentsDirect, DIRECT_TRANSPORT_LABEL);
});
