import assert from "node:assert/strict";
import test from "node:test";
import { defaultSaveExtension, outputCodecs } from "@dezoomify/wasm-bindings/codecs";
import {
  extensionForSaveFormat,
  safeTitleStem,
  suggestedNameFor,
} from "../../shared-ui/src/labels.ts";

test("suggestedNameFor builds dezoomify-WxH names with format extensions", () => {
  assert.equal(suggestedNameFor(800, 600, "png"), "dezoomify-800x600.png");
  assert.equal(suggestedNameFor(800, 600, "jpeg"), "dezoomify-800x600.jpg");
  assert.equal(suggestedNameFor(0, 600, "png"), "dezoomify.png");
  assert.equal(suggestedNameFor(undefined, undefined, "tiff"), "dezoomify.tif");
  for (const codec of outputCodecs) {
    for (const name of [codec.format, ...codec.extensions.filter(Boolean)]) {
      assert.equal(extensionForSaveFormat(name), codec.extensions[0]);
      assert.equal(extensionForSaveFormat(name.toUpperCase()), codec.extensions[0]);
    }
  }
  for (const unknown of [undefined, null, "", "unknown-format"]) {
    assert.equal(extensionForSaveFormat(unknown), defaultSaveExtension);
  }
  assert.equal(suggestedNameFor(800, 600, "avif"), "dezoomify-800x600.avif");
  assert.equal(suggestedNameFor(800, 600, "zif"), "dezoomify-800x600.zif");
  assert.equal(suggestedNameFor(800, 600, "webp"), "dezoomify-800x600.webp");
  assert.equal(suggestedNameFor(800, 600, "iiif-dir"), "dezoomify-800x600.iiif");
});

test("suggestedNameFor prefers safe core titles and rejects unsafe stems", () => {
  assert.equal(suggestedNameFor(800, 600, "png", "Portrait: Étude"), "Portrait_ Étude.png");
  assert.equal(suggestedNameFor(800, 600, "jpeg", "  A / B.  "), "A _ B.jpg");
  assert.equal(suggestedNameFor(800, 600, "png", "CON"), "dezoomify-800x600.png");
  assert.equal(suggestedNameFor(800, 600, "png", "..."), "dezoomify-800x600.png");
  assert.equal(safeTitleStem("A\u0000B"), "A_B");
});
