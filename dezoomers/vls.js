var vls = (function() {
  return {
    name: 'VLS',
    description: 'Visual Library Server, by semantics',
    urls: [
      /\/(thumbview|pageview|zoom)\/\d+$/
    ],
    contents: [],
    findFile: function getInfoFile (baseUrl, callback) {
      var url = baseUrl.replace(/\/(thumbview|pageview|zoom)\//, '/zoom/');
      callback(url);
    },
    open: function (url) {
      ZoomManager.getFile(url, {type: 'xml'}, function (doc, xhr) {
        var vars = {};
        var varNodes = doc.getElementsByTagName('var');
        for (var i = 0; i < varNodes.length; i++) {
          vars[varNodes[i].getAttribute('id')] = varNodes[i].getAttribute('value');
        }
        var mapNode = doc.getElementById('map');

        var id = mapNode ? mapNode.getAttribute('vls:ot_id') : null;
        if (!id) {
          throw new Error('Unable to extract image ID');
        }
        var rotate = mapNode.getAttribute('vls:flip_rotate');
        var width = parseInt(mapNode.getAttribute('vls:width'));
        var height = parseInt(mapNode.getAttribute('vls:height'));
        var zoomLevels = mapNode.getAttribute('vls:zoomsizes').split(',');
        var path = ['/image/tile/wc', rotate, width, '1.0.0', id, zoomLevels.length - 1].join('/');
        var tileSize = parseInt(vars['zoomTileSize']);

        // Workaround: avoid cropping at the bottom
        height = (Math.floor((height - 1) / tileSize) + 1) * tileSize;

        ZoomManager.readyToRender({
          origin: url,
          path: path,
          width: width,
          height: height,
          tileSize: tileSize,
        });
      });
    },
    getTileURL: function (x, y, zoom, data) {
      return [data.path, x, (data.nbrTilesY - y - 1) + '.jpg'].join('/');
    },
  };
})();
ZoomManager.addDezoomer(vls);
