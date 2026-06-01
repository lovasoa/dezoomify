var lizardtech = (function () {
	function textContent(node) {
		return node && (node.textContent || node.innerText || "");
	}

	function requestParameter(doc, name) {
		var params = doc.getElementsByTagName("Parameter");
		for (var i = 0; i < params.length; i++) {
			if (params[i].getAttribute("name") === name) {
				return textContent(params[i]);
			}
		}
		return "";
	}

	function buildLevels(width, height) {
		var tileSize = 512;
		var levels = [];
		var level = 0;

		do {
			levels.push({ width: width, height: height, level: level, dx: 0, dy: 0 });
			width = Math.ceil(width / 2);
			height = Math.ceil(height / 2);
			level++;
		} while (2 * Math.max(width, height) > tileSize);

		levels.reverse();

		var size = tileSize;
		for (var i = 0; i < levels.length; i++, size *= 2) {
			levels[i].dx = (size - levels[i].width) / (2 * levels[i].width);
			levels[i].dy = (size - levels[i].height) / (2 * levels[i].height);
		}

		return levels;
	}

	return {
		name: "LizardTech ImageServer",
		description: "LizardTech ImageServer direct calcrgn URLs",
		urls: [
			/\/lizardtech\/iserv\/calcrgn\?/i
		],
		open: function (url) {
			ZoomManager.getFile(url, { type: "xml" }, function (doc) {
				var server = doc.getElementsByTagName("ImageServer")[0];
				var catalog = doc.getElementsByTagName("Catalog")[0];
				var image = doc.getElementsByTagName("Image")[0];
				if (!server || !catalog || !image) {
					return ZoomManager.error("Invalid LizardTech ImageServer XML: " + url);
				}

				var width = parseInt(image.getAttribute("width"));
				var height = parseInt(image.getAttribute("height"));
				if (!width || !height) {
					return ZoomManager.error("Missing LizardTech image dimensions: " + url);
				}

				var source = new URL(url);
				var host = server.getAttribute("host") || source.host;
				var path = (server.getAttribute("path") || "lizardtech/iserv").replace(/^\/|\/$/g, "");
				var item = requestParameter(doc, "item");
				if (!item) {
					var parent = image.getAttribute("parent");
					var name = image.getAttribute("name");
					item = parent ? parent + "/" + name : name;
				}

				var data = {
					origin: source.protocol + "//" + host + "/" + path + "/calcrgn",
					host: host,
					path: path,
					catalog: catalog.getAttribute("name") || requestParameter(doc, "cat"),
					item: item,
					width: width,
					height: height,
					numlevels: parseInt(image.getAttribute("numlevels")),
					tileSize: 512,
					maxZoomLevel: 0,
					levels: buildLevels(width, height),
				};
				data.maxZoomLevel = data.levels.length - 1;

				ZoomManager.readyToRender(data);
			});
		},
		getTileURL: function (x, y, zoom, data) {
			var level = data.levels[zoom];
			var centerX = ((x + 0.5) * data.tileSize) / level.width - level.dx;
			var centerY = ((y + 0.5) * data.tileSize) / level.height - level.dy;
			return (
				data.origin.replace(/\/calcrgn$/, "/getimage") +
				"?cat=" + encodeURIComponent(data.catalog) +
				"&item=" + encodeURIComponent(data.item) +
				"&wid=512&hei=512&oif=jpeg" +
				"&lev=" + level.level +
				"&cp=" + centerX + "," + centerY
			);
		}
	};
})();
ZoomManager.addDezoomer(lizardtech);
