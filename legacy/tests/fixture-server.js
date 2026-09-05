const fs = require("fs");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const stream = require("stream");
const urlModule = require("url");

const root = path.resolve(__dirname, "..");
const fixtureRoot = path.join(__dirname, "fixtures");
const remoteFixtureRoot = path.join(fixtureRoot, "remote");
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

  const extensions = [".html", ".json", ".xml", ".txt"];
  const candidates = [basePath, ...extensions.map((ext) => `${basePath}${ext}`)];
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    candidates.push(...extensions.map((ext) => path.join(basePath, `index${ext}`)));
    // A service fixture directory also exposes its well-known capabilities
    // document, so bare KVP endpoints (e.g. /wmts?service=WMTS&request=
    // GetCapabilities) resolve like they would on a real server.
    candidates.push(path.join(basePath, "WMTSCapabilities.xml"));
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }

  return null;
}

function fixtureFor(target, origin) {
  const url = new URL(target);
  const filePath = fixtureFile(url.hostname, url.pathname);
  if (!filePath) return null;
  return responseFromFile(filePath, origin);
}

function serveFile(res, filePath, origin) {
  const fixture = responseFromFile(filePath, origin);
  res.writeHead(fixture.status, fixture.headers);
  res.end(fixture.body);
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

function serveStatic(req, res, pathname) {
  const origin = `http://${host}:${port}`;
  const localFixture = fixtureFile(host, pathname);
  if (localFixture) {
    serveFile(res, localFixture, origin);
    return;
  }

  if (
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
      width = x === 1 ? 1 : 256;
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
