var iipimage = (function(){
  return {
    "name" : "IIPImage",
    "description": "IIPImage image server",
    "urls" : [
      /\?FIF=/
    ],
    "contents" : [
      /\?FIF=/
    ],
    "findFile" : function getInfoFile (baseUrl, callback) {
      if (baseUrl.indexOf("?FIF=") > -1) {
        return callback(baseUrl);
      }
      ZoomManager.getFile(baseUrl, {type:"htmltext"}, function (text) {
          var fifMatch = text.match(/["']([^"']*?\?FIF=.*?)["']/);
          if (fifMatch) {
            var path = fifMatch[1];
            var url = ZoomManager.resolveRelative(path, baseUrl);
            return callback(url);
          }
          throw new Error("No IIPImage-related URL found.");
      });
    },
    "open" : function (url) {
      var baseUrl = url.match(/^.*\?FIF=[^&]*/)[0];
      var infoUrl = baseUrl + "&OBJ=Max-size&OBJ=Tile-size&OBJ=Resolution-number";
      ZoomManager.getFile(infoUrl, {type:"text"}, function (text, xhr) {
        var sizeMatch = text.match(/Max-size:(\d+) (\d+)/);
        var tileSizeMatch = text.match(/Tile-size:(\d+) (\d+)/);
        var zoomMatch = text.match(/Resolution-number:(\d+)/);
        if (!sizeMatch || !tileSizeMatch ||
            sizeMatch.length !== 3 || tileSizeMatch.length !== 3) {
          throw new Error("Invalid IIPImage information file.");
        }
        var data = {
          "origin": baseUrl,
          "width" : parseInt(sizeMatch[1]),
          "height" : parseInt(sizeMatch[2]),
          "tileSize" : parseInt(tileSizeMatch[1]),
          "maxZoomLevel" : parseInt(zoomMatch[1])-1
        };
        ZoomManager.readyToRender(data);
      });
    },
    "getTileURL" : function (x, y, zoom, data) {
      var index = x + y * data.nbrTilesX;
      return data.origin + "&JTL=" + zoom + "," + index;
    }
  };
})();
ZoomManager.addDezoomer(iipimage);
