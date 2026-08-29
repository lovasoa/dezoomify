const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const stream = require("stream");
const urlModule = require("url");

const root = path.resolve(__dirname, "..");
const fixtureRoot = path.join(__dirname, "fixtures");
const remoteFixtureRoot = path.join(fixtureRoot, "remote");
const localFixtureRoot = path.join(fixtureRoot, "local");
const portArg = process.argv.find((arg) => arg.startsWith("--port="));
const port = Number(portArg ? portArg.slice("--port=".length) : process.env.PORT || 9877);
const host = "127.0.0.1";
const useFixtures = !process.argv.includes("--live");
const proxyModule = import(urlModule.pathToFileURL(path.join(root, "functions", "proxy.js")));

const jpg = fs.readFileSync(
  path.join(root, "tests/images/fixture.jpg")
);

const contentTypes = {
  ".css": "text/css",
  ".dzi": "application/xml",
  ".html": "text/html",
  ".js": "application/javascript",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".xml": "application/xml",
};

const textExtensions = new Set([".css", ".dzi", ".html", ".js", ".json", ".svg", ".txt", ".xml"]);

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

function artsCultureTile(target) {
  const match = target.pathname.match(/^\/arts\/(path|plain)=x(\d+)-y(\d+)-z(\d+)-t([^/]+)$/);
  if (!match) return null;

  const imagePath = `arts/${match[1]}`;
  const signPath = `${imagePath}=x${match[2]}-y${match[3]}-z${match[4]}-tsample-token`;
  const signature = crypto
    .createHmac("sha1", Buffer.from("7b2b4e23de2cc5c5", "hex"))
    .update(signPath)
    .digest("base64")
    .replace(/[+/]/g, "_")
    .replace("=", "");

  if (match[5] !== signature) {
    return response(403, "text/plain", "invalid signed path");
  }

  if (match[1] === "plain") {
    return response(200, "application/octet-stream", Buffer.from("plain-tile"));
  }

  const encoded = fs.readFileSync(
    path.join(remoteFixtureRoot, "fixtures.test", "arts", "encrypted-tile.b64"),
    "utf8"
  ).trim();
  return response(200, "application/octet-stream", Buffer.from(encoded, "base64"));
}

function renderTemplate(body, origin) {
  return body
    .replaceAll("{{origin}}", origin)
    .replaceAll("{{host}}", host);
}

function responseFromFile(filePath, origin) {
  const ext = path.extname(filePath);
  const contentType = contentTypes[ext] || "application/octet-stream";
  const body = textExtensions.has(ext)
    ? renderTemplate(fs.readFileSync(filePath, "utf8"), origin)
    : fs.readFileSync(filePath);
  return response(200, contentType, body);
}

function safeJoin(base, pathname) {
  const safePath = path.normalize(path.join(base, pathname));
  if (safePath !== base && !safePath.startsWith(`${base}${path.sep}`)) return null;
  return safePath;
}

