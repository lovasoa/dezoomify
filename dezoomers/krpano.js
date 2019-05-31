var seadragon = (function () { //Code isolation

	return {
		"name" : "krpano",
		"description" : "krpano Panorama Viewer: Mainly used in panoramic images and interactive virtual tours.",
		"urls" : [
			/hyper-photo\.com\/hyperpano/,
			/krpano\.com/
		],
		"contents" : [
			/embedpano\(\s*\{/
		],
		"findFile" : function getDZIFile (baseUrl, callback) {
			ZoomManager.getFile(baseUrl, {type:"htmltext"}, function (text, xhr) {
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
		"open" : function (firstUrl) {
			var urls = [firstUrl];
			function processNextUrl() {
				var url = urls.shift();
				if (!url) {
						throw new Error("Unable to find level information in the image");
				}
				url = ZoomManager.resolveRelative(url, firstUrl);
				ZoomManager.getFile(url, {type:"xml"}, function (xml, xhr) {
					var includes = xml.getElementsByTagName("include");
					for (var i = 0; i < includes.length; i++) {
						urls.push(includes[i].getAttribute("url"));
					}

					var levels = xml.getElementsByTagName("level");
					if (levels.length === 0) return processNextUrl();
					function getLevelSize(level) {
						var w = parseInt(level.getAttribute("tiledimagewidth"));
						var h = parseInt(level.getAttribute("tiledimageheight"));
						if (isNaN(w*h)) {
							throw new Error("Level has no valid size information");
						}
						return [w,h];
					}
					var maxsize = getLevelSize(levels[0]), maxlevel = levels[0];
					for (var i = 1; i < levels.length; i++) {
						var size = getLevelSize(levels[i]);
						if (size[0]*size[1] > maxsize[0]*maxsize[1]) {
							maxsize = size;
							maxlevel = levels[i];
						}
					}
					var data = {};

					//replace extension by _files
					data.tileSize = parseInt(maxlevel.parentElement.getAttribute("tilesize"));
					data.width = maxsize[0];
					data.height = maxsize[1];
					data.origin = firstUrl;
					data.url = maxlevel.firstElementChild.getAttribute("url");
					ZoomManager.readyToRender(data);
				});
			}
			processNextUrl();
		},
		"getTileURL" : function (col, row, zoom, data) {
			col++; row++; // They count from 1
			function replacer(match, zeroes, letter) {
					var val = ({
						h:col, x:col, u:col, c:col,
						v:row, y:row, r:row,
						s:"f"
					}[letter]).toString();
					while(val.length < zeroes.length) val = "0" + val;
					return val;
			}
			return data.url.replace(/%(0*([a-z]))/g, replacer);
		}
	};
})();
ZoomManager.addDezoomer(seadragon);
