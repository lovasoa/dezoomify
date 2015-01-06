var seadragon = (function () { //Code isolation

	return {
		"name" : "Seadragon (Deep Zoom Image)",
		"open" : function (url) {
			ZoomManager.getFile(url, "xml", function (xml, xhr) {
				var infos = xml.getElementsByTagName("Image")[0];
				if (!infos) {
					ZoomManager.error();
					console.log(xml);
				}
				var size = xml.getElementsByTagName("Size")[0];
				var data = {};

				data.path = url.replace(/\.[^.\/]*$/,'') + "_files"; //replace extension by _files
				data.tileSize = parseInt(infos.getAttribute("TileSize"));
				data.overlap = parseInt(infos.getAttribute("Overlap"));
				data.format = infos.getAttribute("Format");

				data.width = parseInt(size.getAttribute("Width"));
				data.height = parseInt(size.getAttribute("Height"));

				data.zoomFactor = 2; //Zooming factor between two consecutive zoom levels
				data.maxZoomLevel = Math.ceil(Math.log2(Math.max(data.width, data.height)));

				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL" : function (col, row, zoom, data) {
			return data.path + "/" + zoom + "/" + col + "_" + row + "." + data.format;
		}
	};
})();
ZoomManager.addDezoomer(seadragon);
