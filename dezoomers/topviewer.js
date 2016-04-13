var topviewer = (function(){
	return {
		"name" : "TopViewer",
		"description": "Memorix viewer, or topviewer, by picturae. Used on dutch websites.",
		"urls": [/memorix\.nl\/.+\/topviewjson\/memorix/],
		"contents": [
			/(?:images\.memorix|afbeeldingen\.gahetna)\.nl\/([a-z\-_]{3,6})\/thumb\/(?:image(?:bank)?-)?(?:[0-9]{2,3}x[0-9]{2,3}(?:crop)?|detailresult|gallery_thumb|mediabank-(?:detail|horizontal))\/(.*?)\.jpg/
		],
		"findFile" : function findTopViewer(baseUrl, callback) {
			// Daguerreobase
			if (baseUrl.match(/memorix\.nl\/.+\/topviewjson\/memorix/)) {
				return callback(baseUrl);
			}
			ZoomManager.getFile(baseUrl, {type:"htmltext"}, function(text, xhr) {
				// Memorix image thumbnail
				var thumbMatch = text.match(/(?:images\.memorix|afbeeldingen\.gahetna)\.nl\/([a-z\-_]{3,6})\/thumb\/(?:image(?:bank)?-)?(?:[0-9]{2,3}x[0-9]{2,3}(?:crop)?|detailresult|gallery_thumb|mediabank-(?:detail|horizontal))\/(.*?)\.jpg/);
				if (thumbMatch) {
					return callback('http://images.memorix.nl/'+thumbMatch[1]+'/topviewjson/memorix/'+thumbMatch[2]);
				}
				// Direct server indication
				var serverMatch = text.match(/["']?server["']?\s*:\s*(["'][^"']+["'])/);
				if (serverMatch) {
					var url = JSON.parse(serverMatch[1]);
					url = ZoomManager.resolveRelative(url, baseUrl);
					return callback(url);
				}
				// Nothing was found
				callback(baseUrl);
			});
		},
		"open" : function (url) {
			ZoomManager.getFile(url, {type:"json"}, function (info, xhr) {
				if (!info.topviews || !info.config) throw new Error("Invalid Topviewer file");
				var view = info.topviews[0];
				var tileurl_tpl = info.config.tileurl_v2
																.replace("{file}", view.filepath)
																.replace("{extension}", "jpg");
				var maxLevel = view.layers[0];
				for (var i = 0; i < view.layers.length; i++) {
					if (view.layers[i].width > maxLevel.width) maxLevel = view.layers[i];
				}
				var data = {
					"origin": url,
					"width" : view.width,
					"height" : view.height,
					"tileSize" : view.tileWidth,
					"maxZoomLevel" : maxLevel.no,
					"maxLevel" : maxLevel.no,
					"tileurl_tpl" : tileurl_tpl,
					"firsttile" : maxLevel.starttile,
					"cols" : maxLevel.cols
				};

				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL" : function (col, row, zoom, data) {
			var tile = data.firsttile + col + row * data.cols;
			return data.tileurl_tpl.replace("{tile}", tile);
		}
	};
})();
ZoomManager.addDezoomer(topviewer);
