var seadragon = (function () { //Code isolation

	return {
		"name": "krpano",
		"description": "krpano Panorama Viewer: Mainly used in panoramic images and interactive virtual tours.",
		"urls": [
			/hyper-photo\.com\/hyperpano/,
			/krpano\.com/
		],
		"contents": [
			/embedpano\(\s*\{/,
			/krpano/
		],
		"findFile": function getDZIFile(baseUrl, callback) {
			ZoomManager.getFile(baseUrl, { type: "htmltext" }, function (text, xhr) {
				// Any xml url within a call to embedpano
				var matchPath = text.match(
					/embedpano\(\s*\{[\s\S]*xml.?\s*:\s*\\?["']([^"'\\]*)/
				);
				if (matchPath) {
					return callback(matchPath[1]);
				}
				return callback(baseUrl);
			});
		},
		"open": function (firstUrl) {
			var urls = [firstUrl];
			function processNextUrl() {
				var url = urls.shift();
				if (!url) {
					throw new Error("Unable to find level information in the image");
				}
				url = ZoomManager.resolveRelative(url, firstUrl);
				ZoomManager.getFile(url, { type: "xml" }, function (xml, xhr) {
					var includes = xml.getElementsByTagName("include");
					for (var i = 0; i < includes.length; i++) {
						urls.push(includes[i].getAttribute("url"));
					}

					var images = xml.getElementsByTagName("image");
					var levels = [];
					for (var i = 0; i < images.length; i++) {
						var baseIndex = images[i].getAttribute("baseindex");
						baseIndex = baseIndex ? parseInt(baseIndex) : 1;
						var children = images[i].children;
						for (var j = 0; j < children.length; j++) {
							var el = children[j];
							var multires = el.getAttribute("multires");
							if (multires) {
								var parts = multires.split(',');
								var tileSize = parseInt(parts.shift());
								for (var k = 0; k < parts.length; k++) {
									var x = parts[k].split("x");
									levels.push({
										width: x[0] | 0,
										height: x[1] | 0,
										tileSize: (x[2] | 0) || tileSize,
										url: el.getAttribute("url"),
										baseIndex: baseIndex,
										levelIndex: k + baseIndex,
									})
								}
							} else if (el.tagName.toLowerCase() === "level") {
								levels.push({
									width: el.getAttribute("tiledimagewidth") | 0,
									height: el.getAttribute("tiledimageheight") | 0,
									tileSize: images[i].getAttribute("tilesize") | 0,
									url: el.children[0].getAttribute("url"),
									baseIndex: baseIndex,
									levelIndex: j + baseIndex,
								})
							}
						}
					}
					if (levels.length === 0) return processNextUrl();
					var data = levels.reduce(function (previous, current) {
						return previous.width > current.width ? previous : current;
					});
					data.origin = firstUrl;
					data.nbrTilesX = Math.round(data.width / data.tileSize);
					data.nbrTilesY = Math.round(data.height / data.tileSize);
					ZoomManager.readyToRender(data);
				});
			}
			processNextUrl();
		},
		"getTileURL": function (col, row, zoom, data) {
			col += data.baseIndex; row += data.baseIndex;
			function replacer(match, zeroes, letter) {
				var val = ({
					h: col, x: col, u: col, c: col,
					v: row, y: row, r: row,
					l: data.levelIndex, // level
					s: "f", // side of the cube
					f: "1", // frame
					'%': '%',
				}[letter]).toString();
				while (val.length < zeroes.length) val = "0" + val;
				return val;
			}
			return data.url.replace(/%(0*([a-z%]))/g, replacer);
		}
	};
})();
ZoomManager.addDezoomer(seadragon);
