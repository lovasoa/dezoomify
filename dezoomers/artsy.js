// Artsy uses seadragon, but they have their own image info format
var artsy = (function () { //Code isolation

	return {
		"name" : "Artsy",
		"description" : "Zoomable images used on artsy.net",
		"urls" : [
			/artsy\.net/
		],
		"contents" : [
		],
		"findFile" : function getAPIFile (baseUrl, callback) {
			var info_url_base = "https://fusion.artsy.net/api/v1/artwork/";
			if (baseUrl.indexOf(info_url_base) === 0) {
				return callback(baseUrl);
			}
			var artsyMatch = baseUrl.match(/artwork\/([^\/]+)/);
			if (artsyMatch) {
				return callback(info_url_base + artsyMatch[1]);
			}
			return ZoomManager.error("Invalid artsy URL: " + baseUrl);
		},
		"open" : function (url) {
			ZoomManager.getFile(url, "json", function (info, xhr) {
				var data = {};
				var image = info["images"][0];

				data.origin = image.tile_base_url + '/';
				data.tileSize = image.tile_size;
				data.overlap = image.tile_overlap;
				data.format = image.tile_format;

				data.width = image.max_tiled_width;
				data.height = image.max_tiled_height;
				data.baseZoomLevel = Math.log2(data.tileSize);

				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL" : function (col, row, zoom, data) {
			return zoom + "/" + col + "_" + row + "." + data.format;
		}
	};
})();
ZoomManager.addDezoomer(artsy);