function fixtureFile(hostname, pathname) {
  const basePath = safeJoin(path.join(remoteFixtureRoot, hostname), `.${pathname}`);
  if (!basePath) return null;
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) return basePath;

  for (const ext of [".html", ".json", ".xml", ".txt"]) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function fixturePathFor(url) {
  if (
    url.hostname === "gallica.bnf.fr" &&
    url.pathname === "/iiif/ark:/12148/btv1b10500000/f1/info.json"
  ) {
    return fixtureFile("fixtures.test", "/iiif-v2/info.json");
  }
  if (
    url.hostname === "micrio-cdn.vangoghmuseum.nl" &&
    url.pathname === "/s0424M1991/info.json"
  ) {
    return fixtureFile("fixtures.test", "/iiif-v3/info.json");
  }
  if (url.hostname === "www.bl.uk" && url.pathname === "/manuscripts/Proxy.ashx") {
    return fixtureFile("fixtures.test", "/deepzoom/sample.dzi");
  }
  if (url.hostname === "polona.pl" && url.pathname === "/resources/item/9388882/") {
    return fixtureFile("fixtures.test", "/deepzoom/polona.json");
  }
  if (
    url.hostname === "bibliotheques-specialisees.paris.fr" &&
    url.pathname === "/in/imageReader.xhtml"
  ) {
    return fixtureFile("fixtures.test", "/deepzoom/paris-reader.html");
  }
  if (
    [
      "artandarchitecture.org.uk",
      "www.artandarchitecture.org.uk",
      "biblio.unibe.ch",
      "bspe-p-pub.paris.fr",
      "www.ngv.vic.gov.au",
    ].includes(url.hostname) &&
    url.pathname === "/zoomify/ImageProperties.xml"
  ) {
    return fixtureFile("fixtures.test", "/zoomify/ImageProperties.xml");
  }
  if (
    url.hostname === "biblio.unibe.ch" &&
    url.pathname === "/web-apps/maps/zoomify.php"
  ) {
    return fixtureFile("fixtures.test", "/zoomify/unibe.html");
  }
  if (
    url.hostname === "bspe-p-pub.paris.fr" &&
    url.pathname === "/MDBGED/zoomify-BFS.aspx"
  ) {
    return fixtureFile("fixtures.test", "/zoomify/paris.html");
  }
  if (
    url.hostname === "www.ngv.vic.gov.au" &&
    url.pathname.startsWith("/explore/collection/work/")
  ) {
    return fixtureFile("fixtures.test", "/zoomify/ngv.html");
  }
  if (
    url.hostname === "www.artandarchitecture.org.uk" &&
    url.pathname.startsWith("/images/zoom/")
  ) {
    return fixtureFile("fixtures.test", "/zoomify/artandarchitecture.html");
  }
  if (url.hostname === "historischarchief.midden-groningen.nl") {
    return fixtureFile("fixtures.test", "/topviewer/mediabank-gallery.html");
  }
  if (
    url.hostname === "www.beeldbankgroningen.nl" &&
    url.pathname.includes("/beelden/detail/")
  ) {
    return fixtureFile("fixtures.test", "/topviewer/mediabank-detail.html");
  }
  if (url.hostname === "artsandculture.google.com") {
    if (url.pathname === "/asset/fixture") {
      return fixtureFile("fixtures.test", "/arts/page.html");
    }
    if (url.pathname === "/asset/plain") {
      return fixtureFile("fixtures.test", "/arts/plain.html");
    }
    if (url.pathname === "/arts/path=g" || url.pathname === "/arts/plain=g") {
      return fixtureFile("fixtures.test", "/arts/TileInfo.xml");
    }
  }
  if (url.hostname === "g.co" && url.pathname === "/arts/fixture") {
    return fixtureFile("fixtures.test", "/arts/page.html");
  }
  if (
    url.hostname === "images.memorix.nl" &&
    (
      url.pathname === "/demo/topviewjson/memorix/sample-file" ||
      url.pathname === "/gra/topviewjson/memorix/1c7914ee-3f37-0d37-3218-48eba1c3a97f" ||
      url.pathname === "/ghs/topviewjson/memorix/686dce31-a340-7d19-ae6d-419cee43b952"
    )
  ) {
    return fixtureFile("fixtures.test", "/topviewer/data.json");
  }
  if (
    url.hostname === "webservices.memorix.nl" &&
    url.pathname === "/mediabank/media/53479cae-899f-0ac1-8913-40276a93a4f7" &&
    url.searchParams.get("apiKey") === "fd45b590-346a-11e5-a2cb-0800200c9a66"
  ) {
    return fixtureFile("fixtures.test", "/topviewer/detail-media.json");
  }
  if (
    url.hostname === "webservices.memorix.nl" &&
    url.pathname === "/mediabank/media" &&
    url.searchParams.get("apiKey") === "c51f00b2-2034-45a2-85ce-0aca7143dbbc" &&
    url.searchParams.get("entities[0]") === "77036348-6551-9e9d-5b2e-b505237e84cf" &&
    url.searchParams.get("rows") === "1" &&
    url.searchParams.get("sort") === "random{1785398881908} asc"
  ) {
    return fixtureFile("fixtures.test", "/topviewer/media.json");
  }

  if (url.hostname === "fixtures.test") {
    if (url.pathname === "/arcgis/MapServer") {
      if (url.searchParams.get("f") === "json") {
        return fixtureFile(url.hostname, "/arcgis/MapServer.json");
      }
      return null;
    }

    if (url.pathname === "/iip" && url.searchParams.has("OBJ")) {
      return fixtureFile(url.hostname, "/iip/image-info.txt");
    }

    if (
      url.pathname === "/scripts/XMLBroker.new.php" &&
      url.searchParams.get("contentID") === "fixture-access-number"
    ) {
      return fixtureFile(url.hostname, "/zoomify/fluid-broker.xml");
    }

    if (url.pathname === "/xl/sample.imgi" && url.searchParams.get("cmd") === "info") {
      return fixtureFile(url.hostname, "/xl/sample-info.xml");
    }

    if (url.pathname === "/fsi/server" && url.searchParams.get("type") === "info") {
      return fixtureFile(url.hostname, "/fsi/server-info.txt");
    }

    if (url.pathname === "/server.iip" && url.searchParams.get("IIIF")) {
      return fixtureFile(url.hostname, "/server.iip/iiif-fronts-info.json");
    }

    if (
      url.pathname === "/deepzoom/legacy" &&
      url.searchParams.get("format") === "xml"
    ) {
      return fixtureFile(url.hostname, "/deepzoom/legacy.xml");
    }

    if (url.pathname === "/hungaricana/imagesize/sample.ecw") {
      return fixtureFile(url.hostname, "/hungaricana/imagesize/sample.ecw.json");
    }
  }

  return fixtureFile(url.hostname, url.pathname);
}

