// Tretiakov gallery
var tretiakov = (function(){
  return {
    "name" : "Tretiakov",
    "description": "Images from the website of the Tretiakov gallery (tretyakovgallery.ru)",
    "urls" : [
      /tretyakovgallery\.ru\/.*\/image\/_id\/\d+/,
      /tretyakovgallery\.ru\/ajax\/\?action=fetch_image&id=\d+/
    ],
    "contents" : [],
    "findFile" : function getInfoFile (baseUrl, callback) {
      var API_URL = "http://www.tretyakovgallery.ru/ajax/?action=fetch_image&id=";
      var idMatch = baseUrl.match(/image\/_id\/(\d+)/);
      if (idMatch) {
        return callback(API_URL + idMatch[1]);
      }
      return callback(baseUrl);
    },
    "open" : function (url) {
      ZoomManager.getFile(url, {type:"text"}, function (text) {
        var prop_match = text.match(/fullimage_src = \{height:'(\d+)',width:'(\d+)'\}/);
        if (!prop_match) throw "File doesn't conform to the tretiakov description script format";
        var height = prop_match[1], width = prop_match[2];
        var tileSize = text.match(/\['1'\]\['1'\]\['width'\] = '(\d+)'/)[1];
        var reg = /\['(\d+)'\]\['(\d+)'\]\['src'\] = '([^']*)'/g;
        var tiles = [], match;
        while(match = reg.exec(text)) {
          var y = parseInt(match[1]) - 1;
          var x = parseInt(match[2]) - 1;
          tiles[y] = tiles[y] || [];
          tiles[y][x] = match[3];
        }
        ZoomManager.readyToRender({
          "origin" : 'http://www.tretyakovgallery.ru/pictures/',
          "width" : parseInt(width),
          "height" : parseInt(height),
          "tileSize" : parseInt(tileSize),
          "tiles" : tiles
        });
      });
    },
    "getTileURL" : function (x, y, zoom, data) {
      return data.tiles[y][x];
    }
  };
})();
ZoomManager.addDezoomer(tretiakov);
