var seadragon = (function () { //Code isolation

	return {
		"name": "Seadragon (Deep Zoom Image)",
		"description": "Microsoft zoomable image format, sometimes called DZI, seadragon, or deep zoom",
		"urls": [
			/bl\.uk\/manuscripts\/Viewer\.aspx/,
			/polona\.pl\/item\//,
			/bibliotheques-specialisees\.paris\.fr\/ark/,
			/nla\.gov\.au\/nla\.obj.*\/view$/,
			/_files\/\d+\/\d+_\d+.jpg$/,
			/dzi$/
		],
		"contents": [
			/dziUrlTemplate/,
			/[^"'()<>]+\.(?:dzi)/i,
			/schemas\.microsoft\.com\/deepzoom/,
			/zoom(?:\.it|hub.net)\/.*\.js/,
			/\b(dzi|DZI)\b/
		],
		"findFile": function getDZIFile(baseUrl, callback) {
			if (baseUrl.match(/\.xml|\.dzi/i)) {
				return callback(baseUrl);
			}

			// British Library
			if (baseUrl.indexOf("bl.uk/manuscripts/Viewer.aspx") > -1) {
				return callback(baseUrl
					.replace("Viewer.aspx", "Proxy.ashx")
					.replace(/ref=([^&]*)/, "view=$1.xml"));
			}

			// bibliothèques specialisées de la ville de Paris
			var parisMatch = baseUrl.match(/bibliotheques-specialisees.paris.fr\/ark:((?:\/\w+){3})(.*)/);
			if (parisMatch) {
				baseUrl = "https://bibliotheques-specialisees.paris.fr/in/imageReader.xhtml" +
					"?id=ark:" + parisMatch[1] +
					"&updateUrl=updateUrl1653" +
					"&ark=" + parisMatch[1] + parisMatch[2] +
					"&selectedTab=otherdocs";
			}

			// Polona.pl
			var polonaMatch = baseUrl.match(/polona.pl\/item\/(\d+)\/(\d+)/);
			if (polonaMatch) {
				var itemId = polonaMatch[1], pageId = parseInt(polonaMatch[2]);
				var resUrl = "http://polona.pl/resources/item/" + itemId + "/?format=json";
				ZoomManager.getFile(resUrl, { type: "json" }, function (res, xhr) {
					callback(res.pages[pageId].dzi_url);
				});
				return;
			}

			// national library of australia
			if (baseUrl.match(/nla\.gov\.au\/nla\.obj.*\/view$/)) {
				return callback(baseUrl.replace(/view\/?$/, "dzi"));
			}

			// A single tile URL
			var tileMatch = baseUrl.match(/(.*)_files\/\d+\/\d+_\d+.jpg$/);
			if (tileMatch) {
				// We need to detect whether the image is a dzi or an xml
				var decided_xml_dzi = false, possibilities = [tileMatch[1] + ".dzi", tileMatch[1] + ".xml"], errors = [];
				function error_callback(msg) {
					errors.push(msg);
					if (errors.length === possibilities.length)
						ZoomManager.error(
							"Unable to load the meta-information file: \n" +
							possibilities.map(function (p, i) { return "- " + p + ": " + errors[i] })
								.join("\n")
						);
				}
				return possibilities.forEach(function (url) {
					ZoomManager.getFile(url, { type: "xml", allow_failure: true, error_callback: error_callback }, function (xml) {
						if (!decided_xml_dzi && xml.getElementsByTagName("Image")) {
							decided_xml_dzi = true;
							callback(url);
						}
					});
				});
			}

			ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text, xhr) {
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
				var matchPath = text.match(/[^"'()<>]+\.(?:xml|dzi)/i);
				if (matchPath) return callback(matchPath[0]);

				// Try to find a link to a dzi file, (<dzi>link</dzi>, "dzi": "link", dzi="link")
				var dziLinkMatch = text.match(/[^a-z]dzi["'<>\s:=]+([^<"']*)/i);
				if (dziLinkMatch) return callback(dziLinkMatch[1]);

				return callback(baseUrl);
			});
		},
		"open": function (url) {
			ZoomManager.getFile(url, { type: "xml" }, function (xml, xhr) {
				var infos = xml.getElementsByTagName("Image")[0];
				var size = xml.getElementsByTagName("Size")[0];
				if (!infos || !size) return ZoomManager.error("Invalid seadragon XML info file: " + url);
				var data = {};

				if (url.match(/nla\.gov\.au\/.*\/dzi/)) {
					// national library of australia
					data.origin = url + "?tile=";
				} else {
					//replace extension by _files
					data.origin = url.replace(/\.[^.\/]*$/, '') + "_files/";
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
		"getTileURL": function (col, row, zoom, data) {
			return data.origin + zoom + "/" + col + "_" + row + "." + data.format;
		}
	};
})();
ZoomManager.addDezoomer(seadragon);
