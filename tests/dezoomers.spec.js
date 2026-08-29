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
        dezoomer: "Zoomify",
        url: "https://fixtures.test/zoomify-base-href/product.html",
        expectedTile: "https://fixtures.test/zoomify-base-href/assets/maps/sample/TileGroup0/1-1-1.jpg",
      },
      {
        dezoomer: "Seadragon (Deep Zoom Image)",
        url: "https://fixtures.test/deepzoom/sample.dzi",
        expectedTile: "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg",
      },
      {
        dezoomer: "Seadragon (Deep Zoom Image)",
        url: "https://fixtures.test/deepzoom/png_files/9/1_1.png",
        expectedTile: "https://fixtures.test/deepzoom/png_files/9/1_1.png",
      },
      {
        dezoomer: "Seadragon (Deep Zoom Image)",
        url: "https://fixtures.test/deepzoom/jpeg_files/9/1_1.jpeg",
        expectedTile: "https://fixtures.test/deepzoom/jpeg_files/9/1_1.jpeg",
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
        dezoomer: "IIIF",
        url: "https://fixtures.test/mirador?manifest=https://fixtures.test/iiif-presentation/manifest.json",
        expectedTile: "/iiif/mirador/256,256,256,256/256,256/0/native.jpg",
      },
      {
        dezoomer: "IIIF",
        url: "https://fixtures.test/uv/#?manifest=https%3A%2F%2Ffixtures.test%2Fiiif-presentation%2Fmanifest.json",
        expectedTile: "/iiif/mirador/256,256,256,256/256,256/0/native.jpg",
      },
      {
        dezoomer: "IIIF",
        url: "https://fixtures.test/micrio-custom-element",
        expectedTile: "https://iiif.micr.io/KEimL/256,256,256,256/256,256/0/default.jpg",
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
        dezoomer: "LizardTech ImageServer",
        url: "https://fixtures.test/lizardtech/iserv/calcrgn?cat=North%20America%20and%20United%20States&item=NorthAmerica/US1566a.sid&wid=500&hei=400&props=item(Name,Description),cat(Name,Description)&style=default/view.xsl&plugin=true",
        expectedTile: "https://fixtures.test/lizardtech/iserv/getimage?cat=North%20America%20and%20United%20States&item=NorthAmerica%2FUS1566a.sid&wid=512&hei=512&oif=jpeg&lev=0&cp=0.75,0.75",
      },
      {
        dezoomer: "VLS",
        url: "https://fixtures.test/vls/zoom/1",
        expectedTile: "https://fixtures.test/image/tiler/square/fixture/0/0/0",
      },
      {
        dezoomer: "Hungaricana",
        url: "https://fixtures.test/hungaricana/imagesize/sample.ecw",
        expectedTile: "https://fixtures.test/hungaricana/image/sample.ecw/",
      },
      {
        dezoomer: "WMTS",
        url: "https://fixtures.test/wmts/WMTSCapabilities.xml",
        expectedTile: "/wmts/EPSG3857/0/10/10.jpg",
      },
      {
        dezoomer: "ArcGIS MapServer",
        url: "https://fixtures.test/arcgis/MapServer",
        expectedTile: "/arcgis/MapServer/tile/7/3/4",
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

  test("covers Zoomify discovery branches", async ({ page }) => {
    const cases = [
      {
        name: "Flash zoomifyImagePath",
        url: "https://fixtures.test/zoomify/flash.html",
        expectedTile: "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        name: "Fluid Engage accessnumber",
        url: "https://fixtures.test/zoomify/fluid.html",
        expectedTile: "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        name: "OpenLayers source element",
        url: "https://fixtures.test/zoomify/openlayers.html",
        expectedTile: "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        name: "OpenLayers tile source",
        url: "https://fixtures.test/zoomify/tile-source.html",
        expectedTile: "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        name: "URL element",
        url: "https://fixtures.test/zoomify/url-element.html",
        expectedTile: "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        name: "University of Bern",
        url: "https://biblio.unibe.ch/web-apps/maps/zoomify.php?col=ryh&pic=Ryh_7906_6",
        expectedTile: "https://biblio.unibe.ch/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        name: "Paris specialized libraries",
        url: "https://bspe-p-pub.paris.fr/MDBGED/zoomify-BFS.aspx?edid=23143&edfindex=0",
        expectedTile: "https://bspe-p-pub.paris.fr/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        name: "National Gallery of Victoria",
        url: "https://www.ngv.vic.gov.au/explore/collection/work/3867/",
        expectedTile: "https://www.ngv.vic.gov.au/zoomify/TileGroup0/1-1-1.jpg",
      },
      {
        name: "Art and Architecture",
        url: "https://www.artandarchitecture.org.uk/images/zoom/c462969579cd09dd4ccb690d0e43018757fa2df2.html",
        expectedTile: "https://www.artandarchitecture.org.uk/zoomify/TileGroup0/1-1-1.jpg",
      },
    ];

    for (const item of cases) {
      const result = await runDezoomer(page, "Zoomify", item.url);

      expect(result.dezoomerName, item.name).toBe("Zoomify");
      expect(result.tiles.at(-1).url, item.name).toBe(item.expectedTile);
    }
  });

  test("discovers Zoomify through an iframe child page", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "Select automatically",
      "https://fixtures.test/zoomify/iframe-parent.html"
    );

    expect(result.dezoomerName).toBe("Zoomify");
    expect(result.tiles.at(-1).url).toContain(
      "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg"
    );
  });

  test("resolves a direct Zoomify TileGroup URL to sibling metadata", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "Select automatically",
      "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg"
    );

    expect(result.dezoomerName).toBe("Zoomify");
    expect(result.tiles.at(-1).url).toContain(
      "https://fixtures.test/zoomify/TileGroup0/1-1-1.jpg"
    );
  });

  test("uses Zoomify tile-group arithmetic across a group boundary", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "Zoomify",
      "https://fixtures.test/zoomify/multiple-groups/ImageProperties.xml"
    );

    expect(result.data.numTiles).toBe(341);
    expect(result.tiles).toHaveLength(256);
    expect(result.tiles[170].url).toBe(
      "https://fixtures.test/zoomify/multiple-groups/TileGroup0/4-10-10.jpg"
    );
    expect(result.tiles[171].url).toBe(
      "https://fixtures.test/zoomify/multiple-groups/TileGroup1/4-11-10.jpg"
    );
    expect(result.tiles.at(-1).url).toBe(
      "https://fixtures.test/zoomify/multiple-groups/TileGroup1/4-15-15.jpg"
    );
  });

  test("supports IIIF Image API 3 info.json responses", async ({ page }) => {
    const result = await runDezoomer(page, "Select automatically", "https://fixtures.test/iiif-v3/info.json");

    expect(result.dezoomerName).toBe("IIIF");
    expect(result.data.origin).toBe("http://127.0.0.1:9877/iiif/v3");
    expect(result.data.quality).toBe("default");
    expect(result.data.format).toBe("jpg");
    expect(result.tiles.at(-1).url).toContain("/iiif/v3/256,256,256,256/256,256/0/default.jpg");
  });

  test("covers Seadragon page and service discovery branches", async ({ page }) => {
    const cases = [
      {
        name: "British Library Viewer rewrite",
        url: "https://www.bl.uk/manuscripts/Viewer.aspx?ref=burney_ms_276_f031ar",
        expectedTile: "https://www.bl.uk/manuscripts/Proxy.ashx?view=burney_ms_276_f031ar_files/9/1_1.jpg",
      },
      {
        name: "Polona JSON conversion",
        url: "https://polona.pl/item/9388882/0/",
        expectedTile: "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg",
      },
      {
        name: "Paris specialized libraries rewrite",
        url: "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs",
        expectedTile: "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg",
      },
      {
        name: "World Digital Library view path",
        url: "https://fixtures.test/view/12/34",
        expectedTile: "https://fixtures.test/deepzoom/wdl-12-34_files/9/1_1.jpg",
      },
      {
        name: "Generic XML link",
        url: "https://fixtures.test/deepzoom/xml-link.html",
        expectedTile: "https://fixtures.test/deepzoom/legacy_files/9/1_1.jpg",
      },
      {
        name: "Generic DZI link",
        url: "https://fixtures.test/deepzoom/dzi-link.html",
        expectedTile: "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg",
      },
      {
        name: "Generic dzi attribute",
        url: "https://fixtures.test/deepzoom/dzi-query.html",
        expectedTile: "https://fixtures.test/deepzoom/legacy?format=xml_files/9/1_1.jpg",
      },
    ];

    for (const item of cases) {
      const result = await runDezoomer(page, "Seadragon (Deep Zoom Image)", item.url);

      expect(result.dezoomerName, item.name).toBe("Seadragon (Deep Zoom Image)");
      expect(result.tiles.at(-1).url, item.name).toBe(item.expectedTile);
    }
  });

  test("detects zoom.it and zoomhub.net page content", async ({ page }) => {
    for (const url of [
      "https://fixtures.test/deepzoom/zoomit.html",
      "https://fixtures.test/deepzoom/zoomhub.html",
    ]) {
      const result = await runDezoomer(page, "Select automatically", url);

      expect(result.dezoomerName, url).toBe("Seadragon (Deep Zoom Image)");
      expect(result.tiles.at(-1).url, url).toContain(
        "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg"
      );
    }
  });

  test("discovers a DZI through an iframe child page", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "Select automatically",
      "https://fixtures.test/deepzoom/iframe-parent.html"
    );

    expect(result.dezoomerName).toBe("Seadragon (Deep Zoom Image)");
    expect(result.tiles.at(-1).url).toContain(
      "https://fixtures.test/deepzoom/sample_files/9/1_1.jpg"
    );
  });

  test("converts Gallica ark URLs to IIIF info URLs", async ({ page }) => {
    const requests = [];
    const onRequest = (request) => {
      if (request.url().includes("/proxy?url=")) requests.push(request.url());
    };
    page.on("request", onRequest);

    const result = await runDezoomer(
      page,
      "IIIF",
      "https://gallica.bnf.fr/ark:/12148/btv1b10500000/f1"
    );

    page.off("request", onRequest);
    const requestedUrls = requests.map((requestUrl) =>
      decodeURIComponent(new URL(requestUrl).searchParams.get("url"))
    );
    expect(requestedUrls).toContain(
      "https://gallica.bnf.fr/iiif/ark:/12148/btv1b10500000/f1/info.json"
    );
    expect(result.tiles.at(-1).url).toContain("/iiif/v2/256,256,256,256/256,256/0/native.png");
  });

  test("rewrites Van Gogh Museum Micrio URLs to the CDN", async ({ page }) => {
    const requests = [];
    const onRequest = (request) => {
      if (request.url().includes("/proxy?url=")) requests.push(request.url());
    };
    page.on("request", onRequest);

    const result = await runDezoomer(
      page,
      "Select automatically",
      "https://fixtures.test/iiif/van-gogh.html"
    );

    page.off("request", onRequest);
    const requestedUrls = requests.map((requestUrl) =>
      decodeURIComponent(new URL(requestUrl).searchParams.get("url"))
    );
    expect(requestedUrls).toContain(
      "https://micrio-cdn.vangoghmuseum.nl/s0424M1991/info.json"
    );
    expect(result.dezoomerName).toBe("IIIF");
    expect(result.tiles.at(-1).url).toContain("/iiif/v3/256,256,256,256/256,256/0/default.jpg");
  });

  test("uses the fallback tile width for malformed IIIF metadata", async ({ page }) => {
    const tileRequests = [];
    const onRequest = (request) => {
      if (request.url().includes("/iiif/malformed-tile/")) tileRequests.push(request.url());
    };
    page.on("request", onRequest);

    const result = await runDezoomer(
      page,
      "IIIF",
      "https://fixtures.test/iiif-malformed-tile/info.json"
    );

    page.off("request", onRequest);
    expect(result.dezoomerName).toBe("IIIF");
    expect(tileRequests).toContain(
      "http://127.0.0.1:9877/iiif/malformed-tile/0,0,512,512/512,512/0/default.jpg"
    );
  });

  test("discovers cached ArcGIS MapServer viewer URLs and uses global row/column coordinates", async ({ page }) => {
    const serviceUrl = "https://fixtures.test/arcgis/MapServer?token=fixture&f=html";
    const viewerUrl = `https://wmts.ngi.be/arcgis/home/webmap/viewer.html?basemapUrl=${encodeURIComponent(serviceUrl)}`;
    const result = await runDezoomer(page, "Select automatically", viewerUrl);

    expect(result.dezoomerName).toBe("ArcGIS MapServer");
    expect(result.data.width).toBe(768);
    expect(result.data.height).toBe(768);
    expect(result.data.minColumn).toBe(2);
    expect(result.data.minRow).toBe(1);
    expect(result.tiles[0].url).toBe(
      "https://fixtures.test/arcgis/MapServer/tile/7/1/2?token=fixture"
    );
    expect(result.tiles[1].url).toBe(
      "https://fixtures.test/arcgis/MapServer/tile/7/1/3?token=fixture"
    );
    expect(result.tiles[3].url).toBe(
      "https://fixtures.test/arcgis/MapServer/tile/7/2/2?token=fixture"
    );
    expect(result.tiles.every(({ url }) => !url.includes("f="))).toBe(true);
  });

  test("rejects uncached ArcGIS MapServer responses", async ({ page }) => {
    await expect(runDezoomer(
      page,
      "ArcGIS MapServer",
      "https://fixtures.test/arcgis/uncached/MapServer"
    )).rejects.toThrow("does not provide a fused tile cache");
  });

  test("discovers ONB IIIF Presentation 3 manifests", async ({ page }) => {
    const cases = [
      "https://viewer.onb.ac.at/10048A37/",
      "https://viewer.onb.ac.at/10048A37/137",
      "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37",
      "https://digital.onb.ac.at/RepViewer/viewer.faces?doc=DTL_7039594&order=1&view=SINGLE",
    ];

    for (const url of cases) {
      const result = await runDezoomer(page, "Select automatically", url);

      expect(result.dezoomerName, url).toBe("IIIF");
      expect(result.data.origin, url).toBe("http://127.0.0.1:9877/iiif/onb/10048A37/uk4nGb4kQHe3msbC");
      expect(result.tiles.at(-1).url, url).toContain(
        "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg"
      );
    }
  });

  test("places Deep Zoom overlap only on non-edge tile axes", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "Seadragon (Deep Zoom Image)",
      "https://fixtures.test/deepzoom/overlap.dzi"
    );

    expect(result.data.overlap).toBe(1);
    expect(result.tiles.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 },
      { x: 255, y: 0 },
      { x: 0, y: 255 },
      { x: 255, y: 255 },
    ]);
  });

  test("discovers images from current Memorix mediabank pages", async ({ page }) => {
    const cases = [
      "https://www.beeldbankgroningen.nl/beelden/detail/53479cae-899f-0ac1-8913-40276a93a4f7/media/1c7914ee-3f37-0d37-3218-48eba1c3a97f?mode=detail&view=horizontal&rows=1&page=4&fq%5B%5D=search_s_download:%22Nee%22&sort=random%7B1785398988616%7D%20asc",
      "https://historischarchief.midden-groningen.nl/collectie/beelden/beelden-view/?mode=gallery&view=horizontal&sort=random%7B1785398881908%7D%20asc",
    ];

    for (const url of cases) {
      const result = await runDezoomer(page, "Select automatically", url);

      expect(result.dezoomerName, url).toBe("TopViewer");
      expect(result.data.width, url).toBe(512);
      expect(result.tiles.at(-1).url, url).toContain("/topviewer/sample-file/13.jpg");
    }
  });

  test("parses legacy Gahetna and RKD thumbnails", async ({ page }) => {
    const cases = [
      [
        "https://fixtures.test/topviewer/gahetna.html",
        "https://images.memorix.nl/naa/topviewjson/memorix/gahetna-sample",
      ],
      [
        "https://fixtures.test/topviewer/rkd.html",
        "https://images.rkd.nl/rkd/topviewjson/memorix/rkd-sample",
      ],
    ];

    await page.evaluate(() => {
      window.ZoomManager.proxy_url = `${window.location.origin}/proxy`;
      window.ZoomManager.cookies = "";
      window.ZoomManager.updateProgress = () => {};
    });

    for (const [url, expectedFile] of cases) {
      const file = await page.evaluate((input) => new Promise((resolve) => {
        window.ZoomManager.dezoomersList.TopViewer.findFile(input, resolve);
      }), url);

      expect(file, url).toBe(expectedFile);
    }
  });

  test("resolves Dememorixer institution detail URLs without fetching their pages", async ({ page }) => {
    const record = "11111111-1111-1111-1111-111111111111";
    const media = "22222222-2222-2222-2222-222222222222";
    const cases = [
      ["https://www.beeldbankgroningen.nl/beelden", "gra", record],
      ["https://salha.nl/bronnen/fotos-en-films/foto-s", "sha", record],
      ["https://archief.zaanstad.nl/mediabank/zoek-in-de-beeldbank", "zaa", record],
      ["https://erfgoedcentrumzutphen.nl/onderzoeken/beeldbank", "szu", record],
      [
        "https://noord-hollandsarchief.nl/beelden/beeldbank",
        "ranh",
        "11111111111111111111111111111111",
      ],
    ];

    for (const [baseUrl, imageServer, recordId] of cases) {
      const url = `${baseUrl.replace(/\/$/, "")}/detail/${recordId}/media/${media}`;
      const result = await page.evaluate((input) => {
        const ZoomManager = window.ZoomManager;
        const automatic = ZoomManager.dezoomersList["Select automatically"];
        const originalOpen = ZoomManager.open;
        let selectedDezoomer;
        ZoomManager.open = () => { selectedDezoomer = ZoomManager.dezoomer.name; };
        automatic.open(input);
        ZoomManager.open = originalOpen;

        return new Promise((resolve) => {
          ZoomManager.dezoomersList.TopViewer.findFile(input, (file) => {
            resolve({ file, selectedDezoomer });
          });
        });
      }, url);

      expect(result.selectedDezoomer, url).toBe("TopViewer");
      expect(result.file, url).toBe(
        `https://images.memorix.nl/${imageServer}/topviewjson/memorix/${media}`
      );
    }
  });

  test("discovers TopViewer files from embedded server metadata", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "TopViewer",
      "https://fixtures.test/topviewer/server.html"
    );

    expect(result.tiles.at(-1).url).toContain("/topviewer/sample-file/13.jpg");
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

  test("ignores internal IIIF ids and uses the public info.json base", async ({ page }) => {
    const result = await runDezoomer(page, "Select automatically", "/fixtures/iiif-private-id/info.json");

    expect(result.dezoomerName).toBe("IIIF");
    expect(result.data.origin).toBe("http://127.0.0.1:9877/fixtures/iiif-private-id");
    expect(result.tiles.at(-1).url).toContain(
      "/fixtures/iiif-private-id/256,256,256,256/256,256/0/native.png"
    );
    expect(result.tiles.at(-1).url).not.toContain("10.0.0.42");
  });

  test("uses the info.json origin when IIIF metadata has a same-host default port", async ({ page }) => {
    const result = await runDezoomer(page, "IIIF", "/fixtures/iiif-default-port/info.json");

    expect(result.dezoomerName).toBe("IIIF");
    expect(result.data.origin).toBe("http://127.0.0.1:9877/iiif/default-port");
    expect(result.tiles.at(-1).url).toContain(
      "http://127.0.0.1:9877/iiif/default-port/256,256,256,256/256,256/0/native.jpg"
    );
    expect(result.tiles.at(-1).url).not.toContain(":80/");
  });

  test("discovers CONTENTdm IIIF info URLs through the API", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "Select automatically",
      "https://fixtures.test/digital/collection/OKMaps/id/6483/rec/6"
    );

    expect(result.dezoomerName).toBe("IIIF");
    expect(result.data.origin).toBe("http://127.0.0.1:9877/digital/iiif/OKMaps/6483");
    expect(result.tiles.at(-1).url).toContain(
      "/digital/iiif/OKMaps/6483/256,256,256,256/256,256/0/native.jpg"
    );
  });

  test("rejects IIIF Presentation manifests with only plain images", async ({ page }) => {
    await expect(runDezoomer(
      page,
      "Select automatically",
      "https://fixtures.test/mirador?manifest=https://fixtures.test/iiif-presentation/plain-image-manifest.json"
    )).rejects.toThrow("No IIIF Image API service found in manifest.");
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

  test("extracts London Museum bare IIIF service roots from pages", async ({ page }) => {
    const result = await runDezoomer(page, "Select automatically", "https://fixtures.test/londonmuseum-object");

    expect(result.dezoomerName).toBe("IIIF");
    expect(result.data.origin).toBe("http://127.0.0.1:9877/iiif/londonmuseum/object-95380.ptif");
    expect(result.tiles.at(-1).url).toContain(
      "/iiif/londonmuseum/object-95380.ptif/256,256,256,256/256,256/0/default.jpg"
    );
  });

  test("extracts Prado OpenSeadragon metadata from artwork pages", async ({ page }) => {
    const result = await runDezoomer(
      page,
      "Select automatically",
      "https://www.museodelprado.es/en/the-collection/art-work/las-meninas/9fdc7800-9ade-48b0-ab8b-edee94ea877f?searchid=0a27f161-5629-8f4a-2756-ff085078076e"
    );

    expect(result.dezoomerName).toBe("Seadragon (Deep Zoom Image)");
    expect(result.data.origin).toBe(
      "https://content3.cdnprado.net/imagenes/Documentos/imgsem/9f/9fdc/9fdc7800-9ade-48b0-ab8b-edee94ea877f/41866afd-6396-45e7-bd26-944263cf92f7/"
    );
    expect(result.data.width).toBe(2362);
    expect(result.data.height).toBe(2697);
    expect(result.data.tileSize).toBe(256);
    expect(result.data.overlap).toBe(1);
    expect(result.data.maxZoomLevel).toBe(12);
    expect(result.tiles[0].url).toBe(
      "https://content3.cdnprado.net/imagenes/Documentos/imgsem/9f/9fdc/9fdc7800-9ade-48b0-ab8b-edee94ea877f/41866afd-6396-45e7-bd26-944263cf92f7/12/0_0.jpg"
    );
  });

  test("extracts Philadelphia Museum Micrio short IDs as IIIF info URLs", async ({ page }) => {
    const cases = [
      { url: "https://fixtures.test/philamuseum-escaped-shortid", shortId: "QYRjM" },
      { url: "https://fixtures.test/philamuseum-raw-shortid", shortId: "Raw01" },
    ];

    for (const item of cases) {
      const result = await runDezoomer(page, "Select automatically", item.url);

      expect(result.dezoomerName, item.url).toBe("IIIF");
      expect(result.data.origin, item.url).toBe(`http://127.0.0.1:9877/iiif/micrio/${item.shortId}`);
      expect(result.tiles.at(-1).url, item.url).toContain(
        `/iiif/micrio/${item.shortId}/256,256,256,256/256,256/0/default.png`
      );
    }
  });

});
