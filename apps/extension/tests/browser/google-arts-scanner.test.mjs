import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";
import { mergeSourceInputs } from "../../src/job/source-snapshot.ts";

const scanner = (
  await build({
    entryPoints: [
      fileURLToPath(
        new URL("../../../../packages/page-agent/src/viewer-scanner.ts", import.meta.url),
      ),
    ],
    bundle: true,
    write: false,
    format: "iife",
    globalName: "Scanner",
    define: { "import.meta.url": JSON.stringify(import.meta.url) },
  })
).outputFiles[0].text;

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

async function scan(page) {
  const result = await page.evaluate(async () => {
    const observed = await Scanner.scanViewers();
    return {
      observed: observed.inputs,
      url: location.href,
      html: document.documentElement.outerHTML,
    };
  });
  const inputs = mergeSourceInputs(
    {
      ok: true,
      documentUrl: result.url,
      inputs: [{ kind: "source", url: result.url, contents: result.html }],
    },
    result.observed,
  );
  return inputs;
}

for (const [name, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  test(`${name}: Google Arts discovery follows the current artwork without HTML or network metadata`, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) => {
        assert.equal(route.request().isNavigationRequest(), true, "no metadata requests");
        return route.fulfill({
          contentType: "text/html",
          body: '<div id="viewer"></div><script type="application/json">[],"//lh3.googleusercontent.com/ci/previous","previous-token"</script>',
        });
      });
      await page.goto("https://artsandculture.google.com/asset/painting/previous");
      await page.addScriptTag({ content: scanner });
      for (const id of ["first", "second"]) {
        await page.evaluate(showArtwork, { id });
        const inputs = await scan(page);
        const metadata = JSON.parse(inputs.find((input) => input.kind === "source").contents);
        assert.equal(metadata.asset_id, id);
        assert.equal(metadata.title, `Painting ${id}`);
        assert.equal(metadata.base_url, `https://lh3.googleusercontent.com/ci/${id}`);
        assert.equal(metadata.token, `token-${id}`);
        assert.match(metadata.tile_info, /<TileInfo/);
      }
      for (const mode of ["stale", "mismatched-pyramid", "unowned"]) {
        await page.evaluate(showArtwork, { id: "third", mode });
        const inputs = await scan(page);
        assert.match(
          inputs.find((input) => input.kind === "source").contents,
          /previous-token/,
          mode,
        );
      }
    } finally {
      await browser.close();
    }
  });
}
