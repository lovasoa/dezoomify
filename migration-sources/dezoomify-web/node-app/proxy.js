"use strict";

var http = require("http");
var stream = require("stream");
var path = require("path");
var url = require("url");

var proxyModule = import(url.pathToFileURL(path.join(__dirname, "..", "functions", "proxy.js")));

function failResponse(res, err) {
  res.writeHead(500, { "Content-Type": "text/plain" });
  res.end(err.toString() + "\n");
}

async function handleRequest(req, res) {
  var requestUrl = new URL(req.url, "http://127.0.0.1");
  console.log("Requested: " + requestUrl.searchParams.get("url"));

  var request = new Request(requestUrl, {
    method: req.method,
    headers: req.headers,
  });
  var proxy = await proxyModule;
  var response;
  if (req.method === "HEAD") {
    response = await proxy.onRequestHead({ request: request });
  } else if (req.method === "OPTIONS") {
    response = proxy.onRequestOptions();
  } else {
    response = await proxy.onRequestGet({ request: request });
  }

  res.statusCode = response.status;
  res.statusMessage = response.statusText;
  response.headers.forEach(function(value, name) {
    res.setHeader(name, value);
  });

  if (!response.body) {
    res.end();
    return;
  }
  stream.Readable.fromWeb(response.body).pipe(res);
}

var server = new http.Server();
server.on("request", function(req, res) {
  handleRequest(req, res).catch(function(err) {
    failResponse(res, err);
  });
});

module.exports = server;

// Start the server only if called as a standalone script.
if (require.main === module) {
  server.listen(8181);
  console.log("listening on port 8181");
}
