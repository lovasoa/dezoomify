var seadragon = (function () { //Code isolation

	return {
		"name" : "Seadragon (Deep Zoom Image)",
		"findFile" : function getDZIFile (baseUrl, callback) {
			if (baseUrl.match(/\.xml|\.dzi/i)) {
				return callback(baseUrl);
			}

			// British Library
			if (baseUrl.indexOf("bl.uk/manuscripts/Viewer.aspx") > -1) {
				return callback(baseUrl
													.replace("Viewer.aspx","Proxy.ashx")
													.replace(/ref=([^&]*)/, "view=$1.xml"));
			}

			ZoomManager.getFile(baseUrl, "text", function (text, xhr) {
				// World digital library
				var wdlMatch = baseUrl.match(/view\/(\d+)\/(\d+)/);
				if (wdlMatch && text.match("dziUrlTemplate")) {
					var group = parseInt(wdlMatch[1]);
					var index = parseInt(wdlMatch[2]);
					var m = text.match(/"([^"]+\.dzi)"/i);
					var url = m[1].replace("{group}", group).replace("{index}", index);
					return callback(url);
				}
				// Any url ending with .xml or .dzi
				var matchPath = text.match(
					/[\w\/]+\.(?:(?:xml)|(?:dzi))/i
				);
				if (matchPath) {
					return callback(matchPath[0]);
				}
				return callback(baseUrl);
			});
		},
		"open" : function (url) {
			ZoomManager.getFile(url, "xml", function (xml, xhr) {
				var infos = xml.getElementsByTagName("Image")[0];
				if (!infos) {
					ZoomManager.error();
					console.log(xml);
				}
				var size = xml.getElementsByTagName("Size")[0];
				var data = {};

				//replace extension by _files
				data.origin = url.replace(/\.[^.\/]*$/,'') + "_files/";
				data.tileSize = parseInt(infos.getAttribute("TileSize"));
				data.overlap = parseInt(infos.getAttribute("Overlap"));
				data.format = infos.getAttribute("Format");

				data.width = parseInt(size.getAttribute("Width"));
				data.height = parseInt(size.getAttribute("Height"));

				//Zooming factor between two consecutive zoom levels
				data.zoomFactor = 2;
				// 2^maxzoom = max(w,h) (the first tile is 1x1)
				data.maxZoomLevel = Math.ceil(
						Math.log2(Math.max(data.width, data.height))
				);
				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL" : function (col, row, zoom, data) {
			return zoom + "/" + col + "_" + row + "." + data.format;
		}
	};
})();
ZoomManager.addDezoomer(seadragon);
