// IIIF Image API 2.1
var iiif = (function () {
  var urlReg = new RegExp( // IIIF API image URL
    "(https?://[^\"'\\s]+)" + // base
    "(?:/info\\.json|" +
    "/\\^?(?:full|square|(?:pct:)?\\d+,\\d+,\\d+,\\d+)" + // region
    "/(?:full|max|\\d+,|,\\d+|pct:\\d+|!?\\d+,\\d+)" + // size
    "/!?[1-3]?[0-9]?[0-9]" + // rotation
    "/(?:color|gray|bitonal|default|native)" + // quality
    "\\.(?:jpe?g|tiff?|png|gif|jp2|pdf|webp)" + // format
    ")"
  );
  var gallicaReg = /https?:\/\/gallica\.bnf\.fr\/ark:\/(\w+\/\w+)(?:\/(f\w+))?/
  function extractUrl(text) {
    var match = text.match(urlReg);
    if (match) return match[1] + "/info.json";
  }
  return {
    "name": "IIIF",
    "description": "International Image Interoperability Framework",
    "urls": [urlReg, gallicaReg],
    "contents": [urlReg],
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
        var url = extractUrl(text);
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

        var tiles =
          (data.tiles && data.tiles.length)
            ? data.tiles.reduce(function (red, val) {
              return min(red.scaleFactors) < min(val.scaleFactors) ? red : val;
            })
            : { "width": data.tile_width || 512, "scaleFactors": [1] };

        var returned_data = {
          "origin": data["@id"] || url.replace(/\/info\.json$/, ''),
          "width": parseInt(data.width),
          "height": parseInt(data.height),
          "tileSize": tiles.width,
          "maxZoomLevel": Math.min.apply(null, tiles.scaleFactors),
          "quality": searchWithDefault(data.qualities, "native", "default"),
          "format": searchWithDefault(data.formats, "png", "jpg")
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
      pxX = x * s, pxY = y * s;
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
      "" + "/" + // returned image height
      "0" + "/" + //rotation
      data.quality + "." + //quality
      data.format; //format
  }
})();
ZoomManager.addDezoomer(iiif);
