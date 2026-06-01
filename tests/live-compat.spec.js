const { expect, test } = require("@playwright/test");

const targets = [
  {
    name: "Arts & Culture",
    expectedDezoomer: "Arts & Culture",
    url: "https://artsandculture.google.com/asset/liza-kottou-0113/3gGrYhjfhcwvbA",
  },
  {
    name: "National Gallery",
    expectedDezoomer: "IIIF",
    url: "https://www.nationalgallery.org.uk/paintings/alexandre-calame-at-handeck",
  },
  {
    name: "National Gallery of Victoria",
    expectedDezoomer: "Zoomify",
    url: "https://www.ngv.vic.gov.au/explore/collection/work/3867/",
  },
  {
    name: "Memorix TopViewer",
    expectedDezoomer: "TopViewer",
    url: "https://images.memorix.nl/wba/topviewjson/memorix/6eb5a89b-b76c-5039-3999-aabfd7a0c7c9",
  },
  {
    name: "krpano",
    expectedDezoomer: "krpano",
    url: "https://krpano.com/panos/andreabiffi/galleria_04.xml",
  },
  {
    name: "Bibliotheques specialisees de Paris",
    expectedDezoomer: "Seadragon (Deep Zoom Image)",
    url: "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs",
  },
  {
    name: "National Library of Australia",
    expectedDezoomer: "Seadragon (Deep Zoom Image)",
    url: "https://nla.gov.au/nla.obj-152644715/view",
  },
  {
    name: "Academia Sinica Bronze Rubbings",
    expectedDezoomer: "Seadragon (Deep Zoom Image)",
    url: "https://bronze.asdc.sinica.edu.tw/filePool/R/05395-1.html",
  },
  {
    name: "FSI Viewer",
    expectedDezoomer: "FSI",
    url: "https://www.neptunelabs.com/fsi-viewer/",
  },
  {
    name: "OpenSeadragon Zoomify",
    expectedDezoomer: "Zoomify",
    url: "https://openseadragon.github.io/examples/tilesource-zoomify/",
  },
  {
    name: "National Library of Israel",
    expectedDezoomer: "IIIF",
    url: "https://iiif.nli.org.il/IIIFv21/FL58252370/info.json",
  },
  {
    name: "National Library of Scotland",
    expectedDezoomer: "IIIF",
    url: "https://auchinleck.nls.uk/imageserver/iipsrv.fcgi?iiif=/auchinleck/105v.jp2/info.json",
  },
  {
    name: "National Library of Scotland map-view",
    expectedDezoomer: "IIIF",
    url: "https://map-view.nls.uk/iiif/19619%2F196194600/info.json",
  },
  {
    name: "pnav catalog.shm.ru",
    expectedDezoomer: "pnav",
    url: "https://catalog.shm.ru/entity/OBJECT/2117418",
  },
  {
    name: "pnav collection.pushkinmuseum.art",
    expectedDezoomer: "pnav",
    url: "https://collection.pushkinmuseum.art/entity/OBJECT/77606",
  },
  {
    name: "pnav collection.ethnomuseum.ru",
    expectedDezoomer: "pnav",
    url: "https://collection.ethnomuseum.ru/entity/OBJECT/32945",
  },
];

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

async function runLiveTarget(page, target) {
  const proxyUrl = `${new URL(page.url()).origin}/proxy`;

  return page.evaluate(
    ({ proxyUrl, target }) => {
      return new Promise((resolve, reject) => {
        const ZoomManager = window.ZoomManager;
        const timeout = setTimeout(() => {
          reject(new Error(
            `Timed out while running ${target.name}: ` +
            JSON.stringify({
              data: ZoomManager.data,
              dezoomerName: ZoomManager.dezoomer && ZoomManager.dezoomer.name,
              status: ZoomManager.status,
            })
          ));
        }, target.timeout || 25000);

        function finish(result) {
          clearTimeout(timeout);
          resolve(result);
        }

        function fail(error) {
          clearTimeout(timeout);
          reject(error instanceof Error ? error : new Error(String(error)));
        }

        window.onerror = function (message, source, line) {
          fail(new Error(`${message} (${source}:${line})`));
          return true;
        };

        ZoomManager.setDezoomer(ZoomManager.dezoomersList["Select automatically"]);
        ZoomManager.data = null;
        ZoomManager.proxy_url = proxyUrl;
        ZoomManager.proxy_tiles = "";
        ZoomManager.cookies = "";
        ZoomManager.nextTick = (fn) => setTimeout(fn, 0);
        ZoomManager.error = (message) => fail(new Error(message));
        ZoomManager.updateProgress = () => {};

        ZoomManager.readyToRender = (data) => {
          data.nbrTilesX = data.nbrTilesX || Math.ceil(data.width / data.tileSize);
          data.nbrTilesY = data.nbrTilesY || Math.ceil(data.height / data.tileSize);
          data.totalTiles = data.totalTiles || data.nbrTilesX * data.nbrTilesY;
          data.zoomFactor = data.zoomFactor || 2;
          data.baseZoomLevel = data.baseZoomLevel || 0;
          data.overlap = data.overlap || 0;

          ZoomManager.status.totalTiles = data.totalTiles;
          ZoomManager.data = data;

          const zoom = data.maxZoomLevel || ZoomManager.findMaxZoom(data);
          Promise.resolve(ZoomManager.dezoomer.getTileURL(0, 0, zoom, data))
            .then((tileUrl) => {
              if (data.origin) tileUrl = ZoomManager.resolveRelative(tileUrl, data.origin);
              const img = new Image();
              img.onload = () => finish({
                dezoomerName: ZoomManager.dezoomer.name,
                height: data.height,
                tileHeight: img.naturalHeight || img.height,
                tileUrl,
                tileWidth: img.naturalWidth || img.width,
                totalTiles: data.totalTiles,
                width: data.width,
              });
              img.onerror = () => fail(new Error(`Unable to load tile: ${tileUrl}`));
              img.referrerPolicy = "no-referrer";
              img.src = tileUrl;
            })
            .catch(fail);
        };

        ZoomManager.open(target.url);
      });
    },
    { proxyUrl, target }
  );
}

for (const target of targets) {
  test(target.name, async ({ page }) => {
    test.setTimeout(target.timeout || 30000);
    await openApp(page);

    const result = await runLiveTarget(page, target);

    expect(result.dezoomerName).toBe(target.expectedDezoomer);
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.totalTiles).toBeGreaterThan(0);
    expect(result.tileUrl).toContain("http");
    expect(result.tileWidth).toBeGreaterThan(0);
    expect(result.tileHeight).toBeGreaterThan(0);
  });
}
