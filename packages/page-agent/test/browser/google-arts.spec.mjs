import assert from "node:assert/strict";
import { test } from "../../../../test/browser/fixtures.mjs";

// Synthetic Google controller/protobuf and native XML shapes, based on the live
// viewer in issue #1361. Internal property names deliberately change per view.
function showArtwork({ id, mode = "loaded" }) {
  history.pushState({}, "", `/asset/painting/${id}`);
  const element = document.querySelector("#viewer");
  const record = [
    "stella.av",
    id,
    `Painting ${id}`,
    null,
    null,
    null,
    null,
    null,
    `//lh3.googleusercontent.com/ci/${id}`,
    `token-${id}`,
  ];
  const xml = new DOMParser().parseFromString(
    '<TileInfo tile_width="256" tile_height="256"><pyramid_level num_tiles_x="2" num_tiles_y="1" empty_pels_x="12" empty_pels_y="6"/></TileInfo>',
    "text/xml",
  );
  const asset = {
    [`record_${id}`]: { [`data_${id}`]: record },
    getId: () => id,
  };
  const microscope = {
    [`source_${id}`]: { [`loaded_${id}`]: { [`xml_${id}`]: xml } },
    GetImageMetadata() {
      return { size: { width: 500, height: 250 } };
    },
    GetState() {
      throw new Error("must not change or inspect viewport state");
    },
  };
  const controller = { asset, [`viewer_${id}`]: microscope, [`element_${id}`]: element };
  element.__jscontroller = { pending: { value: controller } };
  if (mode === "stale") record[1] = "previous";
  if (mode === "mismatched-pyramid")
    xml.documentElement.firstElementChild.setAttribute("empty_pels_x", "13");
  if (mode === "unowned") delete controller[`element_${id}`];
}

test.beforeEach(async ({ page, loadModule }) => {
  await page.route("https://artsandculture.google.com/**", (route) => {
    assert.equal(
      route.request().isNavigationRequest(),
      true,
      "loaded metadata needs no further requests",
    );
    return route.fulfill({ contentType: "text/html", body: '<div id="viewer"></div>' });
  });
  await page.goto("https://artsandculture.google.com/asset/painting/previous");
  await loadModule(page);
});

test("navigation discovers the current Google artwork", async ({ page }) => {
  for (const id of ["first", "second"]) {
    await page.evaluate(showArtwork, { id });
    const inputs = await page.evaluate(async () => (await ViewerScanner.scanViewers()).inputs);
    const metadata = JSON.parse(inputs[0].contents);
    assert.equal(metadata.asset_id, id);
    assert.equal(metadata.title, `Painting ${id}`);
    assert.equal(metadata.base_url, `https://lh3.googleusercontent.com/ci/${id}`);
    assert.equal(metadata.token, `token-${id}`);
    assert.match(metadata.tile_info, /<TileInfo/);
  }
});

for (const mode of ["stale", "mismatched-pyramid", "unowned"]) {
  test(`ignores ${mode} Google artwork data`, async ({ page }) => {
    await page.evaluate(showArtwork, { id: "current", mode });
    const inputs = await page.evaluate(async () => (await ViewerScanner.scanViewers()).inputs);
    assert.deepEqual(inputs, []);
  });
}
