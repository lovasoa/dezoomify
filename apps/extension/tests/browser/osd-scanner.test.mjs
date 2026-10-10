import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { chromium, firefox } from "playwright";
import { scanOpenSeadragon } from "../../src/job/osd-scanner.ts";

const tile = readFileSync(new URL("../../../../fixtures/tiles/0-0.png", import.meta.url));

for (const [name, engine] of [
  ["Chromium", chromium],
  ["Firefox", firefox],
]) {
  test(`${name}: memory-only OSD observations and probe restoration`, async () => {
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
        "large-dom",
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
            if (route.request().url().includes("obj="))
              return route.fulfill({
                contentType: "text/plain",
                body: "IIP:1.0\nMax-size:1024 768\nTile-size:256 128\nResolution-number:3\nResolutions:256 192,512 384,1024 768\n",
              });
            return route.fulfill({ contentType: "image/png", body: tile });
          });
          await page.setContent(
            '<base href="https://fixture.invalid/"><div id="v" style="width:800px;height:600px"></div>',
          );
          const library = readFileSync(
            new URL(import.meta.resolve("openseadragon/build/openseadragon/openseadragon.min.js")),
            "utf8",
          );
          await page.addScriptTag({
            content: `(()=>{${library}\nwindow.OpenSeadragon=OpenSeadragon;})()`,
          });
          let scope = page;
          if (mode === "frame") {
            await page.evaluate(() => {
              const frame = document.createElement("iframe");
              frame.srcdoc =
                '<base href="https://fixture.invalid/"><div id="v" style="width:800px;height:600px"></div>';
              document.body.append(frame);
            });
            await page.waitForFunction(() =>
              document.querySelector("iframe").contentDocument?.getElementById("v"),
            );
            scope = page.frames()[1];
            await scope.addScriptTag({ content: library });
          }
          await scope.evaluate((mode) => {
            const OSD = window.OpenSeadragon;
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
            if (mode === "negative") {
              window.fixtureReady = true;
              return;
            }
            const source = mode.startsWith("iiif")
              ? {
                  "@context": "http://iiif.io/api/image/3/context.json",
                  id: "https://fixture.invalid/iiif",
                  type: "ImageService3",
                  protocol: "http://iiif.io/api/image",
                  profile: "level2",
                  width: 1024,
                  height: 768,
                  tiles: [{ width: 256, height: 128, scaleFactors: [1, 2, 4] }],
                }
              : mode === "zoomify"
                ? {
                    type: "zoomifytileservice",
                    width: 1024,
                    height: 768,
                    tilesUrl: "https://fixture.invalid/zoomify/",
                    fileFormat: "jpg",
                    tileSize: 256,
                  }
                : mode === "iip"
                  ? {
                      iipsrv: "https://fixture.invalid/iip",
                      image: "image.tif",
                      format: "jpg",
                      transform: { contrast: 1.5, twist: "[0,0,1;0,1,0;0.9,0,0.1]" },
                    }
                  : {
                      Image: {
                        xmlns: "http://schemas.microsoft.com/deepzoom/2008",
                        Url: "https://fixture.invalid/image_files/",
                        Format: "png",
                        Overlap: 1,
                        TileSize: 256,
                        Size: { Width: 1024, Height: 768 },
                      },
                    };
            const viewer = OSD({
              element,
              prefixUrl: "",
              tileSources: source,
              showNavigationControl: false,
            });
            const opened = () => {
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
              // A function closure does not expose the viewer to graph traversal.
              if (mode === "expando") {
                element.viewer = viewer;
                viewer.setMouseNavEnabled(false);
              }
              if (
                ["closure", "throwing-listener", "frozen-apply", "private-disabled"].includes(mode)
              )
                delete window.OpenSeadragon;
              if (mode === "private-disabled") viewer.setMouseNavEnabled(false);
              if (mode === "sparse-dzi")
                viewer.source.displayRects = [new OSD.DisplayRect(0, 0, 256, 256, 0, 10)];
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
                const fragment = document.createDocumentFragment();
                for (let i = 0; i < 6000; i++) fragment.append(document.createElement("i"));
                document.body.append(fragment);
              }
            };
            viewer.addHandler("open", opened);
            if (viewer.isOpen()) opened();
          }, mode);
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
          // Advance the clock during the large traversal so fast machines
          // exercise the slice budget too; verify a queued task can run.
          const measured = await page.evaluate(`(async () => {
              const now = Date.now;
              const timeout = window.setTimeout;
              let elapsed = 0, taskRan = false;
              if (${mode === "large-dom"}) {
                Date.now = () => now() + (elapsed += 0.001);
                window.setTimeout = (callback, delay = 0, ...args) =>
                  timeout.call(window, callback, Math.max(1000, delay), ...args);
                const channel = new MessageChannel();
                channel.port1.onmessage = () => {
                  taskRan = true;
                  channel.port1.close();
                  channel.port2.close();
                };
                channel.port2.postMessage(null);
              }
              try {
                const result = await (${scanOpenSeadragon.toString()})(${Date.now() + 1500});
                return { result, taskRan };
              } finally {
                Date.now = now;
                window.setTimeout = timeout;
              }
            })()`);
          const result = measured.result;
          assert.equal(
            result.inputs.length,
            ["negative", "frozen-apply", "private-disabled", "sparse-dzi"].includes(mode) ? 0 : 1,
            `${version}/${mode}: ${JSON.stringify(result.diagnostics)}`,
          );
          for (const input of result.inputs) {
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
            }
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
          const expired = await page.evaluate(scanOpenSeadragon, Date.now() - 1);
          assert.equal(expired.inputs.length, 0);
          assert.equal(expired.diagnostics.truncated, true);
        } finally {
          await page.close();
        }
      }
    } finally {
      await browser.close();
    }
  });
}
