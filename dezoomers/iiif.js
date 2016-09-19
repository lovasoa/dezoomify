// IIIF Image API 2.1
var iiif = (function(){
  return {
    "name" : "IIIF",
    "description": "International Image Interoperability Framework",
    "urls" : [
      /\/info.json$/
    ],
    "contents" : [
      /http:\/\/[^\s"']*\/info\.json/
    ],
    "findFile" : function getInfoFile (baseUrl, callback) {
      if (baseUrl.match(/info\.json$/)) {
        return callback(baseUrl);
      }
      ZoomManager.getFile(baseUrl, {type:"htmltext"}, function (text) {
          var infoMatch = text.match(/http:\/\/[^\s"']*\/info\.json/);
          if (infoMatch) {
            return callback(infoMatch[0]);
          }
          throw new Error("No IIIF URL found.");
      });
    },
    "open" : function (url) {
      ZoomManager.getFile(url, {type:"json"}, function (data, xhr) {
        function min(array){return Math.min.apply(null, array)}

        var tiles =
          (data.tiles && data.tiles.length)
            ? data.tiles.reduce(function(red, val){
                  return min(red.scaleFactors) < min(val.scaleFactors) ? red : val;
              })
            : {"width": 512, "scaleFactors": [1]};
        var data = {
          "origin": data["@id"],
          "width" : parseInt(data.width),
          "height" : parseInt(data.height),
          "tileSize" : tiles.width,
          "maxZoomLevel" : Math.min.apply(null, tiles.scaleFactors)
        };
        ZoomManager.readyToRender(data);
      });
    },
    "getTileURL" : function (x, y, zoom, data) {
      var s = data.tileSize,
          pxX = x*s, pxY = y*s;
      return data.origin + "/" +
                          pxX  + "," + // source image X
                          pxY  + "," + // source image Y
                          s    + "," + // source image width
                          s    + "/" + // source image height
                          s    + "," + // returned image width
                          s    + "/" + // returned image height
                          "0"  + "/" + //rotation
                          "native" + "." + //quality
                          "jpg"; //format
    }
  };
})();
ZoomManager.addDezoomer(iiif);
