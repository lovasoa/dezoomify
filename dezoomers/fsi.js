// FSI
var fsi = (function(){
  return {
    "name" : "FSI",
    "description": "FSI Server, by Neptune Labs",
    "urls" : [
      /server\?.*(?:(?:type=|image=).*?){2}/,
    ],
    "contents" : [
      /server\?.*(?:(?:type=|image=).*?){2}/,
      /<fsi-viewer/
    ],
    "findFile" : function getInfoFile (baseUrl, callback) {
      function try_url (url) {
        var fsiMatch = url.match(/server.*[?&]source=([^&]+)/);
        if (!fsiMatch) return false;
        var info_params = "server?type=info&source=" + fsiMatch[1];
        var info_url = url.replace(/server\?.*$/, info_params);
        callback(info_url);
        return true;
      }
      if (try_url(baseUrl)) return;

      // Inline references
      ZoomManager.getFile(baseUrl, {type:"htmltext"}, function (text) {
          var url_matches = text.match(/[^\s"']*\/server[^\s"']*/g);
          if (url_matches) {
            for (var i = 0; i < url_matches.length; i++) {
              if (try_url(url_matches[i])) return;
            }
          }
          throw new Error("No FSI URL found.");
      });
    },
    "open" : function (url) {
      ZoomManager.getFile(url, {type:"text"}, function (infotxt, xhr) {
        var WIDTH_REG = /width\s+value=["']?(\d+)/i;
        var HEIGHT_REG = /height\s+value=["']?(\d+)/i;
        var returned_data = {
          "origin": url.replace(/\/server\?.*/, '/server'),
          "source": url.match(/source=([^&]+)/)[1],
          "width" : parseInt(infotxt.match(WIDTH_REG)[1]),
          "height" : parseInt(infotxt.match(HEIGHT_REG)[1]),
          "tileSize" : 512,
        };
        ZoomManager.readyToRender(returned_data);
      });
    },
    "getTileURL" : function (x, y, zoom, data) {
      var coords = [x, y].map(function (position, i) {
        var pos = position*data.tileSize;
        var size = Math.min(data.tileSize, data[i===0? "width":"height"] - pos);
        return {pos:pos, size:size};
      });
      return data.origin +
                  "?type=image&source=" + data.source +
                  "&width=" + coords[0].size +
                  "&height=" + coords[1].size +
                  "&rect=" + coords[0].pos / data.width + "," +
                           + coords[1].pos / data.height + "," +
                           + coords[0].size / data.width + "," +
                           + coords[1].size / data.height;
    }
  };
})();
ZoomManager.addDezoomer(fsi);
