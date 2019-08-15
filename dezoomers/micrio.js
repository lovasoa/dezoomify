var micrio = (function () {
  return {
    name: 'Micrio',
    description: 'Micrio (used by vangoghmuseum.nl)',
    urls: [
      /vangoghmuseum-assetserver/,
      /vangoghmuseum\.nl/
    ],
    contents: [
      /data-role="micrio"/
    ],
    findFile: function getInfoFile(baseUrl, callback) {
      if (baseUrl.match(/vangoghmuseum-assetserver/)) {
        return callback(baseUrl);
      }
      ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text, xhr) {
        var idMatch = text.match(/data-id="([^"]+)"/);
        var bpMatch = text.match(/data-base-path="([^"]+)"/);
        if (idMatch && bpMatch) {
          return callback(bpMatch[1] + idMatch[1]);
        }
        return callback(baseUrl);
      });
    },
    open: function (url) {
      ZoomManager.getFile(url, { type: 'json' }, function (doc, xhr) {
        var level = doc.levels[0];
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
