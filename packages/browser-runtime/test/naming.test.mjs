import test from "node:test";
import assert from "node:assert/strict";
import {
  extensionForSaveFormat,
  safeTitleStem,
  suggestedNameFor,
} from "../../app-model/src/index.ts";

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

test("suggestedNameFor prefers safe core titles and rejects unsafe stems", () => {
  assert.equal(suggestedNameFor(800, 600, "png", "Portrait: Étude"), "Portrait_ Étude.png");
  assert.equal(suggestedNameFor(800, 600, "jpeg", "  A / B.  "), "A _ B.jpg");
  assert.equal(suggestedNameFor(800, 600, "png", "CON"), "dezoomify-800x600.png");
  assert.equal(suggestedNameFor(800, 600, "png", "..."), "dezoomify-800x600.png");
  assert.equal(safeTitleStem("A\u0000B"), "A_B");
});
