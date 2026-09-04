// Source-oracle parity: untouched legacy web source against the new fixture
// server. Each test writes testdata/scenarios/<id>/expected/legacy-web.json
// (canonical transcript) and asserts the scenario's key expectations.
const { test, expect } = require("@playwright/test");
const d = require("./driver");

let ADDR = "";
let LOG = "";

test.beforeAll(() => {
  ({ addr: ADDR, logFile: LOG } = d.loadAddr());
});

test.beforeEach(async ({ page }) => d.openApp(page, ADDR));

function logStart() {
  return d.readLog(LOG).length;
}

function transcript(id, cases, start) {
  const entries = d.readLog(LOG).slice(start);
  const metadata = [];
  const tiles = [];
  for (const e of entries) {
    const line = `${e.method || "GET"} ${e.url}`;
    if (e.via === "proxy") metadata.push(line);
    else tiles.push(line);
  }
  tiles.sort();
  const clean = ( result ) => JSON.parse(JSON.stringify(result, (k, v) => (typeof v === "string" ? v : v)));
  // Deterministic tile pick: concurrent loads race insertion order, so sort
  // by (x, y, url) before taking first/last instead of arrival order.
  const ordered = (resultTiles) => [...resultTiles].sort((a, b) =>
    (a.x - b.x) || (a.y - b.y) || String(a.url).localeCompare(String(b.url)));
  return {
    scenario: id,
    cases: cases.map((c) => ({
      label: c.label,
      input: c.input,
      mode: c.mode,
      format: c.result ? c.result.dezoomerName : null,
      width: c.result?.data?.width ?? null,
      height: c.result?.data?.height ?? null,
      tileCount: c.result ? c.result.tiles.length : 0,
      lastTile: c.result && c.result.tiles.length ? ordered(c.result.tiles).at(-1).url : null,
      data: c.result ? clean(c.result.data) : null,
      error: c.error ?? null,
    })),
    metadata_requests: metadata,
    tile_requests: tiles,
  };
}

async function runCase(page, mode, url) {
  try {
    const result = await d.runDezoomer(page, ADDR, mode, url);
    return { label: "", input: url, mode, result, error: null };
  } catch (e) {
    const clean = String(e.message || e)
      .replace(/^page\.evaluate: Error: (Uncaught Error: )?/, "")
      .split("\n")[0];
    return { label: "", input: url, mode, result: null, error: clean };
  }
}

const c = (label, url, expected, tile, mode = d.AUTO, data, tileIndex = -1) => ({
  label, url, expected, tile, mode, data, tileIndex,
});

