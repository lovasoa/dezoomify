import assert from "node:assert/strict";
import test from "node:test";
import { readTileSource } from "../src/krpano/metadata.ts";
import { projectMetadata } from "../src/viewers/metadata.ts";
import { PageObject } from "../src/viewers/page-object.ts";

test("krpano metadata encoding uses a detached snapshot without page API calls", () => {
  const level = {
    tiledimagewidth: "512",
    tiledimageheight: "256",
    flat: { url: "tiles/%00h-%v.png?token=one&v=two" },
  };
  const image = { tilesize: 256, baseindex: 0, level: { getArray: () => [level] } };
  const runtime = { parsepath: (url) => url };
  const source = readTileSource(
    PageObject.from(runtime),
    PageObject.from(image),
    "https://viewer.example/page",
  );
  level.tiledimagewidth = "1";
  level.flat.url = "https://changed.example/";
  const unexpected = () => {
    throw new Error("metadata encoding must not invoke page code");
  };
  runtime.parsepath = unexpected;
  image.level.getArray = unexpected;
  const context = { documentUrl: "https://viewer.example/page?image=1", imageIndex: 2 };
  const input = projectMetadata(source, context);
  assert.equal(input.kind, "observed-metadata");
  assert.equal(input.url, "https://viewer.example/page?image=1#dezoomify-krpano-2");
  assert.equal(
    input.contents,
    '<krpano><image tilesize="256" baseindex="0"><level tiledimagewidth="512" tiledimageheight="256"><flat url="https://viewer.example/tiles/%00h-%v.png?token=one&amp;v=two"/></level></image></krpano>',
  );
  assert.deepEqual(projectMetadata(source, context), input);
});
