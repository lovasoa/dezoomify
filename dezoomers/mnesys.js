var mnesys = (function () { //Code isolation
    return {
        "name": "Mnesys",
        "description": "Mnesys image viewer by naoned",
        "urls": [
            /\/datas\/playlists\/.*\.xml(\?.*)?$/,
            /\/p.xml$/
        ],
        "contents": [
            /naoned_viewer/,
            /flashVars.*playlist=.*\.xml/
        ],
        "findFile": function getZoomifyPath(baseUrl, callback) {
            if (baseUrl.match(/\/p\.xml(\?.*)?$/)) {
                return callback(baseUrl);
            }
            function playlist(url) {
                ZoomManager.getFile(url, { type: "xml" }, function (doc, xhr) {
                    var playlist = doc.getElementsByTagName("playlist")[0];
                    if (!playlist) throw new Error("Invalid mnesys playlist");
                    var base = playlist.getAttribute("host") + playlist.getAttribute("basepath");
                    var pages = playlist.getElementsByTagName("a");
                    var pagenum = parseInt((baseUrl.match(/img_num=(\d+)/) || [0, 0])[1]);
                    var page = pages[pagenum];
                    var pxml = page.textContent.replace('.', '_') + '_/p.xml';
                    return callback(base + pxml);
                });
            }
            if (baseUrl.match(/\/playlists\/.*\.xml(\?.*)?$/)) {
                return playlist(baseUrl);
            }
            return ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text, xhr) {
                var match = text.match(/flashVars.*playlist=([^&'"]*)/);
                if (!match) throw new Error("Unable to find a mnesys viewer information file");
                return playlist(ZoomManager.resolveRelative(match[1], baseUrl));
            });
        },
        "open": function (url) {
            ZoomManager.getFile(url, { type: "xml" }, function (doc, xhr) {
                var layers = doc.getElementsByTagName("layer");
                if (layers.length === 0) throw new Error("No layer in image");
                var bestLayerIdx = 0, bestZ = parseInt(layers[0].getAttribute("z"));
                for (var i = 0; i < layers.length; i++) {
                    var layer = layers[i];
                    var z = parseInt(layer.getAttribute("z"));
                    if (z > bestZ) {
                        bestLayerIdx = i;
                        bestZ = z;
                    }
                }
                var bestLayer = layers[bestLayerIdx];
                var data = {
                    width: parseInt(bestLayer.getAttribute("w")),
                    height: parseInt(bestLayer.getAttribute("h")),
                    tileSize: parseInt(bestLayer.getAttribute("t")),
                    origin: url,
                    maxZoomLevel: bestLayerIdx,
                };
                ZoomManager.readyToRender(data);
            });
        },
        "getTileURL": function (x, y, z, data) {
            var index = x + y * data.nbrTilesX;
            return z + "_" + index + ".jpg";
        }
    };
})();
ZoomManager.addDezoomer(mnesys);
