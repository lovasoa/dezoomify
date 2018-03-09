var topviewer = (function(){
	var memorixThumbnailRegexp = /(?:images\.memorix|afbeeldingen\.gahetna|images\.rkd)\.nl\/(.*?)\/thumb\/(?:image(?:bank)?-)?(?:[0-9x]*?(?:crop)?|detailresult|gallery_thumb|mediabank-(?:detail|horizontal))\/(.*?)\.jpg/;
	return {
		"name" : "TopViewer",
		"description": "Memorix viewer, or topviewer, by picturae. Used on dutch websites.",
		"urls": [
			/memorix\.nl\/.+\/topviewjson\/memorix/,
			/rhcrijnstreek\.nl/
		],
		"contents": [
			memorixThumbnailRegexp
		],
		"findFile" : function findTopViewer(baseUrl, callback) {
			function foundData(server_name, image) {
				if (server_name == 'rkd'){
					return callback('https://images.rkd.nl/rkd/topviewjson/memorix/'+image);
				}
				return callback('http://images.memorix.nl/'+server_name+'/topviewjson/memorix/'+image);
			}
			if (baseUrl.match(/memorix\.nl\/.+\/topviewjson\/memorix/)) {
				return callback(baseUrl);
			}
			// rhcrijnstreek.nl
			var rhcMatch = baseUrl.match(/rhcrijnstreek\.nl.*(?:asset=|media\/)([a-f0-9\-]+)/);
			if (rhcMatch) {
				return foundData("srs", rhcMatch[1]);
			}
			ZoomManager.getFile(baseUrl, {type:"htmltext"}, function(text, xhr) {
				// Memorix image thumbnail
				var thumbMatch = text.match(memorixThumbnailRegexp);
				if (thumbMatch) {
					return foundData(thumbMatch[1], thumbMatch[2]);
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
