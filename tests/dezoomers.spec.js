const { expect, test } = require("@playwright/test");

async function openApp(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => {
    return (
      window.ZoomManager &&
      window.ZoomManager.dezoomersList &&
      window.ZoomManager.dezoomersList.pnav
    );
  });
}

async function runDezoomer(page, dezoomerName, url) {
  if (url.startsWith("/")) url = `${new URL(page.url()).origin}${url}`;
  return page.evaluate(
    ({ dezoomerName, proxyUrl, url }) => {
      const ZoomManager = window.ZoomManager;
      const dezoomer = ZoomManager.dezoomersList[dezoomerName];
      if (!dezoomer) throw new Error(`Unknown dezoomer: ${dezoomerName}`);

      return new Promise((resolve, reject) => {
        const tiles = [];
        const timeout = setTimeout(
          () => reject(new Error(
            `Timed out while running ${dezoomerName}: ` +
            JSON.stringify({
              data: ZoomManager.data,
              dezoomerName: ZoomManager.dezoomer && ZoomManager.dezoomer.name,
              status: ZoomManager.status,
              tiles,
            })
          )),
          7000
        );

        function finish(result) {
          clearTimeout(timeout);
          resolve(result);
        }

        function fail(error) {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        }

        function maybeFinish() {
          if (
            ZoomManager.status &&
            ZoomManager.data &&
            ZoomManager.status.loaded >= ZoomManager.status.totalTiles
          ) {
            finish({
              dezoomerName: ZoomManager.dezoomer.name,
              data: JSON.parse(JSON.stringify(ZoomManager.data)),
              tiles,
            });
          }
        }

        window.onerror = function (message, source, line) {
          fail(new Error(`${message} (${source}:${line})`));
          return true;
        };

        ZoomManager.setDezoomer(dezoomer);
        ZoomManager.data = null;
        ZoomManager.proxy_url = proxyUrl;
        ZoomManager.nextTick = (fn) => setTimeout(fn, 0);
        ZoomManager.addTile = (tileUrl, x, y) => {
          tiles.push({ url: String(tileUrl), x, y });
          ZoomManager.status.loaded++;
          maybeFinish();
        };
        ZoomManager.loadEnd = () => {
          finish({
            dezoomerName: ZoomManager.dezoomer.name,
            data: JSON.parse(JSON.stringify(ZoomManager.data)),
            tiles,
          });
        };
        ZoomManager.error = (message) => fail(new Error(message));

        ZoomManager.open(url);
      });
    },
    {
      dezoomerName,
      proxyUrl: `${new URL(page.url()).origin}/proxy`,
      url,
    }
  );
}

