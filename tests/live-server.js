const fs = require("fs");
const http = require("http");
const path = require("path");
const stream = require("stream");
const url = require("url");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 9878);
const host = "127.0.0.1";
const proxyModule = import(url.pathToFileURL(path.join(root, "functions", "proxy.js")));

const contentTypes = {
  ".css": "text/css",
  ".html": "text/html",
  ".js": "application/javascript",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".xml": "application/xml",
};

async function serveProxy(req, res, requestUrl) {
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
    const requestUrl = new URL(req.url, origin);

    if (requestUrl.pathname === "/proxy") {
      serveProxy(req, res, requestUrl).catch((err) => {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end(err.toString() + "\n");
      });
      return;
    }

    serveStatic(req, res, requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  })
  .listen(port, host, () => {
    console.log(`live test server listening at http://${host}:${port}`);
  });
