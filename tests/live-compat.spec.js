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
    name: "Memoire des hommes",
    expectedDezoomer: "IIIF",
    url: "https://www.memoiredeshommes.defense.gouv.fr/_recherche-images/show/112145/image/56545/0/info.json",
  },
  {
    name: "London Museum collections",
    expectedDezoomer: "IIIF",
    url: "https://www.londonmuseum.org.uk/collections/v/object-95380/a-country-fair/",
  },
  {
    name: "Philadelphia Museum of Art",
    expectedDezoomer: "IIIF",
    url: "https://philamuseum.org/collection/object/101731",
  },
  {
    name: "Liechtenstein Collections",
    expectedDezoomer: "IIIF",
    url: "https://www.liechtensteincollections.at/en/collections-online/forest-landscape",
  },
  {
    name: "National Gallery of Victoria",
    expectedDezoomer: "Zoomify",
    url: "https://www.ngv.vic.gov.au/explore/collection/work/3867/",
  },
  {
    name: "Czech Digital Library",
    expectedDezoomer: "Zoomify",
    url: "https://api.ceskadigitalniknihovna.cz/search/api/client/v7.0/items/cuni/uuid:425e338e-9420-11ec-ac48-fa163e4ea95f/image/zoomify/ImageProperties.xml",
  },
  {
    name: "CSNTM manuscripts",
    expectedDezoomer: "IIIF",
    url: "https://collections.csntm.org/image-service/iiif/MNTGRCGA01/default/M_NT_GRC_GA01_20250609_203r/M_NT_GRC_GA01_20250609_203r/info.json",
  },
  {
    name: "Austrian National Library",
    expectedDezoomer: "IIIF",
    url: "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
  },
  {
    name: "Memorix TopViewer",
    expectedDezoomer: "TopViewer",
    url: "https://images.memorix.nl/wba/topviewjson/memorix/6eb5a89b-b76c-5039-3999-aabfd7a0c7c9",
  },
  {
    name: "Oklahoma State Digital Collections",
    expectedDezoomer: "IIIF",
    url: "https://dc.library.okstate.edu/digital/collection/OKMaps/id/6483/rec/6",
  },
  {
    name: "University of Washington Mirador",
    expectedDezoomer: "IIIF",
    url: "https://digitalcollections.lib.washington.edu/digital/custom/mirador3?manifest=https://digitalcollections.lib.washington.edu//iiif/info/social/1303/manifest.json",
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
    name: "Art Institute of Chicago Sargent archive",
    expectedDezoomer: "Seadragon (Deep Zoom Image)",
    url: "https://archive.artic.edu/sargent/",
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
    name: "Alabama Maps LizardTech",
    expectedDezoomer: "LizardTech ImageServer",
    url: "http://cartweb.geography.ua.edu/lizardtech/iserv/calcrgn?cat=North%20America%20and%20United%20States&item=NorthAmerica/US1566a.sid&wid=500&hei=400&props=item(Name,Description),cat(Name,Description)&style=default/view.xsl&plugin=true",
  },
  {
    name: "Geographicus",
    expectedDezoomer: "Zoomify",
    url: "https://www.geographicus.com/P/AntiqueMap/nantucket-sheminroyster-1973",
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
    name: "Westchester County Archives",
    expectedDezoomer: "IIIF",
    url: "https://collections.westchestergov.com/digital/collection/ccmaps/id/69/",
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

function escapeGitHubActionsAnnotation(value) {
  return String(value)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

function emitLiveFailureWarning(target, error) {
  if (process.env.GITHUB_ACTIONS !== "true") return;

  const title = escapeGitHubActionsAnnotation(`Live compatibility failed: ${target.name}`);
  const message = escapeGitHubActionsAnnotation(
    "A live website changed, blocked the runner, or returned an unexpected response. " +
    `URL: ${target.url}. Error: ${error.message}`
  );

  console.log(`::warning title=${title}::${message}`);
}

for (const target of targets) {
  test(target.name, async ({ page }, testInfo) => {
    test.setTimeout(target.timeout || 30000);

    try {
      await openApp(page);

      const result = await runLiveTarget(page, target);

      expect(result.dezoomerName).toBe(target.expectedDezoomer);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(result.totalTiles).toBeGreaterThan(0);
      expect(result.tileUrl).toContain("http");
      expect(result.tileWidth).toBeGreaterThan(0);
      expect(result.tileHeight).toBeGreaterThan(0);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failure.message = `${failure.message}\nLive target URL: ${target.url}`;
      if (testInfo.retry >= (testInfo.project.retries || 0)) {
        emitLiveFailureWarning(target, failure);
      }
      throw failure;
    }
  });
}
