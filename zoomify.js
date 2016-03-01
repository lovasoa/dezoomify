var zoomify = (function () { //Code isolation
	return {
		"name": "Zoomify",
		"findFile" : function getZoomifyPath (baseUrl, callback) {
			if (baseUrl.endsWith("ImageProperties.xml")) {
				return callback(baseUrl);
			}
			function foundZoomifyPath(zoomifyPath) {
				return callback(zoomifyPath + "/ImageProperties.xml");
			}
			ZoomManager.getFile(baseUrl, "htmltext", function (text, xhr) {
				// for the zoomify flash player, the path is in the zoomifyImagePath
				// attribute of a tag
				// In the HTML5 zoomify player, the path is the second argument
				// to a JS function called showImage
				var matchPath = text.match(
					/zoomifyImagePath=([^\'"&]*)[\'"&]|showImage\([^),]*,\s*["']([^'"]*)/
				);
				if (matchPath) {
					for(var i=1;i<matchPath.length;i++)
						if (matchPath[i]) return foundZoomifyPath(matchPath[i]);
				}
				// Fluid engage zoomify
				var fluidMatch = text.match(/accessnumber=([\w.]+)/i);
				if (fluidMatch) {
					var xmlBrokerPath = "/scripts/XMLBroker.new.php" +
										"?Lang=2&contentType=IMAGES&contentID=" +
										fluidMatch[1];
					var url = ZoomManager.resolveRelative(xmlBrokerPath, baseUrl);
					return ZoomManager.getFile(url, "xml", function(xml, xhr){
						var pathElem = xml.querySelector("imagefile[format=zoomify]");
						return foundZoomifyPath(pathElem.firstChild.nodeValue);
					});
				}
				// If no zoomify path was found in the page, then assume that
				// the url that was given is the path itself
				return foundZoomifyPath(baseUrl);
			});
		},
		"open" : function (url) {
			ZoomManager.getFile(url, "xml", function (xml, xhr) {
				var infos = xml.getElementsByTagName("IMAGE_PROPERTIES")[0];
				if (!infos) return ZoomManager.error("Invalid zoomify XML info file: " + url);
				var data = {};
				data.origin = url;
				data.width = parseInt(infos.getAttribute("WIDTH"));
				data.height = parseInt(infos.getAttribute("HEIGHT"));
				data.tileSize = parseInt(infos.getAttribute("TILESIZE"));
				data.numTiles = parseInt(infos.getAttribute("NUMTILES")); //Total number of tiles (for all zoom levels)
				data.zoomFactor = 2; //Zooming factor between two consecutive zoom levels

				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL" : function (col, row, zoom, data) {
			var totalTiles = data.nbrTilesX * data.nbrTilesY;
			var tileGroup = Math.floor((data.numTiles - totalTiles + col + row*data.nbrTilesX) / 256);
			return "TileGroup" + tileGroup + "/" + zoom + "-" + col + "-" + row + ".jpg";
		}
	};
})();
ZoomManager.addDezoomer(zoomify);
ZoomManager.setDezoomer(zoomify);
