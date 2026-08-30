const { expect, test } = require("@playwright/test");

const AUTO = "Select automatically";
const fixture = (file) => `https://fixtures.test/${file}`;
const localFixture = (file) => `/fixtures/${file}`;
const lastTile = (result) => result.tiles.at(-1).url;

async function openApp(page) {
  await page.goto("/index.html");
  await page.waitForFunction(() => window.ZoomManager?.dezoomersList?.pnav);
}

async function runDezoomer(page, dezoomerName, url) {
  url = new URL(url, page.url()).href;
  return page.evaluate(({ dezoomerName, proxyUrl, url }) => new Promise((resolve, reject) => {
    const manager = window.ZoomManager;
    const dezoomer = manager.dezoomersList[dezoomerName];
    if (!dezoomer) return reject(new Error(`Unknown dezoomer: ${dezoomerName}`));

    const tiles = [];
    let settled = false;
    let timeout;
    const snapshot = () => ({
      dezoomerName: manager.dezoomer.name,
      data: JSON.parse(JSON.stringify(manager.data)),
      tiles,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const maybeFinish = () => {
      if (manager.data && manager.status.loaded >= manager.status.totalTiles) finish(snapshot());
    };

    timeout = setTimeout(() => fail(new Error(
      `Timed out while running ${dezoomerName}: ` + JSON.stringify({
        data: manager.data,
        dezoomerName: manager.dezoomer && manager.dezoomer.name,
        status: manager.status,
        tiles,
      })
    )), 7000);
    window.onerror = (message, source, line) => {
      fail(new Error(`${message} (${source}:${line})`));
      return true;
    };

    manager.setDezoomer(dezoomer);
    manager.data = null;
    manager.proxy_url = proxyUrl;
    manager.proxy_tiles = "";
    manager.cookies = "";
    manager.nextTick = (fn) => setTimeout(fn, 0);
    manager.addTile = (tileUrl, x, y) => {
      tiles.push({ url: String(tileUrl), x, y });
      manager.status.loaded++;
      maybeFinish();
    };
    manager.loadEnd = () => finish(snapshot());
    manager.error = fail;
    manager.open(url);
  }), {
    dezoomerName,
    proxyUrl: `${new URL(page.url()).origin}/proxy`,
    url,
  });
}

async function expectCases(page, cases) {
  for (const { label, url, expected, tile, mode = AUTO, data, tileIndex = -1 } of cases) {
    const result = await runDezoomer(page, mode, url);
    if (mode === AUTO) expect(result.dezoomerName, label).toBe(expected);
    expect(result.data.width, label).toBeGreaterThan(0);
    expect(result.data.height, label).toBeGreaterThan(0);
    expect(result.tiles.length, label).toBeGreaterThan(0);
    if (tile) expect(tileIndex < 0 ? lastTile(result) : result.tiles[tileIndex].url, label).toContain(tile);
    for (const [key, value] of Object.entries(data || {})) {
      expect(result.data[key], `${label}: ${key}`).toEqual(value);
    }
  }
}

async function findFile(page, dezoomerName, url) {
  url = new URL(url, page.url()).href;
  return page.evaluate(({ dezoomerName, proxyUrl, url }) => new Promise((resolve) => {
    const manager = window.ZoomManager;
    manager.proxy_url = proxyUrl;
    manager.cookies = "";
    manager.updateProgress = () => {};
    manager.dezoomersList[dezoomerName].findFile(url, resolve);
  }), {
    dezoomerName,
    proxyUrl: `${new URL(page.url()).origin}/proxy`,
    url,
  });
}

async function selectDezoomer(page, url) {
  return page.evaluate((url) => new Promise((resolve) => {
    const manager = window.ZoomManager;
    const automatic = manager.dezoomersList["Select automatically"];
    const originalOpen = manager.open;
    manager.proxy_url = `${window.location.origin}/proxy`;
    manager.cookies = "";
    manager.open = () => {
      const name = manager.dezoomer.name;
      manager.open = originalOpen;
      resolve(name);
    };
    automatic.open(url);
  }), new URL(url, page.url()).href);
}

async function captureProxyTargets(page, action) {
  const requests = [];
  const listener = (request) => requests.push(request.url());
  page.on("request", listener);
  try {
    return {
      value: await action(),
      requests,
      targets: requests
        .map((requestUrl) => new URL(requestUrl))
        .filter((requestUrl) => requestUrl.pathname === "/proxy" && requestUrl.searchParams.has("url"))
        .map((requestUrl) => requestUrl.searchParams.get("url")),
    };
  } finally {
    page.off("request", listener);
  }
}

async function probeGeneric(page, url) {
  return page.evaluate(({ proxyUrl, url }) => new Promise((resolve) => {
    const manager = window.ZoomManager;
    const originalReadyToRender = manager.readyToRender;
    manager.proxy_url = proxyUrl;
    manager.cookies = "";
    manager.readyToRender = (data) => {
      manager.readyToRender = originalReadyToRender;
      resolve(data);
    };
    manager.dezoomersList["Generic dezoomer"].open(url);
  }), {
    proxyUrl: `${new URL(page.url()).origin}/proxy`,
    url,
  });
}

async function renderAssembly(page, spec) {
  await page.evaluate((input) => {
    const manager = window.ZoomManager;
    const tiles = new Map(input.tiles.map((tile) => [`${tile.x},${tile.y}`, tile]));
    const data = {
      width: input.width,
      height: input.height,
      tileSize: input.tileSize,
      nbrTilesX: input.nbrTilesX,
      nbrTilesY: input.nbrTilesY,
      totalTiles: input.nbrTilesX * input.nbrTilesY,
      maxZoomLevel: 1,
      overlap: input.overlap || 0,
    };
    manager.dezoomer = {
      getTileURL(x, y) {
        const tile = tiles.get(`${x},${y}`);
        if (!tile) return;
        const params = new URLSearchParams({
          x: String(x),
          y: String(y),
          w: String(tile.width || input.tileSize),
          h: String(tile.height || input.tileSize),
          color: tile.color,
        });
        return `${window.location.origin}/fixtures/assembly/tile.svg?${params}`;
      },
    };
    manager.data = data;
    manager.status = { error: false, loaded: 0, totalTiles: data.totalTiles };
    manager.proxy_tiles = "";
    manager.cookies = "";
    manager.nextTick = (fn) => setTimeout(fn, 0);
    UI.setupRendering(data);
    manager.defaultRender(data);
  }, spec);

  await page.waitForFunction((totalTiles) => {
    return window.ZoomManager.status.loaded >= totalTiles;
  }, spec.nbrTilesX * spec.nbrTilesY);
  return page.evaluate((points) => points.map(({ x, y }) => {
    return Array.from(UI.ctx.getImageData(x, y, 1, 1).data);
  }), spec.points);
}

const c = (label, url, expected, tile, mode = AUTO, data, tileIndex = -1) => ({
  label, url, expected, tile, mode, data, tileIndex,
});

const coreCases = [
  c("generic", "/fixtures/generic/tile.jpg?x={{X}}&y={{Y}}", "Generic dezoomer", "/fixtures/generic/tile.jpg?x=1&y=1"),
  c("zoomify", fixture("zoomify/ImageProperties.xml"), "Zoomify", fixture("zoomify/TileGroup0/1-1-1.jpg")),
  c("zoomify base", fixture("zoomify-base-href/product.html"), "Zoomify", fixture("zoomify-base-href/assets/maps/sample/TileGroup0/1-1-1.jpg")),
  c("DZI", fixture("deepzoom/sample.dzi"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/sample_files/9/1_1.jpg")),
  c("PNG DZI tile", fixture("deepzoom/png_files/9/1_1.png"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/png_files/9/1_1.png")),
  c("JPEG DZI tile", fixture("deepzoom/jpeg_files/9/1_1.jpeg"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/jpeg_files/9/1_1.jpeg")),
  c("legacy Seadragon", fixture("deepzoom/legacy-embed.html"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/legacy_files/9/1_1.jpg")),
  c("IIIF 2", localFixture("iiif-v2/info.json"), "IIIF", "/iiif/v2/256,256,256,256/256,256/0/native.png"),
  c("Mirador", `${fixture("mirador?manifest=")}${fixture("iiif-presentation/manifest.json")}`, "IIIF", "/iiif/mirador/256,256,256,256/256,256/0/native.jpg"),
  c("Universal Viewer", `${fixture("uv/#?manifest=")}${encodeURIComponent(fixture("iiif-presentation/manifest.json"))}`, "IIIF", "/iiif/mirador/256,256,256,256/256,256/0/native.jpg"),
  c("Micrio element", fixture("micrio-custom-element"), "IIIF", "https://iiif.micr.io/KEimL/256,256,256,256/256,256/0/default.jpg"),
  c("IIPImage", `${fixture("iip?FIF=/image.tif")}`, "IIPImage", "?FIF=/image.tif&JTL=1,3"),
  c("krpano", fixture("krpano/pano.xml"), "krpano", fixture("krpano/tiles/l1/2_2.jpg")),
  c("XLimage", fixture("xl/sample.imgi?cmd=info"), "XLimage", "?cmd=tile&x=1&y=1&z=1"),
  c("TopViewer JSON", fixture("topviewer/data.json"), "TopViewer", "/topviewer/sample-file/13.jpg"),
  c("TopViewer thumbnail", fixture("topviewer/page?FIF=not-iip"), "TopViewer", "/topviewer/sample-file/13.jpg"),
  c("FSI", fixture("fsi/server?type=info&source=image&image=image"), "FSI", "?type=image&source=image"),
  c("LizardTech", fixture("lizardtech/iserv/calcrgn?cat=North%20America%20and%20United%20States&item=NorthAmerica/US1566a.sid&wid=500&hei=400&props=item(Name,Description),cat(Name,Description)&style=default/view.xsl&plugin=true"), "LizardTech ImageServer", "getimage?cat=North%20America%20and%20United%20States&item=NorthAmerica%2FUS1566a.sid&wid=512&hei=512&oif=jpeg&lev=0&cp=0.75,0.75"),
  c("VLS", fixture("vls/zoom/1"), "VLS", "/image/tiler/square/fixture/0/0/0"),
  c("Hungaricana", fixture("hungaricana/imagesize/sample.ecw"), "Hungaricana", "image/sample.ecw/"),
  c("WMTS", fixture("wmts/WMTSCapabilities.xml"), "WMTS", "/wmts/EPSG3857/0/10/10.jpg"),
  c("ArcGIS", fixture("arcgis/MapServer"), "ArcGIS MapServer", "/arcgis/MapServer/tile/7/3/4"),
  c("pnav", fixture("entity/OBJECT/1"), "pnav", "/fixtures/pnav/image.jpg?w=2000&h=2000&cl=0&ct=0&cw=512&ch=512"),
];

const zoomifyCases = [
  c("Flash zoomifyImagePath", fixture("zoomify/flash.html"), "Zoomify", fixture("zoomify/TileGroup0/1-1-1.jpg")),
  c("Fluid Engage accessnumber", fixture("zoomify/fluid.html"), "Zoomify", fixture("zoomify/TileGroup0/1-1-1.jpg")),
  c("OpenLayers source element", fixture("zoomify/openlayers.html"), "Zoomify", fixture("zoomify/TileGroup0/1-1-1.jpg")),
  c("OpenLayers tile source", fixture("zoomify/tile-source.html"), "Zoomify", fixture("zoomify/TileGroup0/1-1-1.jpg")),
  c("URL element", fixture("zoomify/url-element.html"), "Zoomify", fixture("zoomify/TileGroup0/1-1-1.jpg"), "Zoomify"),
  c("University of Bern", "https://biblio.unibe.ch/web-apps/maps/zoomify.php?col=ryh&pic=Ryh_7906_6", "Zoomify", "https://biblio.unibe.ch/zoomify/TileGroup0/1-1-1.jpg"),
  c("Paris Zoomify", "https://bspe-p-pub.paris.fr/MDBGED/zoomify-BFS.aspx?edid=23143&edfindex=0", "Zoomify", "https://bspe-p-pub.paris.fr/zoomify/TileGroup0/1-1-1.jpg"),
  c("National Gallery of Victoria", "https://www.ngv.vic.gov.au/explore/collection/work/3867/", "Zoomify", "https://www.ngv.vic.gov.au/zoomify/TileGroup0/1-1-1.jpg"),
  c("Art and Architecture", "https://www.artandarchitecture.org.uk/images/zoom/c462969579cd09dd4ccb690d0e43018757fa2df2.html", "Zoomify", "https://www.artandarchitecture.org.uk/zoomify/TileGroup0/1-1-1.jpg"),
  c("Zoomify iframe", fixture("zoomify/iframe-parent.html"), "Zoomify", fixture("zoomify/TileGroup0/1-1-1.jpg")),
  c("Zoomify tile URL", fixture("zoomify/TileGroup0/1-1-1.jpg"), "Zoomify", fixture("zoomify/TileGroup0/1-1-1.jpg")),
];

const seadragonCases = [
  c("British Library Viewer", "https://www.bl.uk/manuscripts/Viewer.aspx?ref=burney_ms_276_f031ar", "Seadragon (Deep Zoom Image)", "https://www.bl.uk/manuscripts/Proxy.ashx?view=burney_ms_276_f031ar_files/9/1_1.jpg"),
  c("Prado data-pyr", "https://www.museodelprado.es/en/the-collection/art-work/las-meninas/9fdc7800-9ade-48b0-ab8b-edee94ea877f?searchid=0a27f161-5629-8f4a-2756-ff085078076e", "Seadragon (Deep Zoom Image)", "https://content3.cdnprado.net/imagenes/Documentos/imgsem/9f/9fdc/9fdc7800-9ade-48b0-ab8b-edee94ea877f/41866afd-6396-45e7-bd26-944263cf92f7/12/0_0.jpg", AUTO, {
    origin: "https://content3.cdnprado.net/imagenes/Documentos/imgsem/9f/9fdc/9fdc7800-9ade-48b0-ab8b-edee94ea877f/41866afd-6396-45e7-bd26-944263cf92f7/",
    width: 2362,
    height: 2697,
    tileSize: 256,
    overlap: 1,
    maxZoomLevel: 12,
  }, 0),
  c("Polona JSON", "https://polona.pl/item/9388882/0/", "Seadragon (Deep Zoom Image)", fixture("deepzoom/sample_files/9/1_1.jpg")),
  c("National Library of Australia", "https://nla.gov.au/nla.obj-152642460/view", "Seadragon (Deep Zoom Image)", "https://nla.gov.au/nla.obj-152642460/dzi?tile=13/20_25.jpg"),
  c("Paris DZI rewrite", "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs", "Seadragon (Deep Zoom Image)", fixture("deepzoom/sample_files/9/1_1.jpg")),
  c("World Digital Library", fixture("view/12/34"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/wdl-12-34_files/9/1_1.jpg")),
  c("XML link", fixture("deepzoom/xml-link.html"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/legacy_files/9/1_1.jpg"), "Seadragon (Deep Zoom Image)"),
  c("DZI link", fixture("deepzoom/dzi-link.html"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/sample_files/9/1_1.jpg")),
  c("DZI attribute", fixture("deepzoom/dzi-query.html"), "Seadragon (Deep Zoom Image)", "deepzoom/legacy?format=xml_files/9/1_1.jpg"),
  c("zoom.it", fixture("deepzoom/zoomit.html"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/sample_files/9/1_1.jpg")),
  c("zoomhub", fixture("deepzoom/zoomhub.html"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/sample_files/9/1_1.jpg")),
  c("DZI iframe", fixture("deepzoom/iframe-parent.html"), "Seadragon (Deep Zoom Image)", fixture("deepzoom/sample_files/9/1_1.jpg")),
];

const iiifCases = [
  c("IIIF 3", fixture("iiif-v3/info.json"), "IIIF", "/iiif/v3/256,256,256,256/256,256/0/default.jpg", AUTO, {
    origin: "http://127.0.0.1:9877/iiif/v3",
    quality: "default",
    format: "jpg",
  }),
  c("ONB viewer", "https://viewer.onb.ac.at/10048A37/", "IIIF", "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg", AUTO, { origin: "http://127.0.0.1:9877/iiif/onb/10048A37/uk4nGb4kQHe3msbC" }),
  c("ONB viewer page", "https://viewer.onb.ac.at/10048A37/137", "IIIF", "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg", AUTO, { origin: "http://127.0.0.1:9877/iiif/onb/10048A37/uk4nGb4kQHe3msbC" }),
  c("ONB manifest", "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37", "IIIF", "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg", AUTO, { origin: "http://127.0.0.1:9877/iiif/onb/10048A37/uk4nGb4kQHe3msbC" }),
  c("ONB RepViewer", "https://digital.onb.ac.at/RepViewer/viewer.faces?doc=DTL_7039594&order=1&view=SINGLE", "IIIF", "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg", AUTO, { origin: "http://127.0.0.1:9877/iiif/onb/10048A37/uk4nGb4kQHe3msbC" }),
  c("private IIIF id", "/fixtures/iiif-private-id/info.json", "IIIF", "/fixtures/iiif-private-id/256,256,256,256/256,256/0/native.png"),
  c("IIIF default port", "/fixtures/iiif-default-port/info.json", "IIIF", "/iiif/default-port/256,256,256,256/256,256/0/native.jpg"),
  c("CONTENTdm", fixture("digital/collection/OKMaps/id/6483/rec/6"), "IIIF", "/digital/iiif/OKMaps/6483/256,256,256,256/256,256/0/native.jpg", AUTO, { origin: "http://127.0.0.1:9877/digital/iiif/OKMaps/6483" }),
  c("National Gallery page", fixture("national-gallery"), "IIIF", "/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif/256,256,256,256/256,256/0/default.jpg", AUTO, { origin: "http://127.0.0.1:9877/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif" }),
  c("London Museum page", fixture("londonmuseum-object"), "IIIF", "/iiif/londonmuseum/object-95380.ptif/256,256,256,256/256,256/0/default.jpg", AUTO, { origin: "http://127.0.0.1:9877/iiif/londonmuseum/object-95380.ptif" }),
  c("Philadelphia escaped", fixture("philamuseum-escaped-shortid"), "IIIF", "/iiif/micrio/QYRjM/256,256,256,256/256,256/0/default.png", AUTO, { origin: "http://127.0.0.1:9877/iiif/micrio/QYRjM" }),
  c("Philadelphia raw", fixture("philamuseum-raw-shortid"), "IIIF", "/iiif/micrio/Raw01/256,256,256,256/256,256/0/default.png", AUTO, { origin: "http://127.0.0.1:9877/iiif/micrio/Raw01" }),
];

test.describe("dezoomer fixture coverage", () => {
  test.beforeEach(async ({ page }) => openApp(page));

  test("runs core protocol fixtures", async ({ page }) => {
    await expectCases(page, coreCases);
  });

  test("keeps required metadata query parameters covered", async ({ page }) => {
    const iip = await captureProxyTargets(page, () => runDezoomer(
      page,
      "IIPImage",
      fixture("iip?FIF=/image.tif")
    ));
    const iipInfo = new URL(iip.targets.find((target) => new URL(target).pathname === "/iip"));
    expect(iipInfo.searchParams.getAll("OBJ")).toEqual([
      "Max-size",
      "Tile-size",
      "Resolution-number",
    ]);

    const memorix = await captureProxyTargets(page, () => runDezoomer(
      page,
      AUTO,
      "https://historischarchief.midden-groningen.nl/collectie/beelden/beelden-view/?mode=gallery&view=horizontal&sort=random%7B1785398881908%7D%20asc"
    ));
    const media = new URL(memorix.targets.find((target) => new URL(target).pathname === "/mediabank/media"));
    expect(media.searchParams.get("apiKey")).toBe("c51f00b2-2034-45a2-85ce-0aca7143dbbc");
    expect(media.searchParams.get("entities[0]")).toBe("77036348-6551-9e9d-5b2e-b505237e84cf");
    expect(media.searchParams.get("rows")).toBe("1");
    expect(media.searchParams.get("sort")).toBe("random{1785398881908} asc");
  });

  test("covers generic probing and encoded templates", async ({ page }) => {
    const local = (file) => new URL(`/fixtures/generic/${file}`, page.url()).href;
    const cases = [
      ["padded.svg?x={{X:05}}&y={{Y:05}}", [512, 512, 256]],
      ["large.svg?x={{X}}&y={{Y}}", [1024, 512, 512]],
      ["edge.svg?x={{X}}&y={{Y}}", [512, 512, 256]],
      ["boundary.svg?x={{X}}&y={{Y}}", [256000, 256, 256]],
      ["one.svg?x={{X}}&y={{Y}}", [768, 256, 256]],
      ["missing-origin.svg?x={{X}}&y={{Y}}", [512, 512, 256]],
      ["placeholder.svg?x={{X}}&y={{Y}}", [512, 512, 256]],
    ];
    for (const [file, expected] of cases) {
      const data = await probeGeneric(page, local(file));
      expect([data.width, data.height, data.tileSize], file).toEqual(expected);
    }

    const missing = await runDezoomer(page, "Generic dezoomer", local("missing-origin.svg?x={{X}}&y={{Y}}"));
    expect(missing.data.width).toBe(512);
    expect(missing.tiles[0].url).toContain("x=0&y=0");

    const encoded = local("padded.svg?x=%7B%7BX%7D%7D&y=%7B%7BY%7D%7D");
    const tile = await page.evaluate((url) => {
      return window.ZoomManager.dezoomersList["Generic dezoomer"].getTileURL(7, 9, 0, { origin: url });
    }, encoded);
    expect(tile).toBe(local("padded.svg?x=7&y=9"));
    expect(await selectDezoomer(page, encoded)).toBe("Generic dezoomer");

    const encodedPadded = local("padded.svg?x=%7B%7BX:05%7D%7D&y=%7B%7BY:05%7D%7D");
    const paddedTile = await page.evaluate((url) => {
      return window.ZoomManager.dezoomersList["Generic dezoomer"].getTileURL(7, 9, 0, { origin: url });
    }, encodedPadded);
    expect(paddedTile).toBe(local("padded.svg?x=00007&y=00009"));
    expect(await selectDezoomer(page, encodedPadded)).toBe("Generic dezoomer");
  });

  test("covers Zoomify discovery branches", async ({ page }) => {
    await expectCases(page, zoomifyCases);

    const boundary = await runDezoomer(page, "Zoomify", fixture("zoomify/multiple-groups/ImageProperties.xml"));
    expect(boundary.data.numTiles).toBe(341);
    expect(boundary.tiles).toHaveLength(256);
    expect(boundary.tiles[170].url).toBe(fixture("zoomify/multiple-groups/TileGroup0/4-10-10.jpg"));
    expect(boundary.tiles[171].url).toBe(fixture("zoomify/multiple-groups/TileGroup1/4-11-10.jpg"));
    expect(lastTile(boundary)).toBe(fixture("zoomify/multiple-groups/TileGroup1/4-15-15.jpg"));

    const fullResolution = await runDezoomer(page, AUTO, fixture("zoomify-full-numtiles/ImageProperties.xml"));
    expect(fullResolution.data.numTiles).toBe(280);
    expect(fullResolution.data.numTilesIsFullResolutionOnly).toBe(true);
    expect(fullResolution.tiles).toHaveLength(280);
    expect(fullResolution.tiles.every((tile) => tile.url.includes("/TileGroup0/"))).toBe(true);
    expect(fullResolution.tiles.map((tile) => tile.url)).toContain(
      fixture("zoomify-full-numtiles/TileGroup0/6-16-6.jpg")
    );
  });

  test("covers Seadragon discovery branches", async ({ page }) => {
    await expectCases(page, seadragonCases);
  });

  test("covers IIIF discovery branches", async ({ page }) => {
    await expectCases(page, iiifCases);

    const gallica = await captureProxyTargets(page, () => runDezoomer(
      page,
      "IIIF",
      "https://gallica.bnf.fr/ark:/12148/btv1b10500000/f1"
    ));
    expect(gallica.targets).toContain(
      "https://gallica.bnf.fr/iiif/ark:/12148/btv1b10500000/f1/info.json"
    );
    expect(lastTile(gallica.value)).toContain("/iiif/v2/256,256,256,256/256,256/0/native.png");

    const vanGogh = await captureProxyTargets(page, () => runDezoomer(
      page,
      AUTO,
      fixture("iiif/van-gogh.html")
    ));
    expect(vanGogh.targets).toContain(
      "https://micrio-cdn.vangoghmuseum.nl/s0424M1991/info.json"
    );
    expect(vanGogh.value.dezoomerName).toBe("IIIF");

    const malformed = await captureProxyTargets(page, () => runDezoomer(
      page,
      "IIIF",
      fixture("iiif-malformed-tile/info.json")
    ));
    expect(malformed.requests).toContain(
      "http://127.0.0.1:9877/iiif/malformed-tile/0,0,512,512/512,512/0/default.jpg"
    );

    const overlap = await runDezoomer(page, "Seadragon (Deep Zoom Image)", fixture("deepzoom/overlap.dzi"));
    expect(overlap.data.overlap).toBe(1);
    expect(overlap.tiles.map(({ x, y }) => ({ x, y }))).toEqual([
      { x: 0, y: 0 }, { x: 255, y: 0 }, { x: 0, y: 255 }, { x: 255, y: 255 },
    ]);

    const explicit = await page.evaluate(() => {
      const iiif = window.ZoomManager.dezoomersList.IIIF;
      const data = { origin: "https://iiif.example/image", width: 600, height: 384, tileSize: 256, quality: "default", format: "jpg" };
      return [iiif.getTileURL(0, 0, 1, data), iiif.getTileURL(1, 1, 1, data)];
    });
    expect(explicit).toEqual([
      "https://iiif.example/image/0,0,256,256/256,256/0/default.jpg",
      "https://iiif.example/image/256,256,256,128/256,128/0/default.jpg",
    ]);

    await expect(runDezoomer(
      page,
      AUTO,
      `${fixture("mirador?manifest=")}${fixture("iiif-presentation/plain-image-manifest.json")}`
    )).rejects.toThrow("No IIIF Image API service found in manifest.");
  });

  test("covers TopViewer and Memorix discovery", async ({ page }) => {
    await expectCases(page, [
      c("Beeldbank Groningen", "https://www.beeldbankgroningen.nl/beelden/detail/53479cae-899f-0ac1-8913-40276a93a4f7/media/1c7914ee-3f37-0d37-3218-48eba1c3a97f?mode=detail&view=horizontal&rows=1&page=4&fq%5B%5D=search_s_download:%22Nee%22&sort=random%7B1785398988616%7D%20asc", "TopViewer", "/topviewer/sample-file/13.jpg"),
      c("Historisch Archief Midden-Groningen", "https://historischarchief.midden-groningen.nl/collectie/beelden/beelden-view/?mode=gallery&view=horizontal&sort=random%7B1785398881908%7D%20asc", "TopViewer", "/topviewer/sample-file/13.jpg"),
  c("embedded server", fixture("topviewer/server.html"), "TopViewer", "/topviewer/sample-file/13.jpg", "TopViewer"),
    ]);

    const thumbnails = [
      [fixture("topviewer/gahetna.html"), "https://images.memorix.nl/naa/topviewjson/memorix/gahetna-sample"],
      [fixture("topviewer/rkd.html"), "https://images.rkd.nl/rkd/topviewjson/memorix/rkd-sample"],
    ];
    for (const [url, expected] of thumbnails) expect(await findFile(page, "TopViewer", url), url).toBe(expected);

    const record = "11111111-1111-1111-1111-111111111111";
    const media = "22222222-2222-2222-2222-222222222222";
    const sites = [
      ["https://www.beeldbankgroningen.nl/beelden", "gra", record],
      ["https://salha.nl/bronnen/fotos-en-films/foto-s", "sha", record],
      ["https://archief.zaanstad.nl/mediabank/zoek-in-de-beeldbank", "zaa", record],
      ["https://erfgoedcentrumzutphen.nl/onderzoeken/beeldbank", "szu", record],
      ["https://noord-hollandsarchief.nl/beelden/beeldbank", "ranh", "11111111111111111111111111111111"],
    ];
    for (const [base, imageServer, recordId] of sites) {
      const url = `${base}/detail/${recordId}/media/${media}`;
      expect(await selectDezoomer(page, url), url).toBe("TopViewer");
      expect(await findFile(page, "TopViewer", url), url).toBe(
        `https://images.memorix.nl/${imageServer}/topviewjson/memorix/${media}`
      );
    }
  });

  test("covers remaining site adapters and automatic selection", async ({ page }) => {
    const arcgisRun = await captureProxyTargets(page, () => runDezoomer(
      page,
      AUTO,
      `${fixture("arcgis/MapServer?token=fixture&f=html")}`
    ));
    const arcgis = arcgisRun.value;
    expect(arcgisRun.targets).toContain(`${fixture("arcgis/MapServer?token=fixture&f=json")}`);
    expect(arcgis.dezoomerName).toBe("ArcGIS MapServer");
    expect({ width: arcgis.data.width, height: arcgis.data.height, minColumn: arcgis.data.minColumn, minRow: arcgis.data.minRow }).toEqual({
      width: 768, height: 768, minColumn: 2, minRow: 1,
    });
    expect(arcgis.tiles.slice(0, 2).map((tile) => tile.url)).toEqual([
      `${fixture("arcgis/MapServer")}/tile/7/1/2?token=fixture`,
      `${fixture("arcgis/MapServer")}/tile/7/1/3?token=fixture`,
    ]);
    expect(arcgis.tiles[3].url).toBe(`${fixture("arcgis/MapServer")}/tile/7/2/2?token=fixture`);
    expect(arcgis.tiles.every(({ url }) => !url.includes("f="))).toBe(true);

    await expect(runDezoomer(page, "ArcGIS MapServer", fixture("arcgis/uncached/MapServer")))
      .rejects.toThrow("does not provide a fused tile cache");
    const basemapService = fixture("arcgis/MapServer?token=fixture&f=html");
    const basemap = await captureProxyTargets(page, () => runDezoomer(
      page,
      AUTO,
      `https://wmts.ngi.be/arcgis/home/webmap/viewer.html?basemapUrl=${encodeURIComponent(basemapService)}`
    ));
    expect(basemap.value.dezoomerName).toBe("ArcGIS MapServer");
    expect(basemap.targets).toContain(`${fixture("arcgis/MapServer?token=fixture&f=json")}`);
    expect(await selectDezoomer(
      page,
      "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml"
    )).toBe("WMTS");

    const artsCases = [
      ["https://artsandculture.google.com/asset/fixture", "HEADABCDEFGHIJKLMNOPTAIL", "/arts/path=x0-y0-z0-t"],
      ["https://g.co/arts/fixture", "HEADABCDEFGHIJKLMNOPTAIL", "/arts/path=x0-y0-z0-t"],
      ["https://artsandculture.google.com/asset/plain", "plain-tile", "/arts/plain=x0-y0-z0-t"],
    ];
    for (const [url, expectedBytes, path] of artsCases) {
      const run = await captureProxyTargets(page, () => runDezoomer(page, AUTO, url));
      const bytes = await page.evaluate(async (blobUrl) => {
        return Array.from(new Uint8Array(await fetch(blobUrl).then((response) => response.arrayBuffer())));
      }, run.value.tiles[0].url);
      expect(run.value.dezoomerName, url).toBe("Arts & Culture");
      expect(bytes, url).toEqual(Array.from(Buffer.from(expectedBytes)));
      expect(run.targets.some((target) => new URL(target).pathname.startsWith(path)), url).toBe(true);
    }

    const promptResult = await page.evaluate(() => new Promise((resolve) => {
      const originalPrompt = window.prompt;
      window.prompt = () => "3";
      window.ZoomManager.dezoomersList.XLimage.findFile(
        "https://kbr.be/multi/abcViewer/index.html",
        (file) => {
          window.prompt = originalPrompt;
          resolve(file);
        }
      );
    }));
    expect(promptResult).toBe("/multi/abcViewer/xml.php?/multi/abc/004.imgi?cmd=info");

    const hungaricana = [
      [fixture("hungaricana/imagepath.html"), "imagepath.ecw"],
      [fixture("hungaricana/inline-files.html?img=1"), "second.ecw"],
      [fixture("hungaricana/inline-images.html?pg=1"), "second.ecw"],
      [fixture("hungaricana/files-url.html?img=1"), "second.ecw"],
    ];
    for (const [url, file] of hungaricana) {
      expect(await findFile(page, "Hungaricana", url), url).toBe(
        `https://fixtures.test/hungaricana/image/page/${file}`
      );
    }

    expect(await selectDezoomer(page, fixture("automatic/precedence.html"))).toBe("Zoomify");
    const requests = await captureProxyTargets(page, async () => {
      await expect(runDezoomer(page, AUTO, fixture("automatic/repeated-parent.html")))
        .rejects.toThrow("Unable to find a proper dezoomer");
      await expect(runDezoomer(page, AUTO, fixture("automatic/cycle-a.html")))
        .rejects.toThrow("Unable to find a proper dezoomer");
    });
    expect(requests.targets.filter((url) => url.endsWith("/automatic/child.html"))).toHaveLength(1);
    expect(requests.targets.filter((url) => url.endsWith("/automatic/cycle-a.html"))).toHaveLength(1);
    expect(requests.targets.filter((url) => url.endsWith("/automatic/cycle-b.html"))).toHaveLength(1);
  });

  test("assembles every tile layout at exact pixels", async ({ page }) => {
    const cases = [
      {
        width: 512, height: 512, tileSize: 256, nbrTilesX: 2, nbrTilesY: 2,
        tiles: [
          { x: 0, y: 0, color: "ff0000" }, { x: 1, y: 0, color: "00ff00" },
          { x: 0, y: 1, color: "0000ff" }, { x: 1, y: 1, color: "ffff00" },
        ],
        points: [
          { x: 10, y: 10, expected: [255, 0, 0, 255] }, { x: 300, y: 10, expected: [0, 255, 0, 255] },
          { x: 10, y: 300, expected: [0, 0, 255, 255] }, { x: 300, y: 300, expected: [255, 255, 0, 255] },
        ],
      },
      {
        width: 511, height: 511, tileSize: 256, nbrTilesX: 2, nbrTilesY: 2, overlap: 1,
        tiles: [
          { x: 0, y: 0, color: "ff0000" }, { x: 1, y: 0, color: "00ff00" },
          { x: 0, y: 1, color: "0000ff" }, { x: 1, y: 1, color: "ffff00" },
        ],
        points: [
          { x: 254, y: 10, expected: [255, 0, 0, 255] }, { x: 255, y: 10, expected: [0, 255, 0, 255] },
          { x: 254, y: 254, expected: [255, 0, 0, 255] }, { x: 255, y: 255, expected: [255, 255, 0, 255] },
        ],
      },
      {
        width: 512, height: 256, tileSize: 256, nbrTilesX: 2, nbrTilesY: 1,
        tiles: [{ x: 0, y: 0, color: "ff0000" }],
        points: [{ x: 10, y: 10, expected: [255, 0, 0, 255] }, { x: 300, y: 10, expected: [0, 0, 0, 0] }],
      },
      {
        width: 300, height: 270, tileSize: 256, nbrTilesX: 2, nbrTilesY: 2,
        tiles: [
          { x: 0, y: 0, color: "ff0000" }, { x: 1, y: 0, width: 44, color: "00ff00" },
          { x: 0, y: 1, height: 14, color: "0000ff" }, { x: 1, y: 1, width: 44, height: 14, color: "ffff00" },
        ],
        points: [
          { x: 299, y: 255, expected: [0, 255, 0, 255] }, { x: 255, y: 269, expected: [0, 0, 255, 255] },
          { x: 299, y: 269, expected: [255, 255, 0, 255] },
        ],
      },
    ];
    for (const item of cases) {
      const pixels = await renderAssembly(page, item);
      expect(pixels, item).toEqual(item.points.map((point) => point.expected));
    }
  });
});
