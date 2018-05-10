"use strict";
var jsdom = require("jsdom/lib/old-api.js");
var Canvas = require("canvas");
var request = require("request");
var fs = require("fs");
var path = require("path");

var PROXY_PORT = 8181;
var proxy_server = require("./proxy.js").listen(PROXY_PORT);

var DEZOOMIFY_PATH = path.dirname(__dirname);

var dezoomdir = path.join(DEZOOMIFY_PATH, "dezoomers");
var scripts = fs.readdirSync(dezoomdir).map(s => "dezoomers/"+s);
scripts.unshift("zoommanager.js");

var virtualConsole = jsdom.createVirtualConsole().sendTo(console);

function onload(window) {
  var ZoomManager = window.ZoomManager, UI = window.UI;
  UI.error = function error(err) {
    console.error(err);
    proxy_server.close();
  }
  UI.loadEnd = function loadEnd() {
    var out = fs.createWriteStream(process.argv[3]);
    UI.canvas.jpegStream().pipe(out);
    proxy_server.close();
  }
  UI.updateProgress = function(progress, text) {
    console.log(parseInt(progress) + "% : " + text);
  }
  UI.setupRendering = function (data) {
  	UI.canvas = new Canvas(data.width, data.height);
  	UI.ctx = UI.canvas.getContext("2d");
  };
  ZoomManager.addTile = function addTile (url, x, y, nTries) {
    if (nTries === (void 0)) nTries = 10;
    //Request a tile from the server, and prints add it to the canvas when it's received
    request({url, encoding:null}, function tileLoaded(err, stream, buffer){
      if (err) {
        if (nTries === 0) {
          return ZoomManager.error("Error while loading tile: " + url + "\n" + err);
        } else {
          console.log("Request failed, retrying :" + nTries);
          return setTimeout(addTile, Math.pow(2, 10-nTries), url, x, y, nTries-1);
        }
      }
      var img = new Canvas.Image;
      img.src = buffer;
      UI.drawTile(img, x, y);
      ZoomManager.status.loaded ++;
    });
  };
  ZoomManager.proxy_url = "http://127.0.0.1:"+PROXY_PORT;
  ZoomManager.open(process.argv[2]);
}

if (process.argv.length < 3) {
  console.error("Usage: %s [URL] filename.jpg", process.argv[1]);
  process.exit(1);
} else {
  jsdom.env({
    file: path.join(DEZOOMIFY_PATH, "dezoomify.html"),
    scripts,
    virtualConsole,
    onload
  });
}
