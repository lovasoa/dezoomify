const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 9877);
const host = "127.0.0.1";

const jpg = fs.readFileSync(
  path.join(root, "tests/images/issue_81/image/TileGroup0/3-1-6.jpg")
);

const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "application/javascript",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
};

function response(status, contentType, body) {
  return {
    status,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "X-Set-Cookie",
      "Content-Type": contentType,
    },
    body,
  };
}

function xml(body) {
  return response(200, "application/xml", body);
}

function json(body) {
  return response(200, "application/json", JSON.stringify(body));
}

function text(body) {
  return response(200, "text/plain", body);
}

function html(body) {
  return response(200, "text/html", body);
}

function fixtureFor(target, origin) {
  const url = new URL(target);
  const href = url.href;

  if (href === "https://fixtures.test/zoomify/ImageProperties.xml") {
    return xml(
      '<IMAGE_PROPERTIES WIDTH="512" HEIGHT="512" NUMTILES="5" VERSION="1.8" TILESIZE="256" />'
    );
  }

  if (href === "https://fixtures.test/zoomify-full-numtiles/ImageProperties.xml") {
    return xml(
      '<IMAGE_PROPERTIES WIDTH="10240" HEIGHT="1792" NUMTILES="280" VERSION="1.8" TILESIZE="256" />'
    );
  }

  if (href === "https://fixtures.test/deepzoom/sample.dzi") {
    return xml(
      '<Image TileSize="256" Overlap="0" Format="jpg" xmlns="http://schemas.microsoft.com/deepzoom/2008"><Size Width="512" Height="512" /></Image>'
    );
  }

  if (href === "https://fixtures.test/iiif-v2/info.json") {
    return json({
      "@context": "http://iiif.io/api/image/2/context.json",
      "@id": `${origin}/iiif/v2`,
      width: 512,
      height: 512,
      tiles: [{ width: 256, height: 256, scaleFactors: [1, 2] }],
      qualities: ["native"],
      formats: ["png"],
    });
  }

  if (href === "https://fixtures.test/iiif-v3/info.json") {
    return json({
      "@context": "http://iiif.io/api/image/3/context.json",
      id: `${origin}/iiif/v3`,
      type: "ImageService3",
      width: 512,
      height: 512,
      tiles: [{ width: 256, height: 256, scaleFactors: [1, 2] }],
      extraQualities: ["default", "gray"],
      extraFormats: ["jpg", "webp"],
    });
  }

  if (href === "https://fixtures.test/national-gallery") {
    return html(`
      <img src="/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif/full/!80,50/0/default.jpg">
    `);
  }

  if (
    href ===
    "https://fixtures.test/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif/info.json"
  ) {
    return json({
      "@context": "http://iiif.io/api/image/3/context.json",
      id: `${origin}/server.iip?IIIF=/fronts/N-6660-00-000003-FS-PYR.tif`,
      type: "ImageService3",
      width: 512,
      height: 512,
      tiles: [{ width: 256, height: 256, scaleFactors: [1, 2] }],
      profile: "level2",
    });
  }

  if (href.startsWith("https://fixtures.test/iip?FIF=/image.tif&OBJ=")) {
    return text("Max-size:512 512\nTile-size:256 256\nResolution-number:2\n");
  }

  if (href === "https://fixtures.test/krpano/pano.xml") {
    return xml(`
      <krpano>
        <image tilesize="256">
          <level tiledimagewidth="512" tiledimageheight="512">
            <front url="tiles/l%l/%v_%h.jpg" />
          </level>
        </image>
      </krpano>
    `);
  }

  if (url.hostname === "fixtures.test" && url.pathname === "/pff") {
    var requestType = url.searchParams.get("requestType");
    if (requestType === "1") {
      return text(
        'width="512"\nheight="512"\ntileSize="256"\nnumTiles="4"\nversion="1"\nheaderSize="0"\n'
      );
    }
    if (requestType === "2") {
      return text("reply_data=0,     1200     1300     1400     1500");
    }
  }

  if (href === "https://fixtures.test/xl/sample.imgi?cmd=info") {
    return xml("<image><width>512</width><height>512</height><tileside>256</tileside></image>");
  }

  if (href === "https://fixtures.test/topviewer/data.json") {
    return json({
      topviews: [
        {
          filepath: "sample-file",
          width: 512,
          height: 512,
          tileWidth: 256,
          layers: [{ no: 1, width: 512, starttile: 10, cols: 2 }],
        },
      ],
      config: {
        tileurl_v2: `${origin}/topviewer/{file}/{tile}.{extension}`,
      },
    });
  }

  if (href === "https://fixtures.test/topviewer/page?FIF=not-iip") {
    return html(`
      <img src="https://images.memorix.nl/demo/thumb/100x100/sample-file.jpg">
    `);
  }

  if (href === "http://images.memorix.nl/demo/topviewjson/memorix/sample-file") {
    return fixtureFor("https://fixtures.test/topviewer/data.json", origin);
  }

  if (
    href === "https://fixtures.test/fsi/server?type=info&source=image" ||
    href === "https://fixtures.test/fsi/server?type=info&source=image&image=image"
  ) {
    return text('<property width value="512" /><property height value="512" />');
  }

  if (href === "https://fixtures.test/vls/zoom/1") {
    return xml(`
      <root>
        <var id="zoomTileSize" value="512" />
        <map id="map" vls:ot_id="fixture" vls:width="512" vls:height="512" xmlns:vls="urn:vls" />
      </root>
    `);
  }

  if (href === "https://fixtures.test/micrio/api/getTilesInfo?object_id=1") {
    return json({
      levels: [
        {
          width: 512,
          height: 512,
          tiles: [{ x: 0, y: 0, url: `${origin}/fixtures/tile.jpg` }],
        },
      ],
    });
  }

  if (href === "https://fixtures.test/hungaricana/imagesize/sample.ecw") {
    return json({ width: 512, height: 512 });
  }

  if (href === "https://fixtures.test/mnesys/p.xml") {
    return xml('<root><layer z="0" w="512" h="512" t="256" /></root>');
  }

  if (href === "https://fixtures.test/wmts/WMTSCapabilities.xml") {
    return xml(`
      <Capabilities xmlns="http://www.opengis.net/wmts/1.0" xmlns:ows="http://www.opengis.net/ows/1.1">
        <Contents>
          <Layer>
            <ows:Identifier>fixture</ows:Identifier>
            <ows:BoundingBox crs="urn:ogc:def:crs:EPSG::3857">
              <ows:LowerCorner>0 0</ows:LowerCorner>
              <ows:UpperCorner>512 512</ows:UpperCorner>
            </ows:BoundingBox>
            <Style><ows:Identifier>default</ows:Identifier></Style>
            <ResourceURL format="image/jpeg" resourceType="tile" template="${origin}/wmts/{TileMatrixSet}/{TileMatrix}/{TileRow}/{TileCol}.jpg" />
          </Layer>
          <TileMatrixSet>
            <ows:Identifier>EPSG3857</ows:Identifier>
            <ows:SupportedCRS>urn:ogc:def:crs:EPSG::3857</ows:SupportedCRS>
            <TileMatrix>
              <ows:Identifier>0</ows:Identifier>
              <ScaleDenominator>714.2857142857143</ScaleDenominator>
              <TopLeftCorner>0 512</TopLeftCorner>
              <TileWidth>256</TileWidth>
              <TileHeight>256</TileHeight>
              <MatrixWidth>2</MatrixWidth>
              <MatrixHeight>2</MatrixHeight>
            </TileMatrix>
          </TileMatrixSet>
        </Contents>
      </Capabilities>
    `);
  }

  if (href === "https://fixtures.test/entity/OBJECT/1") {
    return html(
      `<meta property="og:image" content="${origin}/fixtures/pnav/image.jpg?w=1000&h=1000">`
    );
  }

  if (href === `${origin}/fixtures/pnav/image.json`) {
    return json({ width: 512, height: 512 });
  }

  return response(404, "text/plain", `No fixture for ${target}`);
}

