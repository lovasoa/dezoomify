var seadragon = (function () { //Code isolation

	return {
		"name" : "Seadragon (Deep Zoom Image)",
		"description" : "Microsoft zoomable image format, sometimes called DZI, seadragon, or deep zoom",
		"urls" : [
			/bl\.uk\/manuscripts\/Viewer\.aspx/,
			/polona\.pl\/item\//,
			/bibliotheques-specialisees\.paris\.fr\/ark/,
			/nla\.gov\.au\/nla\.obj.*\/view$/,
			/dzi$/
		],
		"contents" : [
			/dziUrlTemplate/,
			/[^"'()<>]+\.(?:dzi)/i,
			/schemas\.microsoft\.com\/deepzoom/,
			/zoom(?:\.it|hub.net)\/.*\.js/,
			/\b(dzi|DZI)\b/
		],
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

			// Polona.pl
			var polonaMatch = baseUrl.match(/polona.pl\/item\/(\d+)\/(\d+)/);
			if (polonaMatch) {
				var itemId = polonaMatch[1], pageId = parseInt(polonaMatch[2]);
				var resUrl = "http://polona.pl/resources/item/"+itemId+"/?format=json";
				ZoomManager.getFile(resUrl, {type:"json"}, function(res, xhr) {
					callback(res.pages[pageId].dzi_url);
				});
				return;
			}

			// national library of australia
			if (baseUrl.match(/nla\.gov\.au\/nla\.obj.*\/view$/)) {
				return callback(baseUrl.replace(/view\/?$/, "dzi"));
			}

			ZoomManager.getFile(baseUrl, {type:"htmltext"}, function (text, xhr) {
				// World digital library
				var wdlMatch = baseUrl.match(/view\/(\d+)\/(\d+)/);
				if (wdlMatch && text.match("dziUrlTemplate")) {
					var group = parseInt(wdlMatch[1]);
					var index = parseInt(wdlMatch[2]);
					var m = text.match(/"([^"]+\.dzi)"/i);
					var url = m[1].replace("{group}", group).replace("{index}", index);
					return callback(url);
				}

				// Zoom.it
				var zoomitMatch = text.match(/zoom(?:\.it|hub.net)\/(.*?)\.js/);
				if (zoomitMatch) {
					return callback("http://content.zoomhub.net/dzis/" + zoomitMatch[1] + ".dzi");
				}

				// bibliothèques specialisées de la ville de Paris
				var parisMatch = text.match(/deepZoomManifest['"]\s*:\s*["']([^"']*)/);
				if (parisMatch) return callback(parisMatch[1]);

				// Any url ending with .xml or .dzi
				var matchPath = text.match(/[^"'()<>]+\.(?:xml|dzi)/i);
				if (matchPath) return callback(matchPath[0]);

				// Try to find a link to a dzi file, (<dzi>link</dzi>, "dzi": "link", dzi="link")
				var dziLinkMatch = text.match(/[^a-z]dzi["'<>\s:=]+([^<"']*)/i);
				if (dziLinkMatch) return callback(dziLinkMatch[1]);

				return callback(baseUrl);
			});
		},
		"open" : function (url) {
			ZoomManager.getFile(url, {type:"xml"}, function (xml, xhr) {
				var infos = xml.getElementsByTagName("Image")[0];
				var size = xml.getElementsByTagName("Size")[0];
				if (!infos || !size) return ZoomManager.error("Invalid seadragon XML info file: " + url);
				var data = {};

				if (url.match(/nla\.gov\.au\/.*\/dzi/)) {
					// national library of australia
					data.origin = url + "?tile=";
				} else {
					//replace extension by _files
					data.origin = url.replace(/\.[^.\/]*$/,'') + "_files/";
				}
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
			return data.origin + zoom + "/" + col + "_" + row + "." + data.format;
		}
	};
})();
ZoomManager.addDezoomer(seadragon);
