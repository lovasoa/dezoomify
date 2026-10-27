import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { chromium, firefox } from "playwright";

const bundle = await build({
  entryPoints: [fileURLToPath(new URL("../../src/job/viewer-scanner.ts", import.meta.url))],
  bundle: true,
  write: false,
  format: "iife",
  globalName: "ViewerScanner",
  target: "es2022",
});
const scannerScript = bundle.outputFiles[0].text;

const tile = readFileSync(new URL("../../../../fixtures/tiles/0-0.png", import.meta.url));

function prepareViewer(mode) {
  const OpenSeadragon = window.OpenSeadragon;
  const element = document.getElementById("v");
  window.getterCalls = 0;
  Object.defineProperty(window, "dangerousGetter", {
    configurable: true,
    get() {
      window.getterCalls++;
      throw new Error("do not read");
    },
  });
  window.cycle = {};
  window.cycle.self = window.cycle;
  if (mode === "seadragon") {
    const canvas = element.appendChild(document.createElement("div"));
    const base = "https://fixture.invalid/imageproxy.aspx?&filename=objectimages/image_files/";
    window.referenceFlood = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [i, i]));
    window.viewer = {
      container: element,
      drawer: { elmt: canvas },
      tracker: { target: canvas },
      viewport: {},
      openDzi() {},
      source: {
        width: 1024,
        height: 768,
        tileSize: 256,
        tileOverlap: 1,
        minLevel: 0,
        maxLevel: 10,
        fileFormat: "png",
        displayRects: [],
        getTileUrl: (level, x, y) => `${base}${level}/${x}_${y}.png`,
      },
    };
    window.fixtureReady = true;
    return;
  }
  if (mode === "negative") {
    window.fixtureReady = true;
    return;
  }
  function fixtureSource() {
    if (mode.startsWith("iiif"))
      return {
        "@context": "http://iiif.io/api/image/3/context.json",
        id: "https://fixture.invalid/iiif",
        type: "ImageService3",
        protocol: "http://iiif.io/api/image",
        profile: "level2",
        width: 1024,
        height: 768,
        tiles: [{ width: 256, height: 128, scaleFactors: [1, 2, 4] }],
      };
    if (mode === "zoomify")
      return {
        type: "zoomifytileservice",
        width: 1024,
        height: 768,
        tilesUrl: "https://fixture.invalid/zoomify/",
        fileFormat: "jpg",
        tileSize: 256,
      };
    if (mode === "iip")
      return {
        iipsrv: "https://fixture.invalid/iip",
        image: "image.tif",
        format: "jpg",
        transform: { contrast: 1.5, twist: "[0,0,1;0,1,0;0.9,0,0.1]" },
      };
    return {
      Image: {
        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
        Url: "https://fixture.invalid/image_files/",
        Format: "png",
        Overlap: 1,
        TileSize: 256,
        Size: { Width: 1024, Height: 768 },
      },
    };
  }
  const viewer = OpenSeadragon({
    element,
    prefixUrl: "",
    tileSources: fixtureSource(),
    showNavigationControl: false,
  });
  function opened() {
    window.fixtureReady = true;
    if (mode === "frozen-apply")
      Object.defineProperty(Function.prototype, "apply", { writable: false });
    window.beforeApply = Object.getOwnPropertyDescriptor(Function.prototype, "apply");
    window.timerTicks = 0;
    window.hookDuringTask = false;
    setInterval(() => {
      window.timerTicks++;
      if (
        Object.getOwnPropertyDescriptor(Function.prototype, "apply").value !==
        window.beforeApply.value
      )
        window.hookDuringTask = true;
    }, 0);
    window.beforeViewport = JSON.stringify({
      zoom: viewer.viewport.getZoom(),
      center: viewer.viewport.getCenter(),
    });
    window.checkViewport = () =>
      JSON.stringify({
        zoom: viewer.viewport.getZoom(),
        center: viewer.viewport.getCenter(),
      }) === window.beforeViewport;
    configureFixtureMode();
  }
  function configureFixtureMode() {
    // A function closure does not expose the viewer to graph traversal.
    if (mode === "expando") {
      element.viewer = viewer;
      viewer.setMouseNavEnabled(false);
    }
    if (["closure", "throwing-listener", "frozen-apply", "private-disabled"].includes(mode))
      delete window.OpenSeadragon;
    if (mode === "private-disabled") viewer.setMouseNavEnabled(false);
    if (mode === "sparse-dzi")
      viewer.source.displayRects = [new OpenSeadragon.DisplayRect(0, 0, 256, 256, 0, 10)];
    if (mode === "throwing-proxy")
      window.trapped = new Proxy(
        {},
        {
          ownKeys() {
            throw new Error("proxy trap");
          },
          getOwnPropertyDescriptor() {
            throw new Error("proxy trap");
          },
        },
      );
    if (mode === "throwing-listener")
      viewer.canvas.addEventListener("keydown", () => {
        throw new Error("fixture listener");
      });
    if (mode === "large-dom") {
      appendLargeDom();
    }
    configureReferenceLimit();
  }
  function configureReferenceLimit() {
    if (mode === "global") {
      delete window.OpenSeadragon;
      viewer.setMouseNavEnabled(false);
      window.referenceFlood = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [i, i]));
      window.loadedViewer = viewer;
    }
    if (mode === "large-properties") {
      delete window.OpenSeadragon;
      viewer.setMouseNavEnabled(false);
      window.referenceFlood = Object.fromEntries(Array.from({ length: 20000 }, (_, i) => [i, i]));
      window.referenceFlood.viewer = viewer;
    }
    if (mode === "large-registry") {
      OpenSeadragon._viewers = new Map(Array.from({ length: 20000 }, (_, i) => [i, i]));
      OpenSeadragon._viewers.set("late", viewer);
    }
  }
  function appendLargeDom() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 6000; i++) fragment.append(document.createElement("i"));
    document.body.append(fragment);
  }
  viewer.addHandler("open", opened);
  if (viewer.isOpen()) opened();
}