function fixtureFor(target, origin) {
  const filePath = fixturePathFor(new URL(target));
  if (!filePath) return null;
  return responseFromFile(filePath, origin);
}

async function serveProxy(req, res, requestUrl) {
  const target = requestUrl.searchParams.get("url");
  if (!target) {
    res.writeHead(400, { "Content-Type": "text/plain" });
    res.end("missing url");
    return;
  }

  if (useFixtures) {
    const artsTile = artsCultureTile(new URL(target));
    if (artsTile) {
      res.writeHead(artsTile.status, artsTile.headers);
      res.end(req.method === "HEAD" ? undefined : artsTile.body);
      return;
    }

    const fixture = fixtureFor(target, `http://${host}:${port}`);
    if (fixture) {
      res.writeHead(fixture.status, fixture.headers);
      res.end(req.method === "HEAD" ? undefined : fixture.body);
      return;
    }

    if (new URL(target).hostname === "fixtures.test") {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end(`No fixture for ${target}`);
      return;
    }
  }

  const request = new Request(requestUrl, {
    method: req.method,
    headers: req.headers,
  });
  const proxy = await proxyModule;
  const response = req.method === "HEAD"
    ? await proxy.onRequestHead({ request })
    : await proxy.onRequestGet({ request });

  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach((value, name) => {
    res.setHeader(name, value);
  });

  if (!response.body) {
    res.end();
    return;
  }
  stream.Readable.fromWeb(response.body).pipe(res);
}

function serveFixtureFile(res, filePath, origin) {
  const fixture = responseFromFile(filePath, origin);
  res.writeHead(fixture.status, fixture.headers);
  res.end(fixture.body);
}

