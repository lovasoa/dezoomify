var microsculpture = (function () { //Code isolation
	return {
		"name": "microsculpture.net",
		"description": "Zoomable insects (http://microsculpture.net)",
		"urls" : [/microsculpture\.net\//],
		"open" : function (url) {
			ZoomManager.getFile(url, {type:"htmltext"}, function (txt, xhr) {
				var data = {};
				data.tile_folder = txt.match(/tile-folder="(.*?)"/)[1];
				data.width = parseInt(txt.match(/map-bounds="(.*?)"/)[1]);
				data.height = data.width;
				data.tileSize = 256;
				data.maxZoomLevel = parseInt(txt.match(/max-zoom="(.*?)"/)[1]) - 1;
				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL" : function (x,y,z, data) {
			return "http://microsculpture.net/assets/img/tiles/" + data.tile_folder +
							"/x1/" + z + "/" + x + "/" + y + ".jpg";
		}
	};
})();
ZoomManager.addDezoomer(microsculpture);
