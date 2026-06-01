"use strict";
var jsdom = require("jsdom");
var Canvas = require("@napi-rs/canvas");
var fs = require("fs");
var path = require("path");

var PROXY_PORT = 8181;
var proxy_server = require("./proxy.js").listen(PROXY_PORT);

var DEZOOMIFY_PATH = path.dirname(__dirname);

if (process.argv.length < 3) {
  console.error("Usage: %s URL [filename.jpg]", process.argv[1]);
  process.exit(1);
} else {
  var target_url = process.argv[2];
  var target_filename = process.argv[3] || 'dezoomed.jpg';
  console.log("Dezooming '%s' and saving it to '%s'...", target_url, target_filename);
}

var virtualConsole = new jsdom.VirtualConsole();
if (virtualConsole.forwardTo) {
  virtualConsole.forwardTo(console);
} else {
  virtualConsole.sendTo(console);
}

function onload(window) {
  var ZoomManager = window.ZoomManager, UI = window.UI;
  if (!ZoomManager.dezoomersList.pnav) {
    window.eval(fs.readFileSync(path.join(DEZOOMIFY_PATH, "dezoomers", "pnav.js"), "utf8"));
  }

  window.Image = class Image extends window.EventTarget {
    constructor() {
      super();
      this.width = this.height = this.naturalWidth = this.naturalHeight = 0;
      this.onload = this.onerror = null;
    }

    set src(url) {
      this._src = new URL(url, window.location.href).href;
      fetch(this._src)
        .then(function (response) {
          if (!response.ok) throw new Error("HTTP " + response.status + " while loading image");
          return response.arrayBuffer();
        })
        .then(function (buffer) {
          return Canvas.loadImage(Buffer.from(buffer));
        })
        .then((img) => {
          this.width = this.naturalWidth = img.width;
          this.height = this.naturalHeight = img.height;
          var event = new window.Event("load");
          if (this.onload) this.onload(event);
          this.dispatchEvent(event);
        })
        .catch((err) => {
          var event = new window.Event("error");
          event.error = err;
          if (this.onerror) this.onerror(event);
          this.dispatchEvent(event);
        });
    }

    get src() {
      return this._src || "";
    }
  };

  UI.error = function error(err) {
    console.error(err);
    proxy_server.close();
  }
  UI.loadEnd = function loadEnd() {
    UI.canvas.encode("jpeg").then(function (buffer) {
      fs.writeFile(target_filename, buffer, function (err) {
        if (err) console.error(err);
        else console.log("Saved the image to " + target_filename);
        proxy_server.close();
      });
    }).catch(function (err) {
      console.error(err);
      proxy_server.close();
    });
  }
  UI.updateProgress = function (progress, text) {
    console.log(parseInt(progress) + "% : " + text);
  }
  UI.setupRendering = function (data) {
    UI.canvas = Canvas.createCanvas(data.width, data.height);
    UI.ctx = UI.canvas.getContext("2d");
  };
  ZoomManager.addTile = function addTile(url, x, y, nTries) {
    if (nTries === (void 0)) nTries = 10;
    fetch(url).then(function (response) {
      if (!response.ok) {
        throw new Error("HTTP " + response.status + " while loading tile");
      }
      return response.arrayBuffer();
    }).then(function tileLoaded(buffer) {
      return Canvas.loadImage(Buffer.from(buffer));
    }).then(function drawTile(img) {
      UI.drawTile(img, x, y);
      ZoomManager.status.loaded++;
    }).catch(function (err) {
        if (nTries === 0) {
          return ZoomManager.error("Error while loading tile: " + url + "\n" + err);
        } else {
          console.log("Request failed, retrying :" + nTries);
          return setTimeout(addTile, Math.pow(2, 10 - nTries), url, x, y, nTries - 1);
        }
    });
  };
  ZoomManager.proxy_url = "http://127.0.0.1:" + PROXY_PORT;
  ZoomManager.open(target_url);
}

jsdom.JSDOM.fromFile(path.join(DEZOOMIFY_PATH, "index.html"), {
  virtualConsole,
  runScripts: "dangerously",
  resources: "usable",
}).then(function (dom) {
  dom.window.onload = onload.bind(null, dom.window)
});
