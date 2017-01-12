// FSI
var fsi = (function(){
  return {
    "name" : "FSI",
    "description": "FSI Server, by Neptune Labs",
    "urls" : [
      /server\?.*(?:(?:type=|image=).*?){2}/,
      /romandelarose\.org\/#read;.+/
    ],
    "contents" : [
      /server\?.*(?:(?:type=|image=).*?){2}/
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

      // romandelarose.org
      var roseMatch = baseUrl.match(/romandelarose\.org\/#read;(([^.]+)\..+)/);
      if (roseMatch) {
        // http://romandelarose.org/#read;Douce332.140r.tif
        var rose_url = "http://fsiserver.library.jhu.edu/server?type=info&source=rose/" +
                        roseMatch[2] + "/cropped/" + roseMatch[1];
        if (try_url(rose_url)) return;
      }

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
      return data.origin +
                  "?type=image&source=" + data.source +
                  "&width=" + data.tileSize + "&height=" + data.tileSize +
                  "&left=" + (x*data.tileSize/data.width) +
                  "&right=" + ((x+1)*data.tileSize/data.width) +
                  "&top=" + (y*data.tileSize/data.height) +
                  "&bottom=" + ((y+1)*data.tileSize/data.height);
    }
  };
})();
ZoomManager.addDezoomer(fsi);
