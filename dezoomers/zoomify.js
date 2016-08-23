var zoomify = (function () { //Code isolation
	return {
		"name": "Zoomify",
		"description": "Most commmon zoomable image format",
		"urls": [
			/ImageProperties\.xml$/,
			/biblio\.unibe\.ch\/web-apps\/maps\/zoomify\.php/,
			/bspe-p-pub\.paris\.fr\/MDBGED\/zoomify-BFS\.aspx/
		],
		"contents": [
			/zoomifyImagePath=/,
			/showImage\(/,
			/accessnumber=/,
			/ete-openlayers-src/
		],
		"findFile" : function getZoomifyPath (baseUrl, callback) {
			if (baseUrl.match(/ImageProperties\.xml$/)) {
				return callback(baseUrl);
			}
			function foundZoomifyPath(zoomifyPath) {
				return callback(zoomifyPath + "/ImageProperties.xml");
			}

			// Portail des bibliothèques spécialisées de la ville de Paris
			if (baseUrl.indexOf("bspe-p-pub.paris.fr/MDBGED/zoomify") > -1 &&
					ZoomManager.cookies.indexOf("ASP.NET_SessionId") === -1) {
				// See https://github.com/lovasoa/dezoomify/issues/37
				// We need to do a first request in order to get a cookie
				var cookieurl = "http://bspe-p-pub.paris.fr/MDBGED/Main.aspx?profile=internet&Lang=FRE&accesspoint=complet&zone=25";
				return ZoomManager.getFile(cookieurl, {}, function() {
					// We now have the right cookie, and can start the process again
					getZoomifyPath(baseUrl, callback);
				});
			}

			ZoomManager.getFile(baseUrl, {type:"htmltext"}, function (text, xhr) {
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
				var fluidMatch = text.match(/accessnumber=([^"&\s']+)/i);
				if (fluidMatch) {
					var xmlBrokerPath = "/scripts/XMLBroker.new.php" +
										"?Lang=2&contentType=IMAGES&contentID=" +
										fluidMatch[1];
					var url = ZoomManager.resolveRelative(xmlBrokerPath, baseUrl);
					return ZoomManager.getFile(url, {type:"xml"}, function(xml, xhr){
						var pathElem = xml.querySelector("imagefile[format=zoomify]");
						return foundZoomifyPath(pathElem.firstChild.nodeValue);
					});
				}
				// Universitätsbibliothek
				var unibeMatch = text.match(/url = '([^']*)'/);
				if (~baseUrl.indexOf("biblio.unibe.ch/web-apps/maps/zoomify.php") &&
						unibeMatch) {
					var url = ZoomManager.resolveRelative(unibeMatch[1], baseUrl);
					return foundZoomifyPath(url);
				}
				
				// Openlayers
				var olMatch = text.match(/<[^>]*class="ete-openlayers-src"[^>]*>(.*?)<\/.*>/);
				if (olMatch) {
					return foundZoomifyPath(olMatch[1]);
				}
				// If nothing was found, but the page contains an iframe, follow the iframe
				var iframeMatch = text.match(/<iframe[^>]*src=["']([^"']*)/);
				if (iframeMatch) {
					var url = ZoomManager.resolveRelative(iframeMatch[1], baseUrl);
					return getZoomifyPath(url, callback);
				}
				// If no zoomify path was found in the page, then assume that
				// the url that was given is the path itself
				return foundZoomifyPath(baseUrl);
			});
		},
		"open" : function (url) {
			ZoomManager.getFile(url, {type:"xml"}, function (xml, xhr) {
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