test("web/core-discovery", async ({ page }) => {
  const start = logStart();
  const cases = [
    c("generic", "/fixtures/generic/tile.jpg?x={{X}}&y={{Y}}", "Generic dezoomer", "/fixtures/generic/tile.jpg?x=1&y=1"),
    c("zoomify", d.fixture("zoomify/ImageProperties.xml"), "Zoomify", d.fixture("zoomify/TileGroup0/1-1-1.jpg")),
    c("zoomify base", d.fixture("zoomify-base-href/product.html"), "Zoomify", d.fixture("zoomify-base-href/assets/maps/sample/TileGroup0/1-1-1.jpg")),
    c("DZI", d.fixture("deepzoom/sample.dzi"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/sample_files/9/1_1.jpg")),
    c("PNG DZI tile", d.fixture("deepzoom/png_files/9/1_1.png"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/png_files/9/1_1.png")),
    c("JPEG DZI tile", d.fixture("deepzoom/jpeg_files/9/1_1.jpeg"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/jpeg_files/9/1_1.jpeg")),
    c("legacy Seadragon", d.fixture("deepzoom/legacy-embed.html"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/legacy_files/9/1_1.jpg")),
    c("IIIF 2", d.localFixture("iiif-v2/info.json"), "IIIF", "/iiif/v2/256,256,256,256/256,256/0/native.png"),
    c("Mirador", `${d.fixture("mirador?manifest=")}${d.fixture("iiif-presentation/manifest.json")}`, "IIIF", "/iiif/mirador/256,256,256,256/256,256/0/native.jpg"),
    c("Universal Viewer", `${d.fixture("uv/#?manifest=")}${encodeURIComponent(d.fixture("iiif-presentation/manifest.json"))}`, "IIIF", "/iiif/mirador/256,256,256,256/256,256/0/native.jpg"),
    c("Micrio element", d.fixture("micrio-custom-element"), "IIIF", "https://iiif.micr.io/KEimL/256,256,256,256/256,256/0/default.jpg"),
    c("IIPImage", d.fixture("iip?FIF=/image.tif"), "IIPImage", "?FIF=/image.tif&JTL=1,3"),
    c("krpano", d.fixture("krpano/pano.xml"), "krpano", d.fixture("krpano/tiles/l1/2_2.jpg")),
    c("XLimage", d.fixture("xl/sample.imgi?cmd=info"), "XLimage", "?cmd=tile&x=1&y=1&z=1"),
    c("TopViewer JSON", d.fixture("topviewer/data.json"), "TopViewer", "/topviewer/sample-file/13.jpg"),
    c("TopViewer thumbnail", d.fixture("topviewer/page?FIF=not-iip"), "TopViewer", "/topviewer/sample-file/13.jpg"),
    c("FSI", d.fixture("fsi/server?type=info&source=image&image=image"), "FSI", "?type=image&source=image"),
    c("LizardTech", d.fixture("lizardtech/iserv/calcrgn?cat=North%20America%20and%20United%20States&item=NorthAmerica/US1566a.sid&wid=500&hei=400&props=item(Name,Description),cat(Name,Description)&style=default/view.xsl&plugin=true"), "LizardTech ImageServer", "getimage?cat=North%20America%20and%20United%20States&item=NorthAmerica%2FUS1566a.sid&wid=512&hei=512&oif=jpeg&lev=0&cp=0.75,0.75"),
    c("VLS", d.fixture("vls/zoom/1"), "VLS", "/image/tiler/square/fixture/0/0/0"),
    c("Hungaricana", d.fixture("hungaricana/imagesize/sample.ecw"), "Hungaricana", "image/sample.ecw/"),
    c("WMTS", d.fixture("wmts/WMTSCapabilities.xml"), "WMTS", "/wmts/EPSG3857/0/10/10.jpg"),
    c("ArcGIS", d.fixture("arcgis/MapServer"), "ArcGIS MapServer", "/arcgis/MapServer/tile/7/3/4"),
    c("pnav", d.fixture("entity/OBJECT/1"), "pnav", "/fixtures/pnav/image.jpg?w=2000&h=2000&cl=0&ct=0&cw=512&ch=512"),
  ];
  const out = [];
  for (const kase of cases) {
    const r = await runCase(page, kase.mode, kase.url);
    r.label = kase.label;
    out.push(r);
    expect(r.error, kase.label).toBeNull();
    if (kase.mode === d.AUTO) expect(r.result.dezoomerName, kase.label).toBe(kase.expected);
    expect(r.result.data.width, kase.label).toBeGreaterThan(0);
    expect(r.result.data.height, kase.label).toBeGreaterThan(0);
    expect(r.result.tiles.length, kase.label).toBeGreaterThan(0);
    if (kase.tile) {
      const u = kase.tileIndex < 0 ? r.result.tiles.at(-1).url : r.result.tiles[kase.tileIndex].url;
      expect(u, kase.label).toContain(kase.tile);
    }
  }
  d.writeTranscript("web/core-discovery", transcript("web/core-discovery", out, start));
});

test("web/zoomify-pages", async ({ page }) => {
  const start = logStart();
  const cases = [
    c("Flash zoomifyImagePath", d.fixture("zoomify/flash.html"), "Zoomify", d.fixture("zoomify/TileGroup0/1-1-1.jpg")),
    c("Fluid Engage accessnumber", d.fixture("zoomify/fluid.html"), "Zoomify", d.fixture("zoomify/TileGroup0/1-1-1.jpg")),
    c("OpenLayers source element", d.fixture("zoomify/openlayers.html"), "Zoomify", d.fixture("zoomify/TileGroup0/1-1-1.jpg")),
    c("OpenLayers tile source", d.fixture("zoomify/tile-source.html"), "Zoomify", d.fixture("zoomify/TileGroup0/1-1-1.jpg")),
    c("URL element", d.fixture("zoomify/url-element.html"), "Zoomify", d.fixture("zoomify/TileGroup0/1-1-1.jpg"), "Zoomify"),
    c("University of Bern", "https://biblio.unibe.ch/web-apps/maps/zoomify.php?col=ryh&pic=Ryh_7906_6", "Zoomify", "https://biblio.unibe.ch/zoomify/TileGroup0/1-1-1.jpg"),
    c("Paris Zoomify", "https://bspe-p-pub.paris.fr/MDBGED/zoomify-BFS.aspx?edid=23143&edfindex=0", "Zoomify", "https://bspe-p-pub.paris.fr/zoomify/TileGroup0/1-1-1.jpg"),
    c("National Gallery of Victoria", "https://www.ngv.vic.gov.au/explore/collection/work/3867/", "Zoomify", "https://www.ngv.vic.gov.au/zoomify/TileGroup0/1-1-1.jpg"),
    c("Art and Architecture", "https://www.artandarchitecture.org.uk/images/zoom/c462969579cd09dd4ccb690d0e43018757fa2df2.html", "Zoomify", "https://www.artandarchitecture.org.uk/zoomify/TileGroup0/1-1-1.jpg"),
    c("Zoomify iframe", d.fixture("zoomify/iframe-parent.html"), "Zoomify", d.fixture("zoomify/TileGroup0/1-1-1.jpg")),
    c("Zoomify tile URL", d.fixture("zoomify/TileGroup0/1-1-1.jpg"), "Zoomify", d.fixture("zoomify/TileGroup0/1-1-1.jpg")),
  ];
  const out = [];
  for (const kase of cases) {
    const r = await runCase(page, kase.mode, kase.url);
    r.label = kase.label;
    out.push(r);
    expect(r.error, kase.label).toBeNull();
    if (kase.mode === d.AUTO) expect(r.result.dezoomerName, kase.label).toBe(kase.expected);
    const u = r.result.tiles.at(-1).url;
    expect(u, kase.label).toContain(kase.tile);
  }
  const multi = await runCase(page, "Zoomify", d.fixture("zoomify/multiple-groups/ImageProperties.xml"));
  expect(multi.error).toBeNull();
  expect(multi.result.data.numTiles).toBe(341);
  expect(multi.result.tiles.length).toBe(256);
  multi.label = "multi-group rollover";
  out.push(multi);
  const full = await runCase(page, d.AUTO, d.fixture("zoomify-full-numtiles/ImageProperties.xml"));
  expect(full.error).toBeNull();
  expect(full.result.data.numTiles).toBe(280);
  full.label = "full-numtiles single group";
  out.push(full);
  d.writeTranscript("web/zoomify-pages", transcript("web/zoomify-pages", out, start));
});

test("web/seadragon-pages", async ({ page }) => {
  const start = logStart();
  const cases = [
    c("British Library Viewer", "https://www.bl.uk/manuscripts/Viewer.aspx?ref=burney_ms_276_f031ar", "Seadragon (Deep Zoom Image)", "https://www.bl.uk/manuscripts/Proxy.ashx?view=burney_ms_276_f031ar_files/9/1_1.jpg"),
    c("Prado data-pyr", "https://www.museodelprado.es/en/the-collection/art-work/las-meninas/9fdc7800-9ade-48b0-ab8b-edee94ea877f?searchid=0a27f161-5629-8f4a-2756-ff085078076e", "Seadragon (Deep Zoom Image)", "/12/0_0.jpg", d.AUTO, { width: 2362, height: 2697, tileSize: 256, overlap: 1, maxZoomLevel: 12 }, 0),
    c("Polona JSON", "https://polona.pl/item/9388882/0/", "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/sample_files/9/1_1.jpg")),
    c("National Library of Australia", "https://nla.gov.au/nla.obj-152642460/view", "Seadragon (Deep Zoom Image)", "https://nla.gov.au/nla.obj-152642460/dzi?tile=13/20_25.jpg"),
    c("Paris DZI rewrite", "https://bibliotheques-specialisees.paris.fr/ark:/73873/pf0001115743/0017/v0001.simple.selectedTab=otherdocs", "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/sample_files/9/1_1.jpg")),
    c("World Digital Library", d.fixture("view/12/34"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/wdl-12-34_files/9/1_1.jpg")),
    c("XML link", d.fixture("deepzoom/xml-link.html"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/legacy_files/9/1_1.jpg"), "Seadragon (Deep Zoom Image)"),
    c("DZI link", d.fixture("deepzoom/dzi-link.html"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/sample_files/9/1_1.jpg")),
    c("DZI attribute", d.fixture("deepzoom/dzi-query.html"), "Seadragon (Deep Zoom Image)", "deepzoom/legacy?format=xml_files/9/1_1.jpg"),
    c("zoom.it", d.fixture("deepzoom/zoomit.html"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/sample_files/9/1_1.jpg")),
    c("zoomhub", d.fixture("deepzoom/zoomhub.html"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/sample_files/9/1_1.jpg")),
    c("DZI iframe", d.fixture("deepzoom/iframe-parent.html"), "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/sample_files/9/1_1.jpg")),
  ];
  const out = [];
  for (const kase of cases) {
    const r = await runCase(page, kase.mode, kase.url);
    r.label = kase.label;
    out.push(r);
    expect(r.error, kase.label).toBeNull();
    if (kase.mode === d.AUTO) expect(r.result.dezoomerName, kase.label).toBe(kase.expected);
    const u = (kase.tileIndex < 0 ? r.result.tiles.at(-1) : r.result.tiles[kase.tileIndex]).url;
    expect(u, kase.label).toContain(kase.tile);
    for (const [k, v] of Object.entries(kase.data || {})) expect(r.result.data[k], `${kase.label}: ${k}`).toEqual(v);
  }
  d.writeTranscript("web/seadragon-pages", transcript("web/seadragon-pages", out, start));
});

test("web/iiif-discovery", async ({ page }) => {
  const start = logStart();
  const cases = [
    c("IIIF 3", d.fixture("iiif-v3/info.json"), "IIIF", "/iiif/v3/256,256,256,256/256,256/0/default.jpg", d.AUTO, { origin: `${ADDR}/iiif/v3`, quality: "default", format: "jpg" }),
    c("ONB viewer", "https://viewer.onb.ac.at/10048A37/", "IIIF", "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg", d.AUTO, { origin: `${ADDR}/iiif/onb/10048A37/uk4nGb4kQHe3msbC` }),
    c("ONB viewer page", "https://viewer.onb.ac.at/10048A37/137", "IIIF", "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg", d.AUTO, { origin: `${ADDR}/iiif/onb/10048A37/uk4nGb4kQHe3msbC` }),
    c("ONB manifest", "https://api.onb.ac.at/iiif/presentation/v3/manifest/10048A37", "IIIF", "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg", d.AUTO, { origin: `${ADDR}/iiif/onb/10048A37/uk4nGb4kQHe3msbC` }),
    c("ONB RepViewer", "https://digital.onb.ac.at/RepViewer/viewer.faces?doc=DTL_7039594&order=1&view=SINGLE", "IIIF", "/iiif/onb/10048A37/uk4nGb4kQHe3msbC/256,256,256,256/256,256/0/default.jpg", d.AUTO, { origin: `${ADDR}/iiif/onb/10048A37/uk4nGb4kQHe3msbC` }),
    c("private IIIF id", "/fixtures/iiif-private-id/info.json", "IIIF", "/fixtures/iiif-private-id/256,256,256,256/256,256/0/native.png"),
    c("IIIF default port", "/fixtures/iiif-default-port/info.json", "IIIF", `${ADDR}/iiif/default-port/256,256,256,256/256,256/0/native.jpg`, d.AUTO, { origin: `${ADDR}/iiif/default-port` }),
    c("CONTENTdm", d.fixture("digital/collection/OKMaps/id/6483/rec/6"), "IIIF", "/digital/iiif/OKMaps/6483/256,256,256,256/256,256/0/native.jpg", d.AUTO, { origin: `${ADDR}/digital/iiif/OKMaps/6483` }),
    c("National Gallery page", d.fixture("national-gallery"), "IIIF", "/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif/256,256,256,256/256,256/0/default.jpg", d.AUTO, { origin: `${ADDR}/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif` }),
    c("London Museum page", d.fixture("londonmuseum-object"), "IIIF", "/iiif/londonmuseum/object-95380.ptif/256,256,256,256/256,256/0/default.jpg", d.AUTO, { origin: `${ADDR}/iiif/londonmuseum/object-95380.ptif` }),
    c("Philadelphia escaped", d.fixture("philamuseum-escaped-shortid"), "IIIF", "/iiif/micrio/QYRjM/256,256,256,256/256,256/0/default.png", d.AUTO, { origin: `${ADDR}/iiif/micrio/QYRjM` }),
    c("Philadelphia raw", d.fixture("philamuseum-raw-shortid"), "IIIF", "/iiif/micrio/Raw01/256,256,256,256/256,256/0/default.png", d.AUTO, { origin: `${ADDR}/iiif/micrio/Raw01` }),
  ];
  const out = [];
  for (const kase of cases) {
    const r = await runCase(page, kase.mode, kase.url);
    r.label = kase.label;
    out.push(r);
    expect(r.error, kase.label).toBeNull();
    if (kase.mode === d.AUTO) expect(r.result.dezoomerName, kase.label).toBe(kase.expected);
    expect(r.result.tiles.at(-1).url, kase.label).toContain(kase.tile);
    for (const [k, v] of Object.entries(kase.data || {})) expect(r.result.data[k], `${kase.label}: ${k}`).toEqual(v);
  }
  const gallica = await runCase(page, "IIIF", "https://gallica.bnf.fr/ark:/12148/btv1b10500000/f1");
  expect(gallica.error).toBeNull();
  expect(gallica.result.tiles.at(-1).url).toContain("/iiif/v2/256,256,256,256/256,256/0/native.png");
  gallica.label = "Gallica";
  out.push(gallica);
  const vangogh = await runCase(page, d.AUTO, d.fixture("iiif/van-gogh.html"));
  expect(vangogh.error).toBeNull();
  expect(vangogh.result.dezoomerName).toBe("IIIF");
  vangogh.label = "Van Gogh";
  out.push(vangogh);
  const malformed = await runCase(page, "IIIF", d.fixture("iiif-malformed-tile/info.json"));
  expect(malformed.error).toBeNull();
  malformed.label = "malformed tile fallback";
  out.push(malformed);
  const overlap = await runCase(page, "Seadragon (Deep Zoom Image)", d.fixture("deepzoom/overlap.dzi"));
  expect(overlap.error).toBeNull();
  expect(overlap.result.data.overlap).toBe(1);
  overlap.label = "overlap offsets";
  out.push(overlap);
  const plain = await runCase(page, d.AUTO, `${d.fixture("mirador?manifest=")}${d.fixture("iiif-presentation/plain-image-manifest.json")}`);
  expect(plain.error).toContain("No IIIF Image API service found in manifest.");
  plain.label = "plain-image manifest failure";
  out.push(plain);
  d.writeTranscript("web/iiif-discovery", transcript("web/iiif-discovery", out, start));
});

test("web/topviewer", async ({ page }) => {
  const start = logStart();
  const out = [];
  for (const kase of [
    c("Beeldbank Groningen", "https://www.beeldbankgroningen.nl/beelden/detail/53479cae-899f-0ac1-8913-40276a93a4f7/media/1c7914ee-3f37-0d37-3218-48eba1c3a97f?mode=detail&view=horizontal&rows=1&page=4&fq%5B%5D=search_s_download:%22Nee%22&sort=random%7B1785398988616%7D%20asc", "TopViewer", "/topviewer/sample-file/13.jpg"),
    c("Historisch Archief Midden-Groningen", "https://historischarchief.midden-groningen.nl/collectie/beelden/beelden-view/?mode=gallery&view=horizontal&sort=random%7B1785398881908%7D%20asc", "TopViewer", "/topviewer/sample-file/13.jpg"),
    c("embedded server", d.fixture("topviewer/server.html"), "TopViewer", "/topviewer/sample-file/13.jpg", "TopViewer"),
  ]) {
    const r = await runCase(page, kase.mode, kase.url);
    r.label = kase.label;
    out.push(r);
    expect(r.error, kase.label).toBeNull();
    if (kase.mode === d.AUTO) expect(r.result.dezoomerName, kase.label).toBe(kase.expected);
    expect(r.result.tiles.at(-1).url, kase.label).toContain(kase.tile);
  }
  for (const [url, expected] of [
    [d.fixture("topviewer/gahetna.html"), "https://images.memorix.nl/naa/topviewjson/memorix/gahetna-sample"],
    [d.fixture("topviewer/rkd.html"), "https://images.rkd.nl/rkd/topviewjson/memorix/rkd-sample"],
  ]) {
    const found = await d.findFile(page, ADDR, "TopViewer", url);
    expect(found, url).toBe(expected);
    out.push({ label: `findFile ${url}`, input: url, mode: "findFile", result: null, error: null, found });
  }
  const record = "11111111-1111-1111-1111-111111111111";
  const media = "22222222-2222-2222-2222-222222222222";
  for (const [base, imageServer, recordId] of [
    ["https://www.beeldbankgroningen.nl/beelden", "gra", record],
    ["https://salha.nl/bronnen/fotos-en-films/foto-s", "sha", record],
    ["https://archief.zaanstad.nl/mediabank/zoek-in-de-beeldbank", "zaa", record],
    ["https://erfgoedcentrumzutphen.nl/onderzoeken/beeldbank", "szu", record],
    ["https://noord-hollandsarchief.nl/beelden/beeldbank", "ranh", "11111111111111111111111111111111"],
  ]) {
    const url = `${base}/detail/${recordId}/media/${media}`;
    expect(await d.selectDezoomer(page, ADDR, url), url).toBe("TopViewer");
    expect(await d.findFile(page, ADDR, "TopViewer", url), url).toBe(`https://images.memorix.nl/${imageServer}/topviewjson/memorix/${media}`);
    out.push({ label: `memorix site ${base}`, input: url, mode: "findFile", result: null, error: null });
  }
  d.writeTranscript("web/topviewer", transcript("web/topviewer", out, start));
});

test("web/site-adapters", async ({ page }) => {
  const start = logStart();
  const out = [];
  const arcgis = await runCase(page, d.AUTO, d.fixture("arcgis/MapServer?token=fixture&f=html"));
  expect(arcgis.error).toBeNull();
  expect(arcgis.result.dezoomerName).toBe("ArcGIS MapServer");
  expect({ width: arcgis.result.data.width, height: arcgis.result.data.height, minColumn: arcgis.result.data.minColumn, minRow: arcgis.result.data.minRow }).toEqual({ width: 768, height: 768, minColumn: 2, minRow: 1 });
  arcgis.label = "ArcGIS token";
  out.push(arcgis);
  const uncached = await runCase(page, "ArcGIS MapServer", d.fixture("arcgis/uncached/MapServer"));
  expect(uncached.error).toContain("does not provide a fused tile cache");
  uncached.label = "ArcGIS uncached failure";
  out.push(uncached);
  expect(await d.selectDezoomer(page, ADDR, "https://server.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml")).toBe("WMTS");
  out.push({ label: "WMTS precedence", input: "arcgisonline WMTS", mode: "select", result: null, error: null });
  for (const [url, expectedBytes, pathStart] of [
    ["https://artsandculture.google.com/asset/fixture", "HEADABCDEFGHIJKLMNOPTAIL", "/arts/path=x0-y0-z0-t"],
    ["https://g.co/arts/fixture", "HEADABCDEFGHIJKLMNOPTAIL", "/arts/path=x0-y0-z0-t"],
    ["https://artsandculture.google.com/asset/plain", "plain-tile", "/arts/plain=x0-y0-z0-t"],
  ]) {
    const r = await runCase(page, d.AUTO, url);
    expect(r.error, url).toBeNull();
    expect(r.result.dezoomerName, url).toBe("Arts & Culture");
    const bytes = await page.evaluate(async (blobUrl) => Array.from(new Uint8Array(await fetch(blobUrl).then((res) => res.arrayBuffer()))), r.result.tiles[0].url);
    expect(bytes, url).toEqual(Array.from(Buffer.from(expectedBytes)));
    r.label = `arts ${url}`;
    out.push(r);
  }
  const promptResult = await page.evaluate(() => new Promise((resolve) => {
    const originalPrompt = window.prompt;
    window.prompt = () => "3";
    window.ZoomManager.dezoomersList.XLimage.findFile("https://kbr.be/multi/abcViewer/index.html", (file) => { window.prompt = originalPrompt; resolve(file); });
  }));
  expect(promptResult).toBe("/multi/abcViewer/xml.php?/multi/abc/004.imgi?cmd=info");
  out.push({ label: "XLimage prompt", input: "kbr.be page-number", mode: "findFile", result: null, error: null });
  for (const [url, file] of [
    [d.fixture("hungaricana/imagepath.html"), "imagepath.ecw"],
    [d.fixture("hungaricana/inline-files.html?img=1"), "second.ecw"],
    [d.fixture("hungaricana/inline-images.html?pg=1"), "second.ecw"],
    [d.fixture("hungaricana/files-url.html?img=1"), "second.ecw"],
  ]) {
    // findFile needs proxy context; reuse driver with cookies cleared.
    const found = await d.findFile(page, ADDR, "Hungaricana", url);
    expect(found, url).toBe(`https://fixtures.test/hungaricana/image/page/${file}`);
    out.push({ label: `hungaricana ${url}`, input: url, mode: "findFile", result: null, error: null, found });
  }
  d.writeTranscript("web/site-adapters", transcript("web/site-adapters", out, start));
});

test("web/generic-probing", async ({ page }) => {
  const start = logStart();
  const out = [];
  for (const [name, dims] of [
    ["padded", [512, 512, 256]], ["large", [1024, 512, 512]], ["edge", [512, 512, 256]],
    ["boundary", [256000, 256, 256]], ["one", [768, 256, 256]],
    ["missing-origin", [512, 512, 256]], ["placeholder", [512, 512, 256]],
  ]) {
    const data = await d.probeGeneric(page, ADDR, `${ADDR}/fixtures/generic/${name}.svg?x={{X}}&y={{Y}}`);
    expect([data.width, data.height, data.tileSize], name).toEqual(dims);
    out.push({ label: `probe ${name}`, input: name, mode: "probe", result: null, error: null, dims });
  }
  d.writeTranscript("web/generic-probing", transcript("web/generic-probing", out, start));
});

test("web/auto-precedence", async ({ page }) => {
  const start = logStart();
  const name = await d.selectDezoomer(page, ADDR, d.fixture("automatic/precedence.html"));
  expect(name).toBe("Zoomify");
  d.writeTranscript("web/auto-precedence", {
    scenario: "web/auto-precedence",
    cases: [{ label: "precedence", input: d.fixture("automatic/precedence.html"), mode: "automatic", format: name, width: null, height: null, tileCount: 0, lastTile: null, data: null, error: null }],
    metadata_requests: d.readLog(LOG).slice(start).map((e) => `${e.method || "GET"} ${e.url}`),
    tile_requests: [],
  });
});

test("web/auto-cycle", async ({ page }) => {
  const start = logStart();
  const out = [];
  for (const url of [d.fixture("automatic/repeated-parent.html"), d.fixture("automatic/cycle-a.html")]) {
    const r = await runCase(page, d.AUTO, url);
    expect(r.error, url).toContain("Unable to find a proper dezoomer");
    r.label = `reject ${url}`;
    out.push(r);
  }
  const targets = d.readLog(LOG).slice(start).filter((e) => e.via === "proxy").map((e) => e.url);
  expect(targets.filter((u) => u.endsWith("/automatic/child.html"))).toHaveLength(1);
  expect(targets.filter((u) => u.endsWith("/automatic/cycle-a.html"))).toHaveLength(1);
  expect(targets.filter((u) => u.endsWith("/automatic/cycle-b.html"))).toHaveLength(1);
  d.writeTranscript("web/auto-cycle", transcript("web/auto-cycle", out, start));
});

test("web/query-params", async ({ page }) => {
  const start = logStart();
  const targets = [];
  const listener = (req) => targets.push(req.url());
  page.on("request", listener);
  const iip = await d.runDezoomer(page, ADDR, "IIPImage", d.fixture("iip?FIF=/image.tif"));
  const iipInfo = new URL(targets.map((u) => new URL(u)).filter((u) => u.pathname === "/proxy" && u.searchParams.has("url")).map((u) => u.searchParams.get("url")).find((t) => new URL(t).pathname === "/iip"));
  expect(iipInfo.searchParams.getAll("OBJ")).toEqual(["Max-size", "Tile-size", "Resolution-number"]);
  const mem = await d.runDezoomer(page, ADDR, d.AUTO, "https://historischarchief.midden-groningen.nl/collectie/beelden/beelden-view/?mode=gallery&view=horizontal&sort=random%7B1785398881908%7D%20asc");
  expect(mem.dezoomerName).toBe("TopViewer");
  page.off("request", listener);
  d.writeTranscript("web/query-params", transcript("web/query-params", [
    { label: "iip OBJ params", input: "iip", mode: "explicit", result: iip, error: null },
    { label: "memorix query", input: "hamg", mode: "automatic", result: mem, error: null },
  ], start));
});

test("web/assembly", async ({ page }) => {
  const start = logStart();
  const layouts = [
    { width: 512, height: 512, tileSize: 256, nbrTilesX: 2, nbrTilesY: 2,
      tiles: [{ x: 0, y: 0, color: "ff0000" }, { x: 1, y: 0, color: "00ff00" }, { x: 0, y: 1, color: "0000ff" }, { x: 1, y: 1, color: "ffff00" }],
      points: [{ x: 10, y: 10, expected: [255, 0, 0, 255] }, { x: 300, y: 10, expected: [0, 255, 0, 255] }, { x: 10, y: 300, expected: [0, 0, 255, 255] }, { x: 300, y: 300, expected: [255, 255, 0, 255] }] },
    { width: 511, height: 511, tileSize: 256, nbrTilesX: 2, nbrTilesY: 2, overlap: 1,
      tiles: [{ x: 0, y: 0, color: "ff0000" }, { x: 1, y: 0, color: "00ff00" }, { x: 0, y: 1, color: "0000ff" }, { x: 1, y: 1, color: "ffff00" }],
      points: [{ x: 254, y: 10, expected: [255, 0, 0, 255] }, { x: 255, y: 10, expected: [0, 255, 0, 255] }, { x: 254, y: 254, expected: [255, 0, 0, 255] }, { x: 255, y: 255, expected: [255, 255, 0, 255] }] },
    { width: 512, height: 256, tileSize: 256, nbrTilesX: 2, nbrTilesY: 1,
      tiles: [{ x: 0, y: 0, color: "ff0000" }],
      points: [{ x: 10, y: 10, expected: [255, 0, 0, 255] }, { x: 300, y: 10, expected: [0, 0, 0, 0] }] },
    { width: 300, height: 270, tileSize: 256, nbrTilesX: 2, nbrTilesY: 2,
      tiles: [{ x: 0, y: 0, color: "ff0000" }, { x: 1, y: 0, width: 44, color: "00ff00" }, { x: 0, y: 1, height: 14, color: "0000ff" }, { x: 1, y: 1, width: 44, height: 14, color: "ffff00" }],
      points: [{ x: 299, y: 255, expected: [0, 255, 0, 255] }, { x: 255, y: 269, expected: [0, 0, 255, 255] }, { x: 299, y: 269, expected: [255, 255, 0, 255] }] },
  ];
  const pixels = [];
  for (const [i, layout] of layouts.entries()) {
    const got = await d.renderAssembly(page, ADDR, layout);
    expect(got, `layout ${i}`).toEqual(layout.points.map((p) => p.expected));
    pixels.push({ layout: i, points: layout.points.map((p, j) => ({ x: p.x, y: p.y, rgba: got[j] })) });
  }
  d.writeTranscript("web/assembly", {
    scenario: "web/assembly",
    cases: pixels,
    metadata_requests: [],
    tile_requests: d.readLog(LOG).slice(start).filter((e) => e.via === "fetch").map((e) => `${e.method || "GET"} ${e.url}`).sort(),
  });
});

test("web/proxy", async ({ page }) => {
  const start = logStart();
  const get = await page.request.get(`${ADDR}/proxy?url=data:text/plain,hello`);
  expect(get.status()).toBe(200);
  expect(get.headers()["access-control-allow-origin"]).toBe("*");
  expect(await get.text()).toBe("hello");
  const head = await page.request.head(`${ADDR}/proxy?url=data:text/plain,hello`);
  expect(head.status()).toBe(200);
  expect(await head.text()).toBe("");
  d.writeTranscript("web/proxy", {
    scenario: "web/proxy",
    cases: [{ label: "GET data target", input: "data:text/plain,hello", mode: "proxy", format: null, width: null, height: null, tileCount: 0, lastTile: null, data: null, error: null }],
    metadata_requests: d.readLog(LOG).slice(start).map((e) => `${e.method || "GET"} ${e.url}`),
    tile_requests: [],
  });
});
