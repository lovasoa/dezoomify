import assert from "node:assert/strict";
import test from "node:test";
import { projectMetadata, readTileSource } from "../../src/job/openseadragon/metadata.ts";
import { PageObject } from "../../src/job/openseadragon/page-object.ts";

const context = { documentUrl: "https://viewer.example/page?image=1", imageIndex: 2 };
const dzi = () => ({
  width: 1024,
  height: 768,
  tileSize: 256,
  fileFormat: "png",
  tilesUrl: "./tiles/",
  tileOverlap: 1,
  minLevel: 0,
  maxLevel: 10,
});

test("metadata projection uses a detached snapshot and preserves the source document's URL", () => {
  const pageSource = dzi();
  const source = readTileSource(PageObject.from(pageSource), context.documentUrl);
  pageSource.width = 1;
  pageSource.tilesUrl = "https://changed.example/";
  const input = projectMetadata(source, context);
  assert.equal(input.url, "https://viewer.example/page?image=1#dezoomify-openseadragon-2");
  assert.equal(input.kind, "observed-metadata");
  assert.deepEqual(JSON.parse(input.contents).Image, {
    xmlns: "http://schemas.microsoft.com/deepzoom/2008",
    Url: "https://viewer.example/tiles/",
    Format: "png",
    Overlap: 1,
    TileSize: 256,
    Size: { Width: 1024, Height: 768 },
  });
  assert.deepEqual(projectMetadata(source, context), input);
});

test("snapshotting ignores getters and rejects an executable tile URL override", () => {
  const source = dzi();
  let calls = 0;
  Object.defineProperty(source, "getTileUrl", {
    configurable: true,
    get() {
      calls++;
      throw new Error("page getter must not run");
    },
  });
  assert.equal(readTileSource(PageObject.from(source), context.documentUrl).protocol, "dzi");
  assert.equal(calls, 0);
  Object.defineProperty(source, "getTileUrl", {
    value() {
      throw new Error("custom URL must not run");
    },
  });
  assert.throws(
    () => readTileSource(PageObject.from(source), context.documentUrl),
    /unsupported source/,
  );
});

test("malformed IIIF arrays cannot become partially valid snapshots", () => {
  const tile = { width: 256, scaleFactors: [1, 2, 4] };
  const source = { width: 1024, height: 768, tileFormat: "png", _id: "/iiif", version: 3 };
  for (const tiles of [[tile, null], [tile, 7], [{ ...tile, scaleFactors: [1, "2"] }]]) {
    assert.throws(() => readTileSource(PageObject.from({ ...source, tiles }), context.documentUrl));
  }
});