test.describe("dezoomer fixture coverage", () => {
  test.beforeEach(async ({ page }) => {
    await openApp(page);
  });

  test("loads core zoomable formats from deterministic fixtures", async ({ page }) => {
    const cases = [
      {
        dezoomer: "Generic dezoomer",
        url: "/fixtures/generic/tile.jpg?x={{X}}&y={{Y}}",
        expectedTile: "/fixtures/generic/tile.jpg?x=1&y=1",
      },
      {
        dezoomer: "Zoomify",
        url: "https://fixtures.test/zoomify/ImageProperties.xml",
        expectedTile: "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        dezoomer: "Seadragon (Deep Zoom Image)",
        url: "https://fixtures.test/deepzoom/sample.dzi",
        expectedTile: "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg",
      },
      {
        dezoomer: "Seadragon (Deep Zoom Image)",
        url: "https://fixtures.test/deepzoom/legacy-embed.html",
        expectedTile: "https://fixtures.test/deepzoom/legacy_files/9/1_1.jpg",
      },
      {
        dezoomer: "IIIF",
        url: "https://fixtures.test/iiif-v2/info.json",
        expectedTile: "/iiif/v2/256,256,256,256/256,256/0/native.png",
      },
      {
        dezoomer: "IIPImage",
        url: "https://fixtures.test/iip?FIF=/image.tif",
        expectedTile: "https://fixtures.test/iip?FIF=/image.tif&JTL=1,3",
      },
      {
        dezoomer: "krpano",
        url: "https://fixtures.test/krpano/pano.xml",
        expectedTile: "https://fixtures.test/krpano/tiles/l1/2_2.jpg",
      },
      {
        dezoomer: "Zoomify PFF",
        url: "https://fixtures.test/pff?file=/sample.pff&requestType=1",
        expectedTile: "https://fixtures.test/pff?file=/sample.pff&requestType=0&head=0&begin=1400&end=1500",
      },
      {
        dezoomer: "XLimage",
        url: "https://fixtures.test/xl/sample.imgi?cmd=info",
        expectedTile: "https://fixtures.test/xl/sample.imgi?cmd=tile&x=1&y=1&z=1",
      },
      {
        dezoomer: "TopViewer",
        url: "https://fixtures.test/topviewer/data.json",
        expectedTile: "/topviewer/sample-file/13.jpg",
      },
      {
        dezoomer: "TopViewer",
        url: "https://fixtures.test/topviewer/page?FIF=not-iip",
        expectedTile: "/topviewer/sample-file/13.jpg",
      },
      {
        dezoomer: "FSI",
        url: "https://fixtures.test/fsi/server?type=info&source=image&image=image",
        expectedTile: "https://fixtures.test/fsi/server?type=image&source=image",
      },
      {
        dezoomer: "VLS",
        url: "https://fixtures.test/vls/zoom/1",
        expectedTile: "https://fixtures.test/image/tiler/square/fixture/0/0/0",
      },
      {
        dezoomer: "Micrio",
        url: "https://fixtures.test/micrio/api/getTilesInfo?object_id=1",
        expectedTile: "/fixtures/tile.jpg",
      },
      {
        dezoomer: "Hungaricana",
        url: "https://fixtures.test/hungaricana/imagesize/sample.ecw",
        expectedTile: "https://fixtures.test/hungaricana/image/sample.ecw/",
      },
      {
        dezoomer: "Mnesys",
        url: "https://fixtures.test/mnesys/p.xml",
        expectedTile: "https://fixtures.test/mnesys/1_3.jpg",
      },
      {
        dezoomer: "WMTS",
        url: "https://fixtures.test/wmts/WMTSCapabilities.xml",
        expectedTile: "/wmts/EPSG3857/0/10/10.jpg",
      },
      {
        dezoomer: "pnav",
        url: "https://fixtures.test/entity/OBJECT/1",
        expectedTile: "/fixtures/pnav/image.jpg?w=2000&h=2000&cl=0&ct=0&cw=512&ch=512",
      },
    ];

    for (const item of cases) {
      const result = await runDezoomer(page, "Select automatically", item.url);
      expect(result.data.width, item.dezoomer).toBeGreaterThan(0);
      expect(result.data.height, item.dezoomer).toBeGreaterThan(0);
      expect(result.tiles.length, item.dezoomer).toBeGreaterThan(0);
      expect(result.tiles.at(-1).url, item.dezoomer).toContain(item.expectedTile);
      expect(result.dezoomerName, item.dezoomer).toBe(item.dezoomer);
    }
  });

  test("supports IIIF Image API 3 info.json responses", async ({ page }) => {
    const result = await runDezoomer(page, "Select automatically", "https://fixtures.test/iiif-v3/info.json");

    expect(result.dezoomerName).toBe("IIIF");
    expect(result.data.origin).toBe("http://127.0.0.1:9877/iiif/v3");
    expect(result.data.quality).toBe("default");
    expect(result.data.format).toBe("jpg");
    expect(result.tiles.at(-1).url).toContain("/iiif/v3/256,256,256,256/256,256/0/default.jpg");
  });

  test("generates IIIF tile URLs with explicit returned dimensions", async ({ page }) => {
    const urls = await page.evaluate(() => {
      const iiif = window.ZoomManager.dezoomersList.IIIF;
      const data = {
        origin: "https://iiif.example/image",
        width: 600,
        height: 384,
        tileSize: 256,
        quality: "default",
        format: "jpg",
      };

      return [
        iiif.getTileURL(0, 0, 1, data),
        iiif.getTileURL(1, 1, 1, data),
      ];
    });

    expect(urls).toEqual([
      "https://iiif.example/image/0,0,256,256/256,256/0/default.jpg",
      "https://iiif.example/image/256,256,256,128/256,128/0/default.jpg",
    ]);
  });

  test("keeps Zoomify full-resolution-only NUMTILES in TileGroup0", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "Select automatically",
      "https://fixtures.test/zoomify-full-numtiles/ImageProperties.xml"
    );

    expect(result.dezoomerName).toBe("Zoomify");
    expect(result.data.numTiles).toBe(280);
    expect(result.data.numTilesIsFullResolutionOnly).toBe(true);
    expect(result.tiles).toHaveLength(280);
    expect(result.tiles.every((tile) => tile.url.includes("/TileGroup0/"))).toBe(true);
    expect(result.tiles.map((tile) => tile.url)).toContain(
      "https://fixtures.test/zoomify-full-numtiles/TileGroup0/6-16-6.jpg"
    );
  });

  test("extracts current National Gallery IIIF URLs from pages", async ({ page }) => {
    const result = await runDezoomer(page, "Select automatically", "https://fixtures.test/national-gallery");

    expect(result.dezoomerName).toBe("IIIF");
    expect(result.data.origin).toBe(
      "http://127.0.0.1:9877/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif"
    );
    expect(result.tiles.at(-1).url).toContain(
      "/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif/256,256,256,256/256,256/0/default.jpg"
    );
  });

});
