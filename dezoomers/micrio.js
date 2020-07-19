var micrio = (function () {
  return {
    name: 'Micrio',
    description: 'Micrio (used by vangoghmuseum.nl)',
    urls: [
      /rijksmuseum.nl\/en\/rijksstudio/,
      /\/api\/getTilesInfo\?object_id=/
    ],
    contents: [
      /data-role="micrio"/,
      /dataSourcePath\s*:\s*".*"/
    ],
    findFile: function getInfoFile(baseUrl, callback) {
      if (baseUrl.match(/\/api\/getTilesInfo\?object_id=/)) return callback(baseUrl);

      ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text, xhr) {
        var idMatch = text.match(/data-id="([^"]+)"/);
        var bpMatch = text.match(/data-base-path="([^"]+)"/);
        if (idMatch && bpMatch) {
          return callback(bpMatch[1] + idMatch[1]);
        }
        var dataSourceMatch = text.match(/dataSourcePath["']?\s*:\s*["']([^'"]*)['"]/);
        if (dataSourceMatch) {
          var imageMatch = baseUrl.match(/#\/([^,]*)(?:,(\d+))?/);
          var objectNumber = imageMatch ? imageMatch[1] : "";
          var offset = imageMatch ? imageMatch[2] : "";
          var dataQueryMatch = text.match(/dataSourceQuery["']?\s*:\s*("[^"]*")/);
          var metaInfPath = dataSourceMatch[1] + ((dataQueryMatch) ? JSON.parse(dataQueryMatch[1]) : "");
          if (offset) {
            metaInfPath = metaInfPath.replace(/offset=\d+/, "offset=" + offset);
          }
          var metaInfUrl = ZoomManager.resolveRelative(metaInfPath, baseUrl);
          return ZoomManager.getFile(metaInfUrl, { type: "json" }, function (metaInf, xhr) {
            var items = metaInf.setItems;
            for (var i = 0; i < items.length; i++) {
              if (items[i].ObjectNumber === objectNumber) {
                return callback(items[i].TilingUrl);
              }
            }
            return callback(items[0].TilingUrl);
          });
        }
        return callback(baseUrl);
      });
    },
    open: function (url) {
      ZoomManager.getFile(url, { type: 'json' }, function (doc, xhr) {
        var level = doc.levels.reduce(function (prev, cur) {
          return prev.width > cur.width || prev.height > cur.height ? prev : cur;
        }, { width: 0, height: 0 });
        ZoomManager.readyToRender({
          width: level.width,
          height: level.height,
          tileSize: 512,
          tiles: level.tiles.reduce(function (tiles, tile) {
            tiles[tile.x + ',' + tile.y] = tile.url;
            return tiles;
          }, {})
        });
      });
    },
    getTileURL: function (x, y, _zoom, data) {
      return data.tiles[x + ',' + y];
    },
  };
})();
ZoomManager.addDezoomer(micrio);
