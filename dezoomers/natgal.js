var nationalgallery = (function(){
	function getObfuscatedTileId (id, zoom, row, col) {
		var repl = "vRfOdXapKz";
		var num = "0000000" + (row*1e9 + id*1e4 + col*1e2 + zoom), res='';
		for (var i=num.length-1; i>num.length-12; i--) res = repl[num[i]] + res;
		return res;
	}

	return {
		"name" : "National Gallery",
		"description": "The national gallery of London",
		"urls" : [/nationalgallery\.co\.uk/],
		"open" : function (url) {
			ZoomManager.getFile(url, {type:"xml"}, function (doc, xhr) {
				var dataElems = doc.querySelectorAll(".data dt");
				if (dataElems.length===0)
					ZoomManager.error("No valid zoomify information found.");
				var rawdata = {};
				for (var i=0; i<dataElems.length; i++) {
					var name = dataElems[i].textContent;
					rawdata[name] = dataElems[i].nextElementSibling.textContent;
				}
				var data = {
					"origin": url,
					"width" : Math.round(rawdata.width),
					"height" : Math.round(rawdata.height),
					"tileSize" : parseInt(rawdata.tileSize),
					"maxZoomLevel" : parseInt(rawdata.max),
					"contentId" : parseInt(rawdata.contentId),
				};

				ZoomManager.readyToRender(data);
			});
		},
		"getTileURL" : function (col, row, zoom, data) {
			var tileId = getObfuscatedTileId(data.contentId, zoom, row, col);
			return "/custom/ng/tile.php?id=" + tileId;
		}
	};
})();
ZoomManager.addDezoomer(nationalgallery);
