var topviewer = (function(){
	var memorixThumbnailRegexp = /(?:images\.memorix|afbeeldingen\.gahetna|images\.rkd)\.nl\/(.*?)\/thumb\/(?:image(?:bank)?-)?(?:[0-9x]*?(?:crop)?|detailresult|gallery_thumb|mediabank-(?:detail|horizontal))\/(.*?)\.jpg/;
	// Institution mappings adapted from VDK/Dememorixer's beeldbanken.json (GPL-2.0):
	// https://github.com/VDK/Dememorixer/blob/master/beeldbanken.json
	var memorixSites = [
		{ url: /beeldbankgroningen\.nl\/beelden/, imageServer: "gra" },
		{ url: /salha\.nl\/bronnen\/fotos-en-films\/foto-s/, imageServer: "sha" },
		{ url: /archief\.zaanstad\.nl\/mediabank\/zoek-in-de-beeldbank/, imageServer: "zaa" },
		{ url: /erfgoedcentrumzutphen\.nl\/onderzoeken\/beeldbank/, imageServer: "szu" },
		{ url: /noord-hollandsarchief\.nl\/beelden\/beeldbank/, imageServer: "ranh" },
	];
	var memorixDetailPath = "\\/detail\\/[a-z0-9-]{32,36}\\/media\\/([a-z0-9-]{36})";
	var memorixDetailUrls = memorixSites.map(function (site) {
		return new RegExp(site.url.source + memorixDetailPath, "i");
	});

	function knownMemorixFile(baseUrl) {
		for (var i = 0; i < memorixDetailUrls.length; i++) {
			var match = baseUrl.match(memorixDetailUrls[i]);
			if (match) {
				return "https://images.memorix.nl/" + memorixSites[i].imageServer +
					"/topviewjson/memorix/" + match[1];
			}
		}
		return null;
	}

	function findMediaBank(baseUrl, text, callback) {
		var doc = new DOMParser().parseFromString(text, "text/html");
		var element = doc.querySelector("pic-mediabank[data-api-key][data-api-url]");
		if (!element) return false;

		var pageUrl = new URL(baseUrl);
		var detailMatch = pageUrl.pathname.match(/\/detail\/([^/]+)(?:\/media\/([^/]+))?/);
		var apiUrl = new URL(element.getAttribute("data-api-url"), baseUrl);
		apiUrl.pathname = apiUrl.pathname.replace(/\/?$/, "/media" +
			(detailMatch ? "/" + encodeURIComponent(detailMatch[1]) : ""));
		if (!detailMatch) {
			["q", "page", "fq[]", "sort"].forEach(function (name) {
				pageUrl.searchParams.getAll(name).forEach(function (value) {
					apiUrl.searchParams.append(name, value);
				});
			});
			apiUrl.searchParams.set("rows", "1");
		}
		apiUrl.searchParams.set("apiKey", element.getAttribute("data-api-key"));
		var entities = element.getAttribute("data-entities");
		if (entities) apiUrl.searchParams.set("entities[0]", entities);

		ZoomManager.getFile(apiUrl.href, {type:"json"}, function (info) {
			var media = info.media && info.media[0];
			var assets = media && media.asset;
			for (var i = 0; assets && i < assets.length; i++) {
				if ((!detailMatch || !detailMatch[2] || assets[i].uuid === detailMatch[2]) && assets[i].topview) {
					return callback(assets[i].topview);
				}
			}
			throw new Error("No zoomable image found in Memorix response.");
		});
		return true;
	}

	return {
		"name" : "TopViewer",
		"description": "Memorix viewer, or topviewer, by picturae. Used on dutch websites.",
		"urls": [
			/memorix/,
			/topview\.?json/,
		].concat(memorixDetailUrls),
		"contents": [
			memorixThumbnailRegexp,
			/<pic-mediabank\b/i,
			/"topviews"\s*:/
		],
		"findFile" : function findTopViewer(baseUrl, callback) {
			function foundData(server_name, image) {
				if (server_name == 'rkd'){
					return callback('https://images.rkd.nl/rkd/topviewjson/memorix/'+image);
				}
				return callback('https://images.memorix.nl/'+server_name+'/topviewjson/memorix/'+image);
			}
			if (baseUrl.match(/memorix\.nl\/.+\/topviewjson\/memorix/)) {
				return callback(baseUrl);
			}
			var knownFile = knownMemorixFile(baseUrl);
			if (knownFile) return callback(knownFile);
			ZoomManager.getFile(baseUrl, {type:"htmltext"}, function(text, xhr) {
				if (findMediaBank(baseUrl, text, callback)) return;
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
