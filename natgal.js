var nationalgallery = (function(){
	var PHPSCRIPT = "proxy.php";

	function getObfuscatedTileId (id, zoom, row, col) {
		var repl = "vRfOdXapKz";
		var num = "0000000" + (row*1e9 + id*1e4 + col*1e2 + zoom), res='';
		for (var i=num.length-1; i>num.length-12; i--) res = repl[num[i]] + res;
		return res;
	}

	return {
		"name" : "National Gallery",
		"open" : function (url) {
			var codedurl = encodeURIComponent(url);

			var base = url.split("/").slice(0,3).join("/");
			var path = base + "/custom/ng/tile.php?id=";

			var xhr = new XMLHttpRequest();
			xhr.open("GET", PHPSCRIPT + "?url=" + codedurl, true);
			xhr.responseType = "document";

			xhr.onloadstart = function () {
				ZoomManager.updateProgress(0, "Sent a request in order to get informations about the image...");
			};
			xhr.onerror = function (e) {
				console.log("XHR error", e);
				ZoomManager.error();
			};
			xhr.onloadend = function () {
				var doc = xhr.response;
				var dataElems = doc.querySelectorAll(".data dt");
				if (dataElems.length===0) ZoomManager.error("No valid zoomify information found.");
				var rawdata = {};
				for (var i=0; i<dataElems.length; i++) {
					rawdata[dataElems[i].textContent] = dataElems[i].nextElementSibling.textContent;
				}
				var data = {
					"width" : Math.round(rawdata.width),
					"height" : Math.round(rawdata.height),
					"tileSize" : parseInt(rawdata.tileSize),
					"maxZoomLevel" : parseInt(rawdata.max),
					"contentId" : parseInt(rawdata.contentId),
					"path" : path
				};

				ZoomManager.readyToRender(data);
			};
			xhr.send(null);
		},
		"getTileURL" : function (col, row, zoom, data) {
			return data.path + getObfuscatedTileId(data.contentId, zoom, row, col);
		}
	};
})();
ZoomManager.addDezoomer(nationalgallery);
