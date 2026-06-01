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
  var londonMuseumServiceRootReg =
    /(https?:\/\/collections\.londonmuseum\.net\/iiif\/3\/[^"'\s<>]+?\.ptif)(?=["'\s<>])/;
  var philadelphiaMuseumMicrioShortIdReg =
    /(?:philamuseum|Philadelphia Museum)[\s\S]*\\?"shortId\\?"\s*:\s*\\?"([A-Za-z0-9_-]{3,32})\\?"|\\?"shortId\\?"\s*:\s*\\?"([A-Za-z0-9_-]{3,32})\\?"[\s\S]*(?:philamuseum|Philadelphia Museum)/;
  var contentdmRecordReg = /^(https?:\/\/[^/]+)(\/digital)\/collection\/([^/?#]+)\/id\/(\d+)(?:[/?#]|$)/;
  var manifestParamReg = /^https?:\/\/[^#]*(?:[?&][^#]*\bmanifest=|#[^#]*\bmanifest=)/;
  var onbPresentationManifestReg = /^https?:\/\/api\.onb\.ac\.at\/iiif\/presentation\/v3\/manifest\/[^?#]+(?:[?#].*)?$/;
  var onbViewerReg = /^https?:\/\/viewer\.onb\.ac\.at\/[^?#]+(?:[?#].*)?$/;
  var onbRepViewerReg = /^https?:\/\/digital\.onb\.ac\.at\/RepViewer\/viewer\.faces\?(?=[^#]*\bdoc=)/;
  var gallicaReg = /https?:\/\/gallica\.bnf\.fr\/ark:\/(\w+\/\w+)(?:\/(f\w+))?/
  var micrioCustomElementReg = /<micr-io\b[^>]*\bid=["']([A-Za-z0-9]{5})["'][^>]*>/i;
  function extractUrl(text, baseUrl) {
    var match = text.match(urlReg) ||
      text.match(relativeUrlReg) ||
      text.match(londonMuseumServiceRootReg);
    var result;
    if (match) {
      result = match[1] + "/info.json";
    } else {
      match = text.match(micrioCustomElementReg);
      if (!match) return null;
      result = "https://i.micr.io/" + match[1] + "/info.json";
    }
    if (baseUrl) result = ZoomManager.resolveRelative(result, baseUrl);
    // Van Gogh Museum has hash-protected URLs on micrio.* but not micrio-cdn.* 
    result = result.replace('micrio.vangoghmuseum.nl/iiif', 'micrio-cdn.vangoghmuseum.nl');
    return result;
  }
  function extractPhiladelphiaMuseumMicrioUrl(text) {
    var match = text.match(philadelphiaMuseumMicrioShortIdReg);
    if (!match) return null;
    return "https://i.micr.io/" + (match[1] || match[2]) + "/info.json";
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

  function contentdmInfoUrl(info, origin, appPath) {
    if (!info || !info.iiifInfoUri) return null;
    if (info.iiifInfoUri.match(/\w*:\/\//)) return info.iiifInfoUri;
    if (info.iiifInfoUri.indexOf(appPath + "/") === 0) return origin + info.iiifInfoUri;
    if (info.iiifInfoUri.indexOf("/") === 0) return origin + appPath + info.iiifInfoUri;
    return origin + appPath + "/" + info.iiifInfoUri;
  }
  function manifestParamUrl(baseUrl) {
    try {
      var url = new URL(baseUrl);
      return url.searchParams.get("manifest") || fragmentManifestParamUrl(url.hash);
    } catch (e) {
      var match = String(baseUrl).match(/[?&#]manifest=([^&#]+)/);
      return match && decodeURIComponent(match[1]);
    }
  }
  function fragmentManifestParamUrl(hash) {
    if (!hash) return null;
    var params = String(hash).replace(/^#\??/, "");
    return new URLSearchParams(params).get("manifest");
  }
  function onbManifestUrl(baseUrl) {
    try {
      var url = new URL(baseUrl);
      var manifestPrefix = "/iiif/presentation/v3/manifest/";
      if (url.hostname === "api.onb.ac.at" && url.pathname.indexOf(manifestPrefix) === 0) {
        return url.href;
      }
      if (url.hostname === "viewer.onb.ac.at") {
        var viewerId = url.pathname.replace(/^\/+|\/+$/g, "").split("/")[0];
        if (viewerId) return "https://api.onb.ac.at/iiif/presentation/v3/manifest/" + viewerId;
      }
      if (url.hostname === "digital.onb.ac.at" && url.pathname === "/RepViewer/viewer.faces") {
        var doc = url.searchParams.get("doc");
        if (doc) return "https://api.onb.ac.at/iiif/presentation/v3/manifest/" + encodeURIComponent(doc);
      }
    } catch (e) {
      return null;
    }
    return null;
  }
  function imageServiceInfoUrl(service) {
    if (!service || typeof service !== "object") return null;
    var url = service["@id"] || service.id;
    if (!url) return null;
    var serviceType = String(service.type || service["@type"] || "");
    var isImageService =
      /^ImageService[0-9]?$/.test(serviceType) ||
      String(service.profile || "").indexOf("iiif.io/api/image/") >= 0 ||
      String(service["@context"] || "").indexOf("iiif.io/api/image/") >= 0;
    if (!isImageService) return null;
    if (/\/info\.json(?:[?#].*)?$/.test(url)) return url;
    return url.replace(/\/?([?#].*)?$/, "/info.json$1");
  }
  function firstServiceInfoUrl(service) {
    var services = service && service.length ? service : [service];
    for (var i = 0; i < services.length; i++) {
      var infoUrl = imageServiceInfoUrl(services[i]);
      if (infoUrl) return infoUrl;
    }
    return null;
  }
  function firstBodyImageServiceInfoUrl(body) {
    var bodies = body && body.length ? body : [body];
    for (var i = 0; i < bodies.length; i++) {
      var infoUrl = bodies[i] && firstServiceInfoUrl(bodies[i].service);
      if (infoUrl) return infoUrl;
    }
    return null;
  }
  function firstPresentationImageServiceInfoUrl(manifest) {
    var sequences = manifest && manifest.sequences;
    for (var i = 0; sequences && i < sequences.length; i++) {
      var canvases = sequences[i].canvases;
      for (var j = 0; canvases && j < canvases.length; j++) {
        var images = canvases[j].images;
        for (var k = 0; images && k < images.length; k++) {
          var service = images[k].resource && images[k].resource.service;
          var infoUrl = firstServiceInfoUrl(service);
          if (infoUrl) return infoUrl;
        }
      }
    }

    var items = manifest && manifest.items;
    for (var m = 0; items && m < items.length; m++) {
      var annotationPages = items[m].items;
      for (var n = 0; annotationPages && n < annotationPages.length; n++) {
        var annotations = annotationPages[n].items;
        for (var o = 0; annotations && o < annotations.length; o++) {
          var bodyInfoUrl = firstBodyImageServiceInfoUrl(annotations[o].body);
          if (bodyInfoUrl) return bodyInfoUrl;
        }
      }
    }
    return null;
  }
  return {
    "name": "IIIF",
    "description": "International Image Interoperability Framework",
    "urls": [urlReg, gallicaReg, contentdmRecordReg, manifestParamReg, onbPresentationManifestReg, onbViewerReg, onbRepViewerReg],
    "contents": [
      urlReg,
      relativeUrlReg,
      londonMuseumServiceRootReg,
      philadelphiaMuseumMicrioShortIdReg,
      micrioCustomElementReg,
    ],
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

      var contentdmMatch = baseUrl.match(contentdmRecordReg);
      if (contentdmMatch) {
        var apiUrl = contentdmMatch[1] + contentdmMatch[2] +
          "/api/singleitem/collection/" + contentdmMatch[3] +
          "/id/" + contentdmMatch[4];
        return ZoomManager.getFile(apiUrl, { type: "json" }, function (info) {
          var url = contentdmInfoUrl(info, contentdmMatch[1], contentdmMatch[2]);
          if (url) return callback(url);
          throw new Error("No CONTENTdm IIIF URL found.");
        });
      }

      var manifestUrl = onbManifestUrl(baseUrl) || manifestParamUrl(baseUrl);
      if (manifestUrl) {
        return ZoomManager.getFile(manifestUrl, { type: "json" }, function (manifest) {
          var infoUrl = firstPresentationImageServiceInfoUrl(manifest);
          if (infoUrl) return callback(infoUrl);
          throw new Error("No IIIF Image API service found in manifest.");
        });
      }

      ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text) {
        var url = extractUrl(text, baseUrl) ||
          extractPhiladelphiaMuseumMicrioUrl(text);
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
          "quality": data.qualities
            ? searchWithDefault(data.qualities, "native", "default")
            : "default",
          "format": data.formats
            ? searchWithDefault(data.formats, "png", "jpg")
            : "jpg"
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