function serveStatic(req, res, pathname) {
  const origin = `http://${host}:${port}`;

  if (pathname === "/fixtures/iiif-v2/info.json") {
    serveFixtureFile(res, fixtureFile("fixtures.test", "/iiif-v2/info.json"), origin);
    return;
  }

  if (pathname === "/fixtures/iiif-private-id/info.json") {
    serveFixtureFile(res, fixtureFile("fixtures.test", "/iiif-private-id/info.json"), origin);
    return;
  }

  if (pathname === "/fixtures/iiif-default-port/info.json") {
    serveFixtureFile(
      res,
      path.join(localFixtureRoot, "fixtures/iiif-default-port/info.json"),
      origin
    );
    return;
  }

  if (pathname === "/entity/OBJECT/1") {
    serveFixtureFile(res, fixtureFile("fixtures.test", "/entity/OBJECT/1"), origin);
    return;
  }

  if (pathname === "/fixtures/pnav/image.json") {
    serveFixtureFile(res, path.join(localFixtureRoot, "fixtures/pnav/image.json"), origin);
    return;
  }

  if (
    pathname === "/fixtures/tile.jpg" ||
    pathname === "/fixtures/pnav/image.jpg" ||
    pathname.startsWith("/fixtures/iiif-private-id/") ||
    pathname.startsWith("/iiif/") ||
    pathname.startsWith("/digital/iiif/") ||
    pathname === "/server.iip"
  ) {
    res.writeHead(200, { "Content-Type": "image/jpeg" });
    res.end(jpg);
    return;
  }

  if (pathname === "/fixtures/generic/tile.jpg") {
    const url = new URL(req.url, origin);
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

  if (pathname.startsWith("/fixtures/generic/") && pathname.endsWith(".svg")) {
    const url = new URL(req.url, origin);
    const x = Number(url.searchParams.get("x"));
    const y = Number(url.searchParams.get("y"));
    let width = 256;
    let height = 256;
    let available = false;
    let placeholder = false;

    if (pathname.endsWith("/padded.svg")) {
      available = x >= 0 && x < 2 && y >= 0 && y < 2;
    } else if (pathname.endsWith("/large.svg")) {
      available = x >= 0 && x < 2 && y === 0;
      width = 512;
      height = 512;
    } else if (pathname.endsWith("/edge.svg")) {
      available = x >= 0 && x < 2 && y >= 0 && y < 2;
      width = x === 1 ? 44 : 256;
      height = y === 1 ? 14 : 256;
    } else if (pathname.endsWith("/boundary.svg")) {
      available = x >= 0 && x < 1000 && y === 0;
    } else if (pathname.endsWith("/one.svg")) {
      available = x >= 0 && x < 3 && y === 0;
    } else if (pathname.endsWith("/missing-origin.svg")) {
      available = x >= 0 && x < 2 && y >= 0 && y < 2 && !(x === 0 && y === 0);
    } else if (pathname.endsWith("/placeholder.svg")) {
      available = x >= 0 && x < 2 && y >= 0 && y < 2;
      placeholder = !available;
      width = placeholder ? 1 : 256;
      height = placeholder ? 1 : 256;
    }

    if (!available && !placeholder) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("missing tile");
      return;
    }

    const body = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#888888"/></svg>`;
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(body);
    return;
  }

  if (pathname === "/fixtures/assembly/tile.svg") {
    const url = new URL(req.url, origin);
    const width = Number(url.searchParams.get("w") || 256);
    const height = Number(url.searchParams.get("h") || 256);
    const color = url.searchParams.get("color") || "ff0000";
    if (!/^([0-9a-f]{6})$/i.test(color) || width <= 0 || height <= 0) {
      res.writeHead(400, { "Content-Type": "text/plain" });
      res.end("invalid assembly tile");
      return;
    }
    const body = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#${color}"/></svg>`;
    res.writeHead(200, { "Content-Type": "image/svg+xml" });
    res.end(body);
    return;
  }

  const safePath = safeJoin(root, pathname);
  if (!safePath) {
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
      serveProxy(req, res, url).catch((err) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(err.toString() + "\n");
      });
      return;
    }

    serveStatic(req, res, url.pathname === "/" ? "/index.html" : url.pathname);
  })
  .listen(port, host, () => {
    console.log(`fixture server listening at http://${host}:${port}`);
  });
