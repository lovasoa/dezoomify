var zoomify = (function () { //Code isolation
	return {
		"name": "Google Arts & Culture",
		"description": "Zommable images from artsandculture.google.com",
		"urls": [
			/artsandculture\.google\.com/,
		],
		"contents": [],
		"findFile": function getXMLPath(baseUrl, callback) {
			ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text, xhr) {
				var matchPath = text.match(
					/<meta property="og:image" content="([^"]+)">/
				);
				if (matchPath) return callback(matchPath[1] + "=g");
			});
		},
		"open": function (url) {
			ZoomManager.getFile(url, { type: "xml" }, function (xml, xhr) {
				var infos = xml.getElementsByTagName("TileInfo")[0];
				if (!infos) return ZoomManager.error("Invalid XML info file: " + url);
				var tile_w = parseInt(infos.getAttribute("tile_width"));
				var tile_h = parseInt(infos.getAttribute("tile_height"));
				var level_num = infos.children.length - 1;
				var level = infos.children[level_num];
				var xtiles = parseInt(level.getAttribute("num_tiles_x"));
				var ytiles = parseInt(level.getAttribute("num_tiles_y"));
				var empty_x = parseInt(level.getAttribute("empty_pels_x"));
				var empty_y = parseInt(level.getAttribute("empty_pels_y"));
				var data = {
					origin: url,
					width: xtiles * tile_w - empty_x,
					height: ytiles * tile_h - empty_y,
					tileSize = tile_w,
					numTiles: xtiles * ytiles,
					maxZoomLevel: level_num,
				}
				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL": function (col, row, zoom, data) {
			var totalTiles = data.nbrTilesX * data.nbrTilesY;
			var tileGroup = Math.floor((data.numTiles - totalTiles + col + row * data.nbrTilesX) / 256);
			return "TileGroup" + tileGroup + "/" + zoom + "-" + col + "-" + row + ".jpg";
		}
	};
})();
ZoomManager.addDezoomer(zoomify);