async function prepareFrameScope(page, mode, library) {
  let scope = page;
  if (["frame", "blob-frame", "http-frame"].includes(mode)) {
    await page.evaluate((mode) => {
      const frame = document.createElement("iframe");
      const html =
        '<base href="https://fixture.invalid/"><div id="v" style="width:800px;height:600px"></div>';
      if (mode === "frame") frame.srcdoc = html;
      else if (mode === "blob-frame")
        frame.src = URL.createObjectURL(new Blob([html], { type: "text/html" }));
      else frame.src = "https://fixture.invalid/frame";
      document.body.append(frame);
    }, mode);
    await page.waitForFunction(() =>
      document.querySelector("iframe").contentDocument?.getElementById("v"),
    );
    scope = page.frames()[1];
    await scope.addScriptTag({ content: library });
  }
  return scope;
}

for (const [name, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  test(`${name}: memory-only OpenSeadragon observations and probe restoration`, {
    timeout: 120000,
  }, async () => {
    const browser = await engine.launch({ headless: true });
    try {
      const version = "6.1.1";
      for (const mode of [
        "registry",
        "closure",
        "expando",
        "iiif",
        "zoomify",
        "iip",
        "frame",
        "blob-frame",
        "http-frame",
        "large-dom",
        "large-properties",
        "global",
        "seadragon",
        "large-registry",
        "negative",
        "throwing-listener",
        "frozen-apply",
        "private-disabled",
        "throwing-proxy",
        "sparse-dzi",
      ]) {
        const page = await browser.newPage();
        const pageErrors = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        try {
          await page.route("https://fixture.invalid/**", async (route) => {
            if (route.request().isNavigationRequest())
              return route.fulfill({
                contentType: "text/html",
                body: '<div id="v" style="width:800px;height:600px"></div>',
              });
            if (route.request().url().includes("obj="))
              return route.fulfill({
                contentType: "text/plain",
                body: "IIP:1.0\nMax-size:1024 768\nTile-size:256 128\nResolution-number:3\nResolutions:256 192,512 384,1024 768\n",
              });
            return route.fulfill({ contentType: "image/png", body: tile });
          });
          await page.goto("https://fixture.invalid/parent");
          const library = readFileSync(
            new URL(import.meta.resolve("openseadragon/build/openseadragon/openseadragon.min.js")),
            "utf8",
          );
          await page.addScriptTag({
            content: `(()=>{${library}\nwindow.OpenSeadragon=OpenSeadragon;})()`,
          });
          const scope = await prepareFrameScope(page, mode, library);
          await scope.evaluate(prepareViewer, mode);
          await scope
            .waitForFunction(() => window.fixtureReady, null, { timeout: 5000 })
            .catch((cause) => {
              throw new Error(`${version}/${mode} did not open`, { cause });
            });
          await scope.evaluate(() => {
            window.networkCalls = 0;
            window.fetch = () => {
              window.networkCalls++;
              throw new Error("memory only");
            };
            XMLHttpRequest.prototype.open = () => {
              window.networkCalls++;
              throw new Error("memory only");
            };
          });
          const measured = await page.evaluate(`(async () => {
              let taskRan = false;
              if (${mode === "large-dom"}) {
                const channel = new MessageChannel();
                channel.port1.onmessage = () => {
                  taskRan = true;
                  channel.port1.close();
                  channel.port2.close();
                };
                channel.port2.postMessage(null);
              }
              ${scannerScript}
              const result = await ViewerScanner.scanViewers();
              return { result, taskRan };
            })()`);
          const result = measured.result;
          if (mode === "http-frame") {
            assert.equal(result.diagnostics.documents, 1, "the parent scans only its document");
            const child = await scope.evaluate(`(async () => {
              ${scannerScript}
              return ViewerScanner.scanViewers();
            })()`);
            assert.equal(child.inputs.length, 1, "the inventory can scan the HTTP child directly");
            assert.equal(child.diagnostics.documents, 1);
          }
          assert.equal(
            result.inputs.length,
            [
              "http-frame",
              "negative",
              "frozen-apply",
              "private-disabled",
              "sparse-dzi",
              "large-properties",
              "large-registry",
            ].includes(mode)
              ? 0
              : 1,
            `${version}/${mode}: ${JSON.stringify(result.diagnostics)}`,
          );
          for (const input of result.inputs) {
            assertMemoryInput(input, mode);
          }
          const checked = await scope.evaluate(() => ({
            getters: window.getterCalls,
            network: window.networkCalls,
            restored:
              !window.beforeApply ||
              Reflect.ownKeys(window.beforeApply).every(
                (key) =>
                  Object.getOwnPropertyDescriptor(Function.prototype, "apply")[key] ===
                  window.beforeApply[key],
              ),
            viewport: !window.checkViewport || window.checkViewport(),
          }));
          assert.deepEqual(
            checked,
            { getters: 0, network: 0, restored: true, viewport: true },
            `${version}/${mode}`,
          );
          const tasks = await scope.evaluate(() => ({
            ticks: window.timerTicks ?? 0,
            hooked: window.hookDuringTask ?? false,
          }));
          assert.equal(tasks.hooked, false, "the prototype hook never survives into another task");
          if (["large-properties", "large-registry"].includes(mode)) {
            assert.equal(result.diagnostics.truncated, true);
            assert.ok(result.diagnostics.stopped.includes("reference-limit"));
          }
          if (mode === "large-dom") {
            assert.ok(measured.taskRan, "large DOM scanning yields to page tasks");
            assert.equal(result.diagnostics.truncated, true);
            assert.ok(result.diagnostics.stopped.includes("node-limit"));
          }
          assert.deepEqual(
            pageErrors,
            mode === "throwing-listener" ? ["fixture listener"] : [],
            `${version}/${mode}`,
          );
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  });
}

function assertMemoryInput(input, mode) {
  assert.equal(input.kind, "observed-metadata");
  if (mode === "zoomify") {
    assert.match(input.contents, /WIDTH="1024" HEIGHT="768"/);
    assert.match(input.url, /ImageProperties.xml$/);
  } else if (mode === "iip") {
    assert.match(input.contents, /Max-size:1024 768/);
    assert.ok(input.url.includes("&CNT=1.5&CTW=[0,0,1;0,1,0;0.9,0,0.1]"));
  } else if (mode === "iiif") {
    const metadata = JSON.parse(input.contents);
    assert.equal(metadata.width, 1024);
    assert.equal(metadata.height, 768);
  } else {
    const metadata = JSON.parse(input.contents).Image;
    assert.deepEqual(metadata.Size, { Width: 1024, Height: 768 });
    assert.equal(metadata.TileSize, 256);
    if (mode === "seadragon")
      assert.equal(
        metadata.Url,
        "https://fixture.invalid/imageproxy.aspx?&filename=objectimages/image_files/",
      );
  }
}
