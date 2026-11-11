import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "../../../../test/browser/fixtures.mjs";

const fixtures = new URL("../../../../test/browser/pages/", import.meta.url);
const origin = "https://viewer.fixture.test";

function prepare(mode) {
  const viewer = document.getElementById("viewer");
  const runtime = viewer.get("global");
  window.unsafeCalls = 0;
  const unsafe = () => {
    window.unsafeCalls++;
    throw new Error("unexpected page call");
  };
  window.genericAPI = { get: unsafe };
  document.body.appendChild(Object.assign(document.createElement("div"), { get: unsafe }));
  Object.defineProperty(window, "unsafeGetter", { get: unsafe });
  if (mode === "malformed") runtime.image.level.getArray()[0].tiledimagewidth = 0;
  else if (mode === "custom-path") runtime.customParseTilePath = unsafe;
  else if (mode === "getter") Object.defineProperty(runtime, "image", { get: unsafe });
  else {
    window.referenceFlood = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [i, i]));
    runtime.image.baseindex = 0;
    runtime.image.level = {
      getArray: () => [
        {
          tiledimagewidth: "256",
          tiledimageheight: "256",
          flat: { url: "%BASEDIR%small/%h-%v.png" },
        },
        {
          tiledimagewidth: "512",
          tiledimageheight: "512",
          flat: { url: "%BASEDIR%large/%00h-%v.png?sig=exact+value&v=two" },
        },
      ],
    };
    runtime.parsepath = (path) => path.replace("%BASEDIR%", "/images/");
  }
}

for (const mode of ["normalized", "malformed", "custom-path", "getter"]) {
  test(`krpano: ${mode}`, async ({ page, loadModule }) => {
    await page.route(`${origin}/**`, (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (route.request().isNavigationRequest())
        return route.fulfill({
          contentType: "text/html",
          body: readFileSync(new URL("memory-krpano.html", fixtures)),
        });
      assert.equal(pathname, "/private-runtime.js");
      return route.fulfill({
        contentType: "text/javascript",
        body: readFileSync(new URL("private-runtime.js", fixtures)),
      });
    });
    await page.goto(`${origin}/viewer.html`);
    await page.evaluate(prepare, mode);
    await loadModule(page);
    const result = await page.evaluate(async () => {
      let networkCalls = 0;
      window.fetch = () => {
        networkCalls++;
        throw new Error("scan must not fetch");
      };
      XMLHttpRequest.prototype.open = () => {
        networkCalls++;
        throw new Error("scan must not request resources");
      };
      const scan = await ViewerScanner.scanViewers();
      const xml =
        scan.inputs[0] && new DOMParser().parseFromString(scan.inputs[0].contents, "text/xml");
      return {
        inputs: scan.inputs,
        handles: scan.handles,
        unsafeCalls: window.unsafeCalls,
        networkCalls,
        malformedXml: !!xml?.querySelector("parsererror"),
        baseindex: xml?.querySelector("image")?.getAttribute("baseindex"),
        levels:
          xml &&
          [...xml.querySelectorAll("level")].map((level) => ({
            width: level.getAttribute("tiledimagewidth"),
            url: level.querySelector("flat")?.getAttribute("url"),
          })),
      };
    });
    assert.equal(result.unsafeCalls, 0, mode);
    assert.equal(result.networkCalls, 0, mode);
    if (mode !== "normalized") {
      assert.deepEqual(result.inputs, [], mode);
      return;
    }
    assert.equal(result.inputs.length, 1);
    assert.equal(result.malformedXml, false);
    assert.equal(result.baseindex, "0");
    assert.deepEqual(result.levels, [
      { width: "256", url: `${origin}/images/small/%h-%v.png` },
      { width: "512", url: `${origin}/images/large/%00h-%v.png?sig=exact+value&v=two` },
    ]);
  });
}
