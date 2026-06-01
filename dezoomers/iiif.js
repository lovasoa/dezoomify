// IIIF Image API 2.1
var iiif = (function () {
  var iiifPathRegExp =
    "(?:/info\\.json|" +
    "/\\^?(?:full|square|(?:pct:)?\\d+,\\d+,\\d+,\\d+)" + // region
    "/(?:full|max|\\d+,|,\\d+|pct:\\d+|!?\\d+,\\d+)" + // size
    "/!?[1-3]?[0-9]?[0-9]" + // rotation
    "/(?:color|gray|bitonal|default|native)" + // quality
    "\\.(?:jpe?g|tiff?|png|gif|jp2|pdf|webp)" + // format
    ")";
  var urlReg = new RegExp( // IIIF API image URL
    "(https?://[^\"'\\s]+)" + // base
    iiifPathRegExp
  );
  var relativeUrlReg = new RegExp(
    "((?:/|\\.\\.?/)[^\"'\\s<>]+)" + iiifPathRegExp
  );
  var gallicaReg = /https?:\/\/gallica\.bnf\.fr\/ark:\/(\w+\/\w+)(?:\/(f\w+))?/
  function extractUrl(text, baseUrl) {
    var match = text.match(urlReg) || text.match(relativeUrlReg);
    if (!match) return null;
    var result = match[1] + "/info.json";
    if (baseUrl) result = ZoomManager.resolveRelative(result, baseUrl);
    // Van Gogh Museum has hash-protected URLs on micrio.* but not micrio-cdn.* 
    result = result.replace('micrio.vangoghmuseum.nl/iiif', 'micrio-cdn.vangoghmuseum.nl');
    return result;
  }

  function isPrivateIPv4(hostname) {
    var match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return false;
    var first = Number(match[1]);
    var second = Number(match[2]);
    return (
      first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    );
  }

  return {
    "name": "IIIF",
    "description": "International Image Interoperability Framework",
    "urls": [urlReg, gallicaReg],
    "contents": [urlReg, relativeUrlReg],
    "findFile": function getInfoFile(baseUrl, callback) {

      var gallicaMatch = baseUrl.match(gallicaReg);
      if (gallicaMatch) {
        baseUrl = 'https://gallica.bnf.fr/iiif/ark:/' +
          gallicaMatch[1] + '/' +
          (gallicaMatch[2] || 'f1') +
          '/info.json';
      }

      var url = extractUrl(baseUrl);
      if (url) return callback(url);

      ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text) {
        var url = extractUrl(text, baseUrl);
        if (url) return callback(url);
        throw new Error("No IIIF URL found.");
      });
    },
    "open": function (url) {
      ZoomManager.getFile(url, { type: "json" }, function (data, xhr) {
        function min(array) { return Math.min.apply(null, array) }
        function searchWithDefault(array, search, defaultValue) {
          // Return the searched value if it's in the array.
          // Else, return the first value of the array, or defaultValue if the array is empty or invalid
          var array = (array && array.length) ? array : [defaultValue];
          return ~array.indexOf(search) ? search : array[0];
        }
        function explicitPort(rawUrl) {
          var match = String(rawUrl).match(/^https?:\/\/(?:\[[^\]]+\]|[^\/?#:]+):(\d+)(?:[\/?#]|$)/i);
          return match && match[1];
        }
        function hasDefaultPortOriginMismatch(serviceUrl, infoUrl, rawServiceUrl) {
          if (serviceUrl.hostname !== infoUrl.hostname) return false;
          if (serviceUrl.protocol === infoUrl.protocol && serviceUrl.port === infoUrl.port) return false;

          var port = explicitPort(rawServiceUrl);
          return port === "80" || port === "443" ||
            (serviceUrl.protocol === "http:" && infoUrl.protocol === "https:" && !serviceUrl.port);
        }

        var tiles;
        if (data.tiles && data.tiles.length) {
          tiles = data.tiles.reduce(function (red, val) {
            return min(red.scaleFactors) < min(val.scaleFactors) ? red : val;
          });
        } else {
          // map-view.nls.uk contains invalid tile widths (see dezoomify-rs#92)
          tiles = {
            "width":
              (data.tile_width < data.width)
                ? data.tile_width
                : 512,
            "scaleFactors": [1]
          }
        }

        try {
          data["@id"] = data["@id"] || data.id;
          if (!data["@id"]) throw new Error("missing iiif @id");
          // See https://github.com/lovasoa/dezoomify/issues/582
          data["@id"] = data["@id"].replace(/^https?, (https?:\/\/)/, '$1');
          var origin = new URL(data["@id"], url);
          var infoUrl = new URL(url);
          if (hasDefaultPortOriginMismatch(origin, infoUrl, data["@id"])) {
            origin.protocol = infoUrl.protocol;
            origin.host = infoUrl.host;
          }
          if (origin.hostname === "localhost" || origin.hostname === "example.com" || isPrivateIPv4(origin.hostname)) {
            throw new Error("probably a test host");
          }
        } catch (e) {
          console.log("Rewriting the @id from the manifest: " + e);
          var origin = url.replace(/\/info\.json(\?.*)?$/, '');
        }
        var returned_data = {
          "origin": origin.toString(),
          "width": parseInt(data.width),
          "height": parseInt(data.height),
          "tileSize": tiles.width,
          "maxZoomLevel": Math.min.apply(null, tiles.scaleFactors),
          "quality": searchWithDefault(data.qualities || data.extraQualities, "native", "default"),
          "format": searchWithDefault(data.formats || data.extraFormats, "png", "jpg")
        };
        var img = new Image; // Load a tile to find out the real tile size
        img.src = getTileURL(0, 0, returned_data.maxZoomLevel, returned_data);
        img.addEventListener("load", function () {
          returned_data.tileSize = Math.max(img.width, img.height);
          ZoomManager.readyToRender(returned_data);
        });
        img.addEventListener("error", function () {
          ZoomManager.readyToRender(returned_data); // Try rendering anyway
          ZoomManager.error("Unable to load first tile: " + img.src);
        });
      });
    },
    "getTileURL": getTileURL
  };

  function getTileURL(x, y, zoom, data) {
    var s = data.tileSize,
      pxX = x * s, pxY = y * s,
      sx, sy;
    //The image size is adjusted for edges
    //width
    if (pxX + s > data.width) {
      sx = data.width - pxX;
    } else {
      sx = s;
    }
    //height
    if (pxY + s > data.height) {
      sy = data.height - pxY;
    } else {
      sy = s;
    }
    return data.origin + "/" +
      pxX + "," + // source image X
      pxY + "," + // source image Y
      sx + "," + // source image width
      sy + "/" + // source image height
      sx + "," + // returned image width
      sy + "/" + // returned image height
      "0" + "/" + //rotation
      data.quality + "." + //quality
      data.format; //format
  }
})();
ZoomManager.addDezoomer(iiif);