function serveStatic(req, res, pathname) {
  const origin = `http://${host}:${port}`;
  if (pathname === "/fixtures/iiif-v2/info.json") {
    const fixture = fixtureFor("https://fixtures.test/iiif-v2/info.json", origin);
    res.writeHead(fixture.status, fixture.headers);
    res.end(fixture.body);
    return;
  }

  if (pathname === "/entity/OBJECT/1") {
    const fixture = fixtureFor("https://fixtures.test/entity/OBJECT/1", origin);
    res.writeHead(fixture.status, fixture.headers);
    res.end(fixture.body);
    return;
  }

  if (pathname === "/fixtures/pnav/image.json") {
    const fixture = fixtureFor(`${origin}/fixtures/pnav/image.json`, origin);
    res.writeHead(fixture.status, fixture.headers);
    res.end(fixture.body);
    return;
  }

  if (
    pathname === "/fixtures/tile.jpg" ||
    pathname === "/fixtures/pnav/image.jpg" ||
    pathname.startsWith("/iiif/") ||
    pathname === "/server.iip"
  ) {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(jpg);
    return;
  }

  if (pathname === "/fixtures/generic/tile.jpg") {
    const url = new URL(req.url, `http://${host}:${port}`);
    const x = Number(url.searchParams.get("x"));
    const y = Number(url.searchParams.get("y"));
    if (x >= 0 && x < 2 && y >= 0 && y < 2) {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(jpg);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing tile");
    }
    return;
  }

  const safePath = path.normalize(path.join(root, pathname));
  if (!safePath.startsWith(root)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("forbidden");
    return;
  }

  fs.readFile(safePath, (err, body) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(safePath)] || "application/octet-stream",
    });
    res.end(body);
  });
}

http
  .createServer((req, res) => {
    const origin = `http://${host}:${port}`;
    const url = new URL(req.url, origin);

    if (url.pathname === "/proxy") {
      const target = url.searchParams.get("url");
      if (!target) {
        res.writeHead(400, { "Content-Type": "text/plain" });
        res.end("missing url");
        return;
      }
      const fixture = fixtureFor(target, origin);
      res.writeHead(fixture.status, fixture.headers);
      res.end(fixture.body);
      return;
    }

    serveStatic(req, res, url.pathname === "/" ? "/index.html" : url.pathname);
  })
  .listen(port, host, () => {
    console.log(`fixture server listening at http://${host}:${port}`);
  });
